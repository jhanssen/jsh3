import * as nearley from "nearley"
import { jsh3_grammar } from "./parser"
import { default as Readline, Data as ReadlineData, Completion as ReadlineCompletion } from "../native/readline";
import { default as Shell } from "../native/shell";
import { default as Process } from "../native/process";
import { complete, cache as completionCache } from "./completion";
import { readProcess, ReadProcess } from "./process";
import { runSeparators, runSubshell, runCmd, runJS, SubshellResult, CmdResult } from "./subshell";
import { EnvType, top as envTop } from "./variable";
import { API } from "./api";
import { assert } from "./assert";
import { declaredCommands, DeclaredFunction } from "./commands";
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

enum RunMode { RunNormal, RunCapture };
type RunResult = number | SubshellResult | undefined;

async function runSepNode(node: any, line: string, mode: RunMode) {
    let data: RunResult;
    if (mode === RunMode.RunNormal) {
        await Readline.pause();
        try {
            data = await runSeparators(node, line);
        } catch (e) {
            console.error(e);
        }
        Shell.restore();
        await Readline.resume();
    } else {
        try {
            data = await runSubshell(node, line);
        } catch (e) {
            console.error(e);
        }
    }
    return data;
}

async function runConditionCommand(node: any, line: string, mode: RunMode): Promise<number | undefined> {
    const redirectStdout = mode === RunMode.RunCapture;
    switch (node.type) {
    case "cmd": {
        const data = await runCmd(node, line, { redirectStdin: false, redirectStdout: redirectStdout, redirectStderr: false, interactive: undefined });
        return await data.result.status; }
    case "jscode": {
        const data = await runJS(node, line, { redirectStdin: false, redirectStdout: redirectStdout });
        return await data.status; }
    case "subshell":
    case "subshellOut": {
        const data = await runSubshell(node, line);
        return await data.status };
    default:
        throw new Error(`Can't run command of type ${node.type}`);
    }
}

async function runCommand(node: any, line: string, mode: RunMode): Promise<RunResult> {
    const redirectStdout = mode === RunMode.RunCapture;

    const createReturnValue = async (data: CmdResult | SubshellResult) => {
        if (redirectStdout) {
            const bufs: Buffer[] = [];
            if (data.stdout) {
                if (data.stdout instanceof Buffer) {
                    bufs.push(data.stdout);
                } else {
                    for await (const buf of data.stdout) {
                        bufs.push(buf);
                    }
                }
            }
            return {
                stdout: bufs.length === 0 ? undefined : Buffer.concat(bufs),
                status: await data.status
            } as SubshellResult;
        }
        return await data.status;
    }

    switch (node.type) {
    case "cmd": {
        const data = await runCmd(node, line, { redirectStdin: false, redirectStdout: redirectStdout, redirectStderr: false, interactive: undefined });
        return await createReturnValue(data.result); }
    case "jscode": {
        const data = await runJS(node, line, { redirectStdin: false, redirectStdout: redirectStdout });
        return await createReturnValue(data); }
    case "subshell":
    case "subshellOut": {
        const data = await runSubshell(node, line);
        return await createReturnValue(data); }
    default:
        throw new Error(`Can't run command of type ${node.type}`);
    }
}

async function runCommands(node: any, line: string, mode: RunMode): Promise<RunResult> {
    const redirectStdout = mode === RunMode.RunCapture;

    let data: RunResult;
    const bufs: Buffer[] = [];
    if (redirectStdout) {
        data = {
            status: undefined,
            stdout: undefined
        };
    }

    for (let i = 0; i < node.length; ++i) {
        const subresult = await runCommand(node[i], line, mode);
        if (redirectStdout) {
            assert(typeof data === "object");
            assert(typeof subresult === "object");
            data.status = subresult.status;
            if (subresult.stdout) {
                bufs.push(subresult.stdout);
            }
        } else {
            assert(typeof subresult !== "object");
            data = subresult;
        }
    }

    if (redirectStdout && bufs.length > 0) {
        assert(typeof data === "object");
        data.stdout = Buffer.concat(bufs);
    }

    return data;
}

async function runCondition(node: any, line: string, mode: RunMode): Promise<boolean> {
    if (node.type !== "condition") {
        throw new Error(`Condition is not of type condition: ${node.type}`);
    }

    const trueish = (status: number | undefined) => {
        return status === 0;
    };

    const cond = node.condition;
    // cond is an array, first node is the first condition.
    // if there are more elements of the array then the elements are objects with an operator and condition property
    let status = await runConditionCommand(cond[0], line, mode);
    let ret = trueish(status);
    if (cond.length === 1) {
        return ret;
    }
    // these execute in left to right order, meaning
    // 1. (true || false && true) returns true (and doesn't execute anything beyond the || operator
    // 2. (false && true || true) returns false (and doesn't execute anything beyond the || operator
    for (let i = 1; i < cond.length; ++i) {
        switch (cond[i].operator) {
        case "and":
            if (ret === false)
                return ret;
            status = await runConditionCommand(cond[i].condition, line, mode);
            ret = trueish(status);
            if (ret === false)
                return ret;
            break;
        case "or":
            if (ret === true)
                return ret;
            status = await runConditionCommand(cond[i].condition, line, mode);
            ret = trueish(status);
            if (ret === true)
                return ret;
            break;
        default:
            throw new Error(`Invalid operator ${cond[i].operator}`);
        }
    }
    return ret;
}

async function runIfNode(node: any, line: string, mode: RunMode): Promise<RunResult> {
    const ifnode = node.if;
    let done = false;

    let status = await runCondition(ifnode[0], line, mode);
    if (status === true) {
        return await runCommands(ifnode[1], line, mode);
    }
    if (node.elif !== undefined) {
        const elifnode = node.elif;
        for (let i = 0; i < elifnode.length; i += 2) {
            status = await runCondition(elifnode[i], line, mode);
            if (status === true) {
                return await runCommands(elifnode[i + 1], line, mode);
            }
        }
    }
    if (node.else !== undefined) {
        return await runCommands(node.else, line, mode);
    }
    return undefined;
}

async function runASTNode(node: any, line: string, mode: RunMode): Promise<RunResult> {
    if (node instanceof Array) {
        for (const item of node) {
            runASTNode(item, line, mode);
        }
        return;
    }

    let result: RunResult;
    if (mode === RunMode.RunCapture) {
        result = {
            status: undefined,
            stdout: undefined
        } as SubshellResult;
    }

    const append = (newresult: RunResult) => {
        if (newresult === undefined)
            return;
        if (mode === RunMode.RunCapture) {
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
        declare: (name: string, func?: DeclaredFunction): void => {
            if (func === undefined) {
                declaredCommands.remove(name);
            } else {
                declaredCommands.add(name, func)
            }
        },
        export: (name: string, value: string | undefined): void => {
            envTop()[name] = value;
        },
        run: async (cmdline: string): Promise<SubshellResult> => {
            const parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));
            parser.feed(cmdline);
            if (parser.results) {
                const data = await runASTNode(parser.results, cmdline, RunMode.RunCapture);
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
