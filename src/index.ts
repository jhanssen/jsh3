import * as nearley from "nearley"
import { jsh3_grammar } from "./parser"
import { default as Readline, Data as ReadlineData, Completion as ReadlineCompletion } from "../native/readline";
import { default as Shell } from "../native/shell";
import { default as Process } from "../native/process";
import { complete, cache as completionCache } from "./completion";
import { readProcess, ReadProcess } from "./process";
import { runSeparators, runSubshell, runCmd, runJS, SubshellResult } from "./subshell";
import { EnvType, top as envTop } from "./variable";
import { API } from "./api";
import { assert } from "./assert";
import { join as pathJoin } from "path";
import { stat } from "fs";
import { homedir } from "os";
import { runInNewContext } from "vm";
import { default as Options } from "@jhanssen/options";
import * as xdgBaseDir from "xdg-basedir";

const jsh3Parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));

const options = Options("jsh");

function stringOption(key: string): string | undefined
{
    const value = options(key);
    if (typeof value === "string") {
        return value;
    }
    return undefined;
}

async function loadConfig(dir: string, api: API)
{
    try {
        const cfg = await import(pathJoin(dir, "jsh"));
        cfg.default(api, options);
    } catch (err) {
        if (err.code !== "MODULE_NOT_FOUND") {
            throw err;
        }
    }
}

const configDir = stringOption("config") || xdgBaseDir.config;
if (configDir === undefined) {
    console.error("no config dir");
    process.exit();
}

//jsh3Parser.feed("./hello world { return `${foobar}`; } | grep 'ting'");
//jsh3Parser.feed("./hello \"world \\\"f\" 'trilli' | foo bar baz { 'foo!%&\\'bar' }");
//jsh3Parser.feed("./hello foo bar 3 'f'2> &1 > f < hey");
//jsh3Parser.feed("./hello && trall; semmm | foo > &1 | bar &!");
//jsh3Parser.feed("./hello foo");
//jsh3Parser.feed("./hello 1 2 | foo 3 4");
//console.log(JSON.stringify(jsh3Parser.results, null, 4));

const uid = Process.uid();
const gids = Process.gids();
const env: {[key: string]: string | undefined} = Object.assign({}, process.env);

function handlePauseRl(cmd: string, args: string[]) {
    const timeout = (args.length > 0 && parseInt(args[0])) || 0;
    if (!timeout) {
        console.log("no timeout");
        return;
    }
    console.log("pausing");
    return new Promise((resolve, reject) => {
        Readline.pause().then(() => {
            setTimeout(() => {
                Readline.resume().then(() => {
                    console.log("resuming");
                    resolve();
                });
            }, timeout);
            setTimeout(() => {
                Readline.setPrompt("hello> ");
            }, timeout * 2);
        }).catch(e => {
            reject(e);
        });
    });
}

function runProcessToCompletion(args: string[]): Promise<ReadProcess> {
    return new Promise((resolve, reject) => {
        const cmd = args.shift();
        if (!cmd) {
            reject("No command");
            return;
        }
        handleInternalCmd(cmd, args).then(arg => {
            resolve({ status: 0, stdout: arg || Buffer.alloc(0), stderr: undefined });
        }).catch(() => {
            pathify(cmd).then(acmd => {
                readProcess(acmd, args).then(out => {
                    resolve(out);
                }).catch(e => {
                    reject(e);
                });
            }).catch(e => { reject(e); });
        });
    });
}

function expandVariable(value: any) {
    return env[value.value] || "";
}

function expandCmdStdout(value: any): Promise<string> {
    return new Promise((resolve, reject) => {
        const ps = [];
        for (const id of value.cmd) {
            ps.push(expand(id));
        }
        Promise.all(ps).then(args => {
            runProcessToCompletion(args).then(out => {
                resolve((out.stdout || "").toString().trimEnd());
            });
        }).catch(e => { reject(e); });
    });
}

function expandCmdStatus(value: any): Promise<string> {
    return new Promise((resolve, reject) => {
        const ps = [];
        for (const id of value.cmd) {
            ps.push(expand(id));
        }
        Promise.all(ps).then(args => {
            runProcessToCompletion(args).then(out => {
                resolve((out.status || -1).toString());
            });
        }).catch(e => { reject(e); });
    });
}

