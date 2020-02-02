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
            assert(typeof newresult !== "number");
            result.status = newresult.status;
            if (result.stdout === undefined) {
                result.stdout = newresult.stdout;
            } else if (newresult.stdout !== undefined) {
                result.stdout = Buffer.concat([result.stdout, newresult.stdout]);
            }
        } else {
            assert(typeof newresult === "number");
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
    assert(configDir !== undefined);
    const api = {
        declare: (name: string, func: (args: string[], env: EnvType) => Promise<number | undefined>): void => {
        },
        export: (name: string, value: string | undefined): void => {
            envTop()[name] = value;
        },
        run: async (cmdline: string): Promise<SubshellResult> => {
            const parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));
            parser.feed(cmdline);
            if (parser.results) {
                const data = await runASTNode(parser.results, cmdline, RunMode.RunSubshell);
                if (data !== undefined) {
                    assert(typeof data !== "number");
                    return data;
                }
            }
            return {
                status: undefined,
                stdout: undefined
            };
        },
        setPrompt: async (prompt: string): Promise<void> => {
            return Readline.setPrompt(prompt);
        }
    };
    await loadConfig(configDir, api);
})();
