import * as nearley from "nearley"
import { jsh3_grammar } from "./parser"
import { default as Readline, Data as ReadlineData, Completion as ReadlineCompletion } from "../native/readline";
import { default as Process } from "../native/process";
import { join as pathJoin } from "path";
import { stat } from "fs";
import { homedir } from "os";

const jsh3Parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));

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

interface ProcessComplete {
    status: number;
    stdout: Buffer;
    stderr: Buffer | undefined;
};

function runProcessToCompletion(args: string[]): Promise<ProcessComplete> {
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
                const p = Process.launch(acmd, args);
                const out: ProcessComplete = {
                    status: 0,
                    stdout: Buffer.alloc(0),
                    stderr: undefined,
                };
                p.promise.then(status => {
                    out.status = status;
                    resolve(out);
                }).catch(e => {
                    reject(e);
                });
                if (p.stdinCtx) {
                    p.close(p.stdinCtx);
                }
                if (p.stdoutCtx) {
                    p.listen(p.stdoutCtx, (buf: Buffer) => {
                        out.stdout = Buffer.concat([out.stdout, buf]);
                    });
                }
                if (p.stderrCtx) {
                    p.listen(p.stderrCtx, (buf: Buffer) => {
                        if (out.stderr === undefined) {
                            out.stderr = buf;
                        } else {
                            out.stderr = Buffer.concat([out.stderr, buf]);
                        }
                    });
                }
            }).catch(e => { reject(e); });
        });
    });
}

function expandVariable(value: any) {
    return env[value.value] || "";
}

function expandCmd(value: any): Promise<string> {
    return new Promise((resolve, reject) => {
        const ps = [];
        for (const id of value.cmd) {
            ps.push(expand(id));
        }
        Promise.all(ps).then(args => {
            runProcessToCompletion(args).then(out => {
                resolve(out.stdout.toString());
            });
        }).catch(e => { reject(e); });
    });
}

function expand(value: any): Promise<string> {
    return new Promise((resolve, reject) => {
        if (typeof value === "object" && "type" in value) {
            if (value.type === "variable") {
                resolve(expandVariable(value));
            } else if (value.type === "cmd") {
                resolve(expandCmd(value));
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

function visitCmd(node: any) {
    const ps = [];
    for (const id of node.cmd) {
        ps.push(expand(id));
    }
    Promise.all(ps).then(args => {
        //console.log("cmmmmd", args);
        const cmd = args.shift();
        if (!cmd)
            return;
        handleInternalCmd(cmd, args).then(arg => {
            console.log((arg && arg.toString()) || "");
        }).catch(() => {
            pathify(cmd).then(acmd => {
                const p = Process.launch(acmd, args);
                p.promise.then(status => {
                    console.log("status", status);
                }).catch(e => {
                    console.error("failed to launch", e);
                });
                if (p.stdinCtx) {
                    p.close(p.stdinCtx);
                }
                if (p.stdoutCtx) {
                    p.listen(p.stdoutCtx, (buf: Buffer) => {
                        console.log("out", buf.toString());
                    });
                }
                if (p.stderrCtx) {
                    p.listen(p.stderrCtx, (buf: Buffer) => {
                        console.log("err", buf.toString());
                    });
                }
            }).catch(e => {
                console.error(e);
            });
        });
    }).catch(e => {
        console.error(e);
    });
    //console.log(args);
    return true;
}

function visitIf(node: any) {
    visit(node.if);
    if (node.elif) {
        visit(node.elif);
    }
    if (node.else) {
        visit(node.else);
    }
    return true;
}

function visit(node: any) {
    if (node instanceof Array) {
        for (const item of node) {
            visit(item);
        }
        return;
    }

    switch (node.type) {
    case "cmd":
        if (visitCmd(node))
            return;
        break;
    case "if":
        if (visitIf(node))
            return;
        break;
    }

    const data = node[node.type];
    if (data instanceof Array) {
        for (const item of data) {
            visit(item);
        }
    }
}

function processLines(lines: string[] | undefined) {
    if (!lines)
        return;

    const promises: Promise<void>[] = [];
    for (const line of lines) {
        promises.push(Readline.addHistory(line, true));

        const parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));
        parser.feed(line);
        if (parser.results) {
            visit(parser.results);
        }
    }
    Promise.all(promises).then(() => {
        console.log("added history");
    });
}

function processCompletion(data: ReadlineCompletion | undefined) {
    if (!data)
        return;

    //console.log("want to complete", data);
    data.complete(["faff"]);
}

function processReadline(data: ReadlineData) {
    switch (data.type) {
    case "lines":
        processLines(data.lines);
        break;
    case "completion":
        processCompletion(data.completion);
        break;
    }
}

Readline.start(processReadline);
Readline.readHistory(pathJoin(homedir(), ".jsh_history")).then(() => {
    console.log("history loaded", pathJoin(homedir(), ".jsh_history"));
});
Process.start();

process.on('SIGINT', () => {
    Readline.clear();
});

process.on('uncaughtException', err => {
    Readline.log.error(err);
});