function expand(value: any): Promise<string> {
    return new Promise((resolve, reject) => {
        if (typeof value === "object" && "type" in value) {
            if (value.type === "variable") {
                resolve(expandVariable(value));
            } else if (value.type === "subshell" || value.type === "subshellOut") {
                //resolve(subshell(value));
                resolve(value);
            } else if (value.value !== undefined) {
                resolve(value.value.toString());
            } else {
                resolve(value);
            }
        }
        if (value instanceof Array) {
            const ps = [];
            for (const sub of value) {
                ps.push(expand(sub));
            }
            Promise.all(ps).then(results => { resolve(results.join("")); }).catch(e => { reject(e); });
        } else {
            resolve(value);
        }
    });
}

function handleInternalCmd(cmd: string, args: string[]): Promise<Buffer | undefined> {
    return new Promise((resolve, reject) => {
        switch (cmd) {
        case "pauserl":
            handlePauseRl(cmd, args);
            resolve();
            break;
        case "exit":
            Process.stop();
            Readline.stop();
            process.exit();
            resolve();
            break;
        case "export":
            if (args.length < 2) {
                resolve(Buffer.from("export needs at least two arguments"));
                return true;
            }
            env[args[0]] = args[1];
            resolve();
            break;
        default:
            reject();
            break;
        }
    });
}

function pathify(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        if (cmd.includes("/")) {
            resolve(cmd);
            return;
        }
        const paths = (env.PATH || "").split(":");

        let num = 0;
        const reject1 = () => {
            if (++num === paths.length) {
                reject(`File not found ${cmd}`);
            }
        };

        for (const p of paths) {
            // should maybe do these sequentially in order to avoid races
            const j = pathJoin(p, cmd);
            stat(j, (err, stats) => {
                if (err || !stats) {
                    reject1();
                    return;
                }
                if (stats.isFile()) {
                    if ((uid === stats.uid && stats.mode & 0o500)
                        || (gids.includes(stats.gid) && stats.mode & 0o050)
                        || (stats.mode & 0o005)) {
                        resolve(j);
                    } else {
                        reject1();
                    }
                } else {
                    reject1();
                }
            });
        }
    });
}

// function visitCmd(node: any) {
//     const ps = [];
//     for (const id of node.cmd) {
//         ps.push(expand(id));
//     }
//     Promise.all(ps).then(args => {
//         //console.log("cmmmmd", args);
//         const cmd = args.shift();
//         if (!cmd)
//             return;
//         handleInternalCmd(cmd, args).then(arg => {
//             console.log((arg && arg.toString()) || "");
//         }).catch(() => {
//             pathify(cmd).then(acmd => {
//                 readProcess(acmd, args).then(out => {
//                     console.log((out.stdout || "").toString());
//                 }).catch(e => {
//                     console.error(e);
//                 });
//             }).catch(e => {
//                 console.error(e);
//             });
//         });
//     }).catch(e => {
//         console.error(e);
//     });
//     //console.log(args);
//     return true;
// }

// function visitIf(node: any, line: string) {
//     visit(node.if, line);
//     if (node.elif) {
//         visit(node.elif, line);
//     }
//     if (node.else) {
//         visit(node.else, line);
//     }
//     return true;
// }

// function runJS(code: string, args?: string[]) {
//     const ctx = {
//         args: args || []
//     };
//     return runInNewContext(code, ctx);
// }

// function visitJS(node: any, line: string) {
//     const jscode = line.substr(node.start + 1, node.end - node.start - 1);
//     // resolve arguments if any
//     if (node.args instanceof Array) {
//         const ps: Promise<string>[] = [];
//         for (const arg of node.args) {
//             ps.push(expand(arg));
//         }
//         Promise.all(ps).then(args => {
//             const r = runJS(jscode, args);
//             console.log(r);
//         }).catch(e => {
//             console.error(e);
//         });
//     } else {
//         const r = runJS(jscode);
//         console.log(r);
//     }
// }

// function visitSep(node: any, line: string) {
//     Readline.pause().then(() => {
//         runSeparators(node, line).then(arg => {
//             Shell.restore();
//             Readline.resume().then(() => {
//                 console.log("done sep", arg);
//             });
//         }).catch(e => {
//             Shell.restore();
//             Readline.resume().then(() => {
//                 console.error(e);
//             });
//         });
//     });
// }

enum RunMode { RunNormal, RunSubshell };
type RunResult = number | SubshellResult | undefined;

async function runSepNode(node: any, line: string, mode: RunMode) {
    let data: RunResult;
    if (mode === RunMode.RunNormal) {
        await Readline.pause();
        data = await runSeparators(node, line);
        Shell.restore();
        await Readline.resume();
    } else {
        data = await runSubshell(node, line);
    }
    return data;
}

async function runIfNode(node: any, line: string, mode: RunMode): Promise<RunResult> {
    return undefined;
}

async function runCmdNode(node: any, line: string, mode: RunMode): Promise<RunResult> {
    return undefined;
}

async function runJSNode(node: any, line: string, mode: RunMode): Promise<RunResult> {
    if (mode === RunMode.RunNormal) {
        const data = await runJS(node, line, { redirectStdin: false, redirectStdout: false });
        return await data.promise;
    } else {
        const data = await runJS(node, line, { redirectStdin: false, redirectStdout: true });
        const bufs = [];
        if (data.stdout !== undefined) {
            for await (const buf of data.stdout) {
                bufs.push(buf);
            }
        }
        const status = await data.promise;
        return {
            status: status,
            stdout: Buffer.concat(bufs)
        } as SubshellResult;
    }
}

async function runASTNode(node: any, line: string, mode: RunMode): Promise<RunResult> {
    if (node instanceof Array) {
        for (const item of node) {
            runASTNode(item, line, mode);
        }
        return;
    }

    let result: RunResult;
    if (mode === RunMode.RunSubshell) {
        result = {
            status: undefined,
            stdout: undefined
        } as SubshellResult;
    }

    const append = (newresult: RunResult) => {
        if (newresult === undefined)
            return;
        if (mode === RunMode.RunSubshell) {
            assert(typeof result === "object");
            if (typeof newresult === "number")
                throw new Error(`Got number result for RunSubshell`);
            result.status = newresult.status;
            if (result.stdout === undefined) {
                result.stdout = newresult.stdout;
            } else if (newresult.stdout !== undefined) {
                result.stdout = Buffer.concat([result.stdout, newresult.stdout]);
            }
        } else {
            if (typeof newresult !== "number")
                throw new Error(`Got non-number result for RunNormal`);
            result = newresult;
        }
    };

    switch (node.type) {
    case "sep":
        append(await runSepNode(node, line, mode));
        break;
    case "if":
        append(await runIfNode(node, line, mode));
        break;
    case "cmd":
        append(await runCmdNode(node, line, mode));
        break;
    case "jscode":
        append(await runJSNode(node, line, mode));
        break;
    default:
        throw new Error(`Unknown AST type ${node.type}`);
    }
}

// function visit(node: any, line: string) {
//     if (node instanceof Array) {
//         for (const item of node) {
//             visit(item, line);
//         }
//         return;
//     }

//     switch (node.type) {
//     case "sep":
//         visitSep(node, line);
//         return;
//     case "cmd":
//         if (visitCmd(node))
//             return;
//         break;
//     case "jscode":
//         visitJS(node, line);
//         return;
//     case "if":
//         if (visitIf(node, line))
//             return;
//         break;
//     }

//     const data = node[node.type];
//     if (data instanceof Array) {
//         for (const item of data) {
//             visit(item, line);
//         }
//     }
// }

function processLines(lines: string[] | undefined) {
    if (!lines)
        return;

    const promises: Promise<void>[] = [];
    for (const line of lines) {
        promises.push(Readline.addHistory(line, true));

        const parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));
        parser.feed(line);
        if (parser.results) {
            console.log("whey", JSON.stringify(parser.results, null, 4));
            runASTNode(parser.results, line, RunMode.RunNormal);
        }
    }
    Promise.all(promises).then(() => {
        console.log("added history");
    });
}

function processCompletion(data: ReadlineCompletion | undefined) {
    if (data === undefined)
        return;

    //console.log("want to complete", data);
    //data.complete(["faff"]);
    complete(data);
}

function processReadline(data: ReadlineData) {
    switch (data.type) {
    case "lines":
        completionCache.clear();
        processLines(data.lines);
        break;
    case "completion":
        processCompletion(data.completion);
        break;
    }
}

Shell.start();

Readline.start(processReadline);
Readline.readHistory(pathJoin(homedir(), ".jsh_history")).then(() => {
    console.log("history loaded", pathJoin(homedir(), ".jsh_history"));
});
Process.start();

process.on("SIGINT", () => {
    completionCache.clear();
    Readline.clear();
});

process.on("uncaughtException", err => {
    console.error("Uncaught exception", err);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled rejection at", promise, "reason", reason);
});

(async function() {
    if (configDir !== undefined) {
        const api = {
            declare: (name: string, func: (args: string[], env: EnvType) => Promise<number | undefined>): void => {
            },
            export: (name: string, value: string | undefined): void => {
                envTop()[name] = value;
            },
            run: async (cmdline: string): Promise<SubshellResult> => {
                return {
                    status: undefined,
                    stdout: undefined
                };
            }
        };
        await loadConfig(configDir, api);
    }
})();
