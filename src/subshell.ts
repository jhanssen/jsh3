import { ReadProcess, Process, ProcessOptions, StatusResolveFunction, RejectFunction } from "./process";
import { Job } from "./job";
import { jobs } from "./jobs";
import { Readable, Writable, Duplex } from "stream";
import { pathify } from "./utils";
import { expand } from "./expand";
import { env as envGet, push as envPush, pop as envPop, EnvType } from "./variable";
import { declaredCommands, builtinCommands, CommandFunction } from "./commands";
import { parseRedirections } from "./redirs";
import { assert } from "./assert";
import { default as Readline } from "../native/readline";
import { default as Shell } from "../native/shell";
import { runInNewContext } from "vm";
import { format as consoleFormat } from "util";

type VoidFunction = () => void;

export interface CmdResult
{
    stdin: Writable | undefined;
    stdout: Readable | undefined;
    status: Promise<number | undefined>;
}

type GeneratorResolveFunction = (value: number | undefined | PromiseLike<number | undefined>) => void;

function runGeneratorCommand(command: CommandFunction, args: string[], env: EnvType, opts: ProcessOptions): CmdResult {
    let resolve: GeneratorResolveFunction | undefined;
    let reject: RejectFunction | undefined;
    const promise = new Promise<number | undefined>((newResolve, newReject) => {
        resolve = newResolve;
        reject = newReject;
    });
    assert(resolve !== undefined && reject !== undefined);

    let stdout = new ShellReader();
    if (!opts.redirectStdout) {
        stdout.pipe(process.stdout);
    }
    let stdin: ShellWriter | undefined;
    let stdinPipe: ShellReader | undefined;
    if (opts.redirectStdin) {
        stdin = new ShellWriter();
        stdinPipe = new ShellReader();
    }

    const generator = command(args, env, stdinPipe);

    if (stdin && stdinPipe) {
        (async () => {
            for await (const buf of stdin) {
                stdinPipe.write(buf);
            }
            stdinPipe.end();
        })();
    }

    (async () => {
        let status: number | undefined;
        try {
            for await (const item of generator) {
                switch (typeof item) {
                case "undefined":
                    continue;
                case "number":
                    status = item;
                    break;
                case "string":
                    if (status !== undefined) {
                        stdout.write(Buffer.from(status + "\n"));
                        status = undefined;
                    }
                    stdout.write(Buffer.from(item + "\n"));
                    break;
                case "object":
                    if (item instanceof Buffer) {
                        if (status !== undefined) {
                            stdout.write(Buffer.from(status + "\n"));
                            status = undefined;
                        }
                        stdout.write(item);
                    }
                    // fall through
                default:
                    if (status !== undefined) {
                        stdout.write(Buffer.from(status + "\n"));
                        status = undefined;
                    }
                    stdout.write(Buffer.from(item.toString()));
                    break;
                }
            }
        } catch (e) {
            stdout.end();
            reject(e);
            return;
        }
        stdout.end();
        resolve(status || 0);
    })();

    return {
        stdin: stdin,
        stdout: opts.redirectStdout ? stdout : undefined,
        status: promise
    };
}

export async function runCmd(cmds: any, source: string, opts: ProcessOptions, job?: Job): Promise<{ pid: number, result: CmdResult }> {
    envPush();

    try {
        const env = envGet();
        if (cmds.assignments !== undefined) {
            for (const a of cmds.assignments) {
                // key has to be a number or identifier
                const key = a.key.value.toString();
                const val = await expand(a.value, source);
                //console.log(`expanded ${key} to '${val}'`);
                env[key] = val;
            }
        }

        const ps = [];
        for (const id of cmds.cmd) {
            ps.push(expand(id, source));
        }

        const args = await Promise.all(ps);
        const cmd: string | undefined = args.shift();
        if (!cmd) {
            throw new Error(`No cmd`);
        }

        if (cmd in declaredCommands.commands) {
            const declared = declaredCommands.commands[cmd];
            return { pid: -1, result: runGeneratorCommand(declared, args, env, opts) };
        }
        if (cmd in builtinCommands) {
            const builtin = builtinCommands[cmd as keyof typeof builtinCommands];
            return { pid: -1, result: runGeneratorCommand(builtin, args, env, opts) };
        }

        if (job && !job.valid && job.foreground) {
            await Readline.pause();
        }

        const rcmd = await pathify(cmd);
        const proc = new Process(rcmd, args, env, opts, parseRedirections(cmds.redirs));

        if (job) {
            job.addProcess(proc);
        }

        envPop();

        return {
            pid: proc.pid,
            result: {
                stdin: opts.redirectStdin ? proc.stdin : undefined,
                stdout: opts.redirectStdout ? proc.stdout : undefined,
                status: proc.status
            }
        };
    } catch (e) {
        envPop();
        throw e;
    }
}

interface SubshellOptions
{
    readable?: ShellReader;
    writable?: ShellWriter;
    pgid?: number;
    foreground?: boolean;
}

class Pipe
{
    private _pipes: any;
    private _source: string;
    private _job: Job | undefined;
    private _opts: SubshellOptions;

    constructor(pipes: any, source: string, opts: SubshellOptions) {
        this._pipes = pipes;
        this._source = source;
        this._opts = opts;
    }

    async execute(): Promise<number | undefined> {
        // launch all processes, then pipe their inputs / outputs
        const all: CmdResult[] = [];
        const foreground = (typeof this._opts.foreground === "boolean") ? this._opts.foreground : true;
        this._job = new Job(foreground);
        jobs.add(this._job);

        this._job.on("finished", () => {
            if (this._job) {
                jobs.delete(this._job);
            }
        });

        // if we have an existing subshell readable, that should be the destination of our last entry in the pipe chain
        const finalDestination: Writable | undefined = this._opts.readable;
        // and if we have an existing subshell writable, that should feed into our first stdin
        let firstSource: Readable | undefined;
        if (this._opts.writable) {
            const owritable = this._opts.writable;
            // fucking typescript
            const ofirstSource = new ShellReader();
            firstSource = ofirstSource;
            owritable.on("data", buf => {
                ofirstSource.write(buf);
            });
            owritable.on("end", () => {
                ofirstSource.end();
                owritable.removeAllListeners();
            });
        }

        let source: Readable | undefined = firstSource;
        let pgid = this._opts.pgid;
        const pnum = this._pipes.length;
        for (let i = 0; i < pnum; ++i) {
            const p = this._pipes[i];
            switch (p.type) {
            case "cmd":
                const cmdr = await runCmd(p, this._source, {
                    redirectStdin: source !== undefined || i > 0,
                    redirectStdout : i < pnum - 1 || finalDestination !== undefined,
                    redirectStderr: false,
                    interactive: {
                        foreground: foreground,
                        pgid: pgid
                    }
                }, this._job);
                pgid = cmdr.pid;
                all.push(cmdr.result);
                break;
            case "subshell":
                let subopts: SubshellOptions = {};
                if (i < pnum - 1 || finalDestination !== undefined) {
                    subopts.readable = new ShellReader();
                }
                if (source !== undefined || i > 0) {
                    subopts.writable = new ShellWriter();
                }
                if (pgid !== undefined) {
                    subopts.pgid = pgid;
                }
                all.push({
                    stdout: subopts.readable,
                    stdin: subopts.writable,
                    status: subshell(p, this._source, subopts)
                });
                break;
            case "jscode":
                all.push(await runJS(p, this._source, {
                    redirectStdin: source !== undefined || i > 0,
                    redirectStdout: i < pnum - 1 || finalDestination !== undefined
                }));
                break;
            }
        }

        const promises: Promise<number | undefined>[] = [];
        const anum = all.length;
        for (let i = 0; i < anum; ++i) {
            const a = all[i];
            if (i === 0) {
                // pipe firstSource to stdin if it exists
                if (firstSource !== undefined) {
                    if (a.stdin === undefined) {
                        throw new Error("Have firstSource but no stdin");
                    }
                    firstSource.pipe(a.stdin);
                } else if (a.stdin !== undefined) {
                    throw new Error("No firstSource but have stdin");
                }
            }
            if (i < anum - 1) {
                // pipe previous to next
                const n = all[i + 1];
                if (a.stdout === undefined) {
                    throw new Error("No stdout");
                }
                if (n.stdin === undefined) {
                    throw new Error("No stdin");
                }
                a.stdout.pipe(n.stdin);
            } else if (i === anum - 1) {
                // at end
                if (finalDestination !== undefined) {
                    if (a.stdout === undefined) {
                        throw new Error("Have finalDestination but no stdout");
                    }
                    a.stdout.pipe(finalDestination);
                } else if (a.stdout !== undefined) {
                    throw new Error("No finalDestination but have stdout");
                }
            }
            promises.push(a.status);
        }

        const results = await Promise.all(promises);

        // resolve with the exit code of the last pipe entry
        return results[results.length - 1];
    }

    async finalize(): Promise<void> {
        if (this._job && this._job.valid && this._job.foreground) {
            Shell.restore();
            await Readline.resume();
        }
    }
}

class LogicalOperations
{
    private _logicals: any;
    private _source: string;
    private _opts: SubshellOptions;

    constructor(logicals: any, source: string, opts: SubshellOptions) {
        this._logicals = logicals;
        this._source = source;
        this._opts = opts;
    }

    [Symbol.asyncIterator]() {
        return {
            _idx: 0,
            _done: false,
            _source: this._source,
            _opts: this._opts,
            _logicals: this._logicals,
            next(): Promise<IteratorResult<number | undefined>> {
                if (this._done || this._idx >= this._logicals.length) {
                    return Promise.resolve({ done: true, value: undefined });
                } else {
                    return new Promise((resolve, reject) => {
                        const operator = (this._idx + 1 < this._logicals.length) ? this._logicals[this._idx + 1].value : undefined;
                        const operand = this._logicals[this._idx];
                        this._idx += 2;
                        if (operand.type === "pipe") {
                            pipe(operand, this._source, this._opts)
                                .then(val => {
                                    if (val === undefined) {
                                        resolve({ done: false, value: undefined });
                                        return;
                                    }
                                    if (val && operator === "&&")
                                        this._done = true;
                                    else if (!val && operator === "||")
                                        this._done = true;
                                    resolve({ done: false, value: val });
                                }).catch(reject);
                        } else if (operand.type === "subshell" || operand.type === "subshellOut") {
                            subshell(operand, this._source, this._opts)
                                .then(val => {
                                    if (val === undefined) {
                                        resolve({ done: false, value: undefined });
                                        return;
                                    }
                                    if (val && operator === "&&")
                                        this._done = true;
                                    else if (!val && operator === "||")
                                        this._done = true;
                                    resolve({ done: false, value: val });
                                }).catch(reject);
                        }
                    });
                }
            }
        }
    }
}

class CommandSeparators
{
    private _seps: any;
    private _source: string;
    private _opts: SubshellOptions;

    constructor(seps: any, source: string, opts: SubshellOptions) {
        this._seps = seps;
        this._source = source;
        this._opts = opts;
    }

    [Symbol.asyncIterator]() {
        return {
            _idx: 0,
            _seps: this._seps,
            _source: this._source,
            _opts: this._opts,
            next(): Promise<IteratorResult<number | undefined>> {
                if (this._idx >= this._seps.length) {
                    return Promise.resolve({ done: true, value: undefined });
                } else {
                    return new Promise((resolve, reject) => {
                        const item = this._seps[this._idx++];
                        if (item.type === "logical") {
                            logical(item, this._source, this._opts)
                                .then(val => { resolve({ done: false, value: val }); })
                                .catch(reject);
                        } else if (item.type === "subshell" || item.type === "subshellOut") {
                            subshell(item, this._source, this._opts)
                                .then(val => { resolve({ done: false, value: val }); })
                                .catch(reject);
                        } else {
                            throw new Error(`Invalid sep type ${item.type}`);
                        }
                    });
                }
            }
        }
    }
}

async function pipe(cmds: any, source: string, opts: SubshellOptions): Promise<number | undefined> {
    if (cmds.type !== "pipe") {
        throw new Error(`Invalid logical type ${cmds.type}`);
    }
    const pipes = new Pipe(cmds.pipe, source, opts);
    const data = await pipes.execute();
    await pipes.finalize();
    return data;
}

async function logical(cmds: any, source: string, opts: SubshellOptions): Promise<number | undefined> {
    if (cmds.type !== "logical") {
        throw new Error(`Invalid logical type ${cmds.type}`);
    }
    const logicals = new LogicalOperations(cmds.logical, source, opts);
    let rp: number | undefined = undefined;
    for await (const nrp of logicals) {
        if (nrp === undefined)
            continue;
        rp = nrp;
    }
    return rp;
}

async function subshell(cmds: any, source: string, opts: SubshellOptions): Promise<number | undefined> {
    let subopts: SubshellOptions | undefined;
    if (cmds.type === "subshell") {
        subopts = opts;
    } else if (cmds.type === "subshellOut") {
        subopts = {
            readable: new ShellReader(),
            writable: new ShellWriter()
        }
    } else {
        throw new Error(`Invalid subshell type: ${cmds.type}`);
    }
    if (cmds.subshell.type !== "sep") {
        throw new Error(`No sep inside of subshell`);
    }

    let rp: number | undefined = undefined;

    envPush();

    try {
        const seps = new CommandSeparators(cmds.subshell.sep, source, subopts);
        for await (const s of seps) {
            if (s === undefined)
                continue;
            rp = s;
        }
    } catch (e) {
        envPop();
        throw e;
    }

    envPop();

    return rp;
}

export interface SubshellResult {
    status: number | undefined;
    stdout: Buffer | undefined;
}

export async function runSubshell(cmds: any, source: string): Promise<SubshellResult> {
    let opts: SubshellOptions = {};
    let seps: CommandSeparators | undefined;

    const result: SubshellResult = {
        status: undefined,
        stdout: undefined
    };

    envPush();

    try {
        switch (cmds.type) {
            case "subshellOut":
                opts.readable = new ShellReader(),
                opts.writable = new ShellWriter();
                // fall through
            case "subshell":
                seps = new CommandSeparators(cmds.subshell.sep, source, opts);
                break;
        }

        if (seps === undefined) {
            throw new Error(`Invalid subshell type: ${cmds.type}`);
        }

        if (opts.writable) {
            opts.writable.end();
        }
        if (opts.readable) {
            const readable = opts.readable;
            readable.on("data", chunk => {
                if (result.stdout === undefined) {
                    result.stdout = chunk;
                } else {
                    result.stdout = Buffer.concat([result.stdout, chunk]);
                }
            });
            readable.on("end", () => {
                readable.removeAllListeners();
            });
        }

        for await (const s of seps) {
            if (s === undefined)
                continue;
            result.status = s;
        }
    } catch (e) {
        envPop();
        throw e;
    }

    envPop();

    return result;
}

export async function runSeparators(cmds: any, source: string): Promise<number | undefined> {
    if (cmds.type !== "sep") {
        throw new Error(`Invalid sep type ${cmds.type}`);
    }
    const seps = new CommandSeparators(cmds.sep, source, {});
    let rp: number | undefined = undefined;
    for await (const s of seps) {
        if (s === undefined)
            continue;
        rp = s;
    }
    return rp;
}

export { CmdResult as JSResult };

interface Global
{
    args: string[],
    runInNewContext: typeof runInNewContext | undefined,
    console: { log: typeof console.log, error: typeof console.error } | undefined
    stdout: Writable | undefined,
    stderr: Writable | undefined,
    stdin: Buffer | Readable | undefined
    resolve: StatusResolveFunction | undefined,
    reject: RejectFunction | undefined,
    env: EnvType,

    [key: string]: any;
}

interface JSOptions {
    redirectStdin: boolean;
    redirectStdout: boolean;
}

export async function runJS(js: any, source: string, opts: JSOptions): Promise<CmdResult> {
    const jscode = source.substr(js.start + 1, js.end - js.start - 1).replace(/"/g, '\\"').replace(/\\n/g, "\\\\n");
    let jswrap: string | undefined;
    let args: string[] | undefined;
    if (js.args instanceof Array) {
        const ps: Promise<string>[] = [];
        for (const arg of js.args) {
            ps.push(expand(arg, source));
        }
        args = await Promise.all(ps);
    }

    const ctx: Global = {
        args: args || [],
        runInNewContext: undefined,
        console: undefined,
        stdout: undefined,
        stderr: undefined,
        stdin: undefined,
        resolve: undefined,
        reject: undefined,
        env: envGet()
    };

    const blacklist = ["globalThis", "console", "GLOBAL", "global", "root"];
    const props = Object.getOwnPropertyNames(globalThis);
    for (const k of props) {
        if (!(k in ctx) && !blacklist.includes(k)) {
            ctx[k] = (globalThis as any)[k];
        }
    }

    const assignGlobal = `
        function assignGlobal(ctx) {
            const props = Object.getOwnPropertyNames(globalThis);
            for (const k of props) {
                if (!(k in ctx)) {
                    ctx[k] = globalThis[k];
                }
            }
        }`;

    let stdin: Writable | undefined;
    let stdout: Readable | undefined;
    let status: Promise<number | undefined> | undefined;

    switch (js.jstype) {
        case "return": {
            // the function is synchronous, whatever is console.logged goes to stdout
            // and if the function returns a non-integer value that also goes to stdout.
            // stdin is a buffer that contains all data from the previous process in the pipe chain (if any).
            // the exit code is the integral value returned or 0 if none.

            const jstdout = new ShellReader()

            ctx.runInNewContext = runInNewContext;
            ctx.console = {
                log: (...args) => {
                    const ret = consoleFormat(...args);
                    jstdout.write(ret + "\n");
                },
                error: console.error.bind(console)
            };
            ctx.stdout = new ShellWriter();
            ctx.stdout.on("data", buf => {
                jstdout.write(buf);
            });
            ctx.stdout.on("end", () => {
                (ctx.stdout as ShellWriter).removeAllListeners();
                jstdout.end();
            });

            if (opts.redirectStdout) {
                stdout = jstdout;
            } else {
                jstdout.pipe(process.stdout);
            }

            const jstdin = new ShellWriter();
            ctx.stdin = new ShellReader();

            (async function() {
                const ctxin = ctx.stdin as ShellReader;
                for await (const buf of jstdin) {
                    ctxin.write(buf);
                }
                ctxin.end();
            })();

            if (opts.redirectStdin) {
                stdin = jstdin;
            } else {
                jstdin.end();
            }

            status = new Promise<number | undefined>((resolve, reject) => {
                ctx.resolve = resolve;
                ctx.reject = reject;
            });

            // this is pretty weird
            jswrap = `
                (async function() {
                    let buf = undefined;
                    for await (const nbuf of stdin) {
                        if (buf === undefined) buf = nbuf;
                        else buf = Buffer.concat([buf, nbuf]);
                    }
                    ${assignGlobal}
                    const nctx = {
                        args: args,
                        env: env,
                        stdin: buf,
                        console: console
                    };
                    try {
                        const jscode = "${jscode}";
                        // console.log('jscode', jscode, nctx.stdin);
                        assignGlobal(nctx);
                        const ret = runInNewContext(jscode, nctx);
                        if (typeof ret === 'number') { resolve(ret); }
                        else { if (ret !== undefined) console.log(ret); resolve(0); }
                    } catch (e) {
                        reject(e);
                    }
                    stdout.end();
                })()`;
            break; }
        case "stream": {
            // the function is asynchronous, wrapped in a promise.
            // global stdin, stdout and stderr variables will be node streams.
            // in addition, console.log() will go to stdout and console.error() to stderr.
            // the function is considered complete when resolve(number) or reject(error) is called.

            const jstdout = new ShellReader()

            ctx.runInNewContext = runInNewContext;
            ctx.console = {
                log: (...args) => {
                    const ret = consoleFormat(...args);
                    jstdout.write(ret + "\n");
                },
                error: console.error.bind(console)
            };
            ctx.stdout = new ShellWriter();
            ctx.stdout.on("data", buf => {
                jstdout.write(buf);
            });
            ctx.stdout.on("end", () => {
                jstdout.end();
                (ctx.stdout as ShellWriter).removeAllListeners();
            });
            ctx.stderr = new ShellWriter();
            ctx.stderr.on("data", buf => {
                console.error(buf.toString());
            });
            ctx.stderr.on("end", () => {
                (ctx.stderr as ShellWriter).removeAllListeners();
            });

            if (opts.redirectStdout) {
                stdout = jstdout;
            } else {
                jstdout.pipe(process.stdout);
            }

            const jstdin = new ShellWriter();
            ctx.stdin = new ShellReader();

            (async function() {
                const ctxin = ctx.stdin as ShellReader;
                for await (const buf of jstdin) {
                    ctxin.write(buf);
                }
                ctxin.end();
            })();

            if (opts.redirectStdin) {
                stdin = jstdin;
            } else {
                jstdin.end();
            }

            status = new Promise<number | undefined>((resolve, reject) => {
                ctx.resolve = resolve;
                ctx.reject = reject;
            });

            jswrap = `
                (async function() {
                    const close = () => {
                        stdout.end();
                    };
                    ${assignGlobal}
                    try {
                        const jscode = "${jscode}";
                        const promise = new Promise((newResolve, newReject) => {
                            const nctx = {
                                args: args,
                                env: env,
                                stdin: stdin,
                                stdout: stdout,
                                stderr: stderr,
                                console: console,
                                resolve: newResolve,
                                reject: newReject
                            };
                            assignGlobal(nctx);
                            runInNewContext(jscode, nctx);
                        });
                        const status = await promise;
                        close();
                        resolve(typeof status === "number" ? status : 0);
                    } catch (err) {
                        close();
                        reject(err);
                    }
                })()`
            break; }
        case "iterable": {
            // the function is asynchronous, wrapped in an async generator.
            // global stdin is async iterable or can also be used with the on("data") and on("end")
            // listeners (but not both in the same function) and yielding a value will write to stdout.
            // the function is considered complete when the async generator throws or returns,
            // the final yielded value will be used as the exit code if it is integral, otherwise 0 is used

            const jstdout = new ShellReader()

            ctx.runInNewContext = runInNewContext;
            ctx.console = {
                log: (...args) => {
                    const ret = consoleFormat(...args);
                    jstdout.write(ret + "\n");
                },
                error: console.error.bind(console)
            };
            ctx.stdout = new ShellWriter();
            ctx.stdout.on("data", buf => {
                jstdout.write(buf);
            });
            ctx.stdout.on("end", () => {
                jstdout.end();
                (ctx.stdout as ShellWriter).removeAllListeners();
            });
            ctx.stderr = new ShellWriter();
            ctx.stderr.on("data", buf => {
                console.error(buf.toString());
            });
            ctx.stderr.on("end", () => {
                (ctx.stderr as ShellWriter).removeAllListeners();
            });

            if (opts.redirectStdout) {
                stdout = jstdout;
            } else {
                jstdout.pipe(process.stdout);
            }

            const jstdin = new ShellWriter();
            ctx.stdin = new ShellReader();

            (async function() {
                const ctxin = ctx.stdin as ShellReader;
                for await (const buf of jstdin) {
                    ctxin.write(buf);
                }
                ctxin.end();
            })();

            if (opts.redirectStdin) {
                stdin = jstdin;
            } else {
                jstdin.end();
            }

            status = new Promise<number | undefined>((resolve, reject) => {
                ctx.resolve = resolve;
                ctx.reject = reject;
            });

            jswrap = `
                (async function() {
                    const close = () => {
                        stdout.end();
                    };
                    ${assignGlobal}
                    try {
                        const jscode = "(async function* () { ${jscode} })()";
                        function sleep(ms) {
                            return new Promise(resolve => setTimeout(resolve, ms));
                        }
                        const nctx = {
                            args: args,
                            env: env,
                            stdin: stdin,
                            stdout: stdout,
                            stderr: stderr,
                            sleep: sleep,
                            console: console
                        };
                        assignGlobal(nctx);
                        const generator = runInNewContext(jscode, nctx);
                        let status = undefined;
                        const writeStatus = () => {
                            if (status !== undefined) {
                                stdout.write(status + "\\n");
                                status = undefined;
                            }
                        };
                        for await (const out of generator) {
                            switch (typeof out) {
                            case "string":
                                writeStatus();
                                stdout.write(out + "\\n");
                                break;
                            case "number":
                                writeStatus();
                                status = out;
                                break;
                            case "object":
                                if (out instanceof Buffer) {
                                    writeStatus();
                                    stdout.write(out);
                                    break;
                                }
                                // fall through
                            default:
                                writeStatus();
                                stdout.write(out.toString());
                                break;
                            }
                        }
                        close();
                        resolve(status || 0);
                    } catch (err) {
                        close();
                        reject(err);
                    }
                })()`;
            break; }
        default:
            break;
    }

    if (jswrap === undefined || status === undefined) {
        throw new Error("Unable to wrap JS code");
    }

    try {
        runInNewContext(jswrap, ctx);
    } catch (e) {
        console.error("JS error", e);
    }

    return {
        stdin: stdin,
        stdout: stdout,
        status: status
    };
}

type WriteCallbackFunction = (err: any) => void;

class ShellReader extends Duplex
{
    private _paused: boolean;
    private _buffers: { buf: Buffer | null, callback: WriteCallbackFunction | VoidFunction }[];

    constructor() {
        super();

        this._paused = true;
        this._buffers = [];
    }

    _read(size: number) {
        for (let i = 0; i < this._buffers.length; ++i) {
            const data = this._buffers[i];
            this._callCallback(data);
            if (!this.push(data.buf)) {
                // we got so far
                this._buffers.splice(0, i + 1);
                return;
            }
        }
        this._buffers = [];
        this._paused = false;
    }

    _write(buf: Buffer, encoding: string, callback: WriteCallbackFunction) {
        if (this._paused) {
            this._buffers.push({ buf: buf, callback: callback });
        } else {
            if (!this.push(buf)) {
                this._paused = true;
            }
            callback(null);
        }
    }

    _final(callback: VoidFunction) {
        if (this._paused) {
            this._buffers.push({ buf: null, callback: callback });
        } else {
            this.push(null);
            callback();
        }
    }

    _callCallback(data: { buf: Buffer | null, callback: WriteCallbackFunction | VoidFunction }) {
        if (data.buf === null) {
            (data.callback as VoidFunction)();
        } else {
            (data.callback as WriteCallbackFunction)(null);
        }
    }
}

type WriteResolveFunction = (value?: IteratorResult<Buffer | undefined> | PromiseLike<IteratorResult<Buffer | undefined>>) => void;

class ShellWriter extends Writable
{
    private _buffers: { buf: Buffer, callback: WriteCallbackFunction }[];
    private _finalcb: { callback: VoidFunction | undefined };
    private _resolver: { resolver: WriteResolveFunction | undefined };
    private _started: boolean;
    private _emitting: boolean;

    constructor() {
        super();

        this._emitting = false;
        this._started = false;
        this._buffers = [];
        this._finalcb = { callback: undefined };
        this._resolver = { resolver: undefined };

        this.once("newListener", event => {
            if (event === "data") {
                if (this._started) {
                    throw new Error("Can only have on data listener / iterate once for a given stream");
                }
                this._started = true;

                process.nextTick(() => {
                    this._emitting = true;
                    for (const buf of this._buffers) {
                        buf.callback(null);
                        this.emit("data", buf.buf);
                    }
                    this._buffers = [];
                    if (this._finalcb.callback) {
                        this._finalcb.callback();
                        this.emit("end");
                        this._finalcb.callback = undefined;
                    }
                });
            }
        });
    }

    [Symbol.asyncIterator]() {
        if (this._started) {
            throw new Error("Can only have on data listener / iterate once for a given stream");
        }
        this._started = true;

        return {
            _buffers: this._buffers,
            _finalcb: this._finalcb,
            _resolver: this._resolver,
            next(): Promise<IteratorResult<Buffer | undefined>> {
                return new Promise((resolve, reject) => {
                    if (this._buffers.length > 0) {
                        const buf = this._buffers.shift();
                        if (buf === undefined) {
                            throw new Error("Can't happen");
                        }
                        buf.callback(null);
                        resolve({ done: false, value: buf.buf });
                    } else if (this._finalcb.callback) {
                        this._finalcb.callback();
                        this._finalcb.callback = undefined;
                        resolve({ done: true, value: undefined });
                    } else {
                        this._resolver.resolver = resolve;
                    }
                });
            }
        }
    }

    _write(buf: Buffer, encoding: string, callback: (err: any) => void) {
        if (this._emitting) {
            callback(null);
            this.emit("data", buf);
        } else if (this._resolver.resolver) {
            callback(null);
            this._resolver.resolver({ done: false, value: buf });
            this._resolver.resolver = undefined;
        } else {
            this._buffers.push({ buf: buf, callback: callback });
        }
    }

    _final(callback: VoidFunction) {
        if (this._emitting) {
            callback();
            this.emit("end");
        } else if (this._resolver.resolver) {
            callback();
            this._resolver.resolver({ done: true, value: undefined });
            this._resolver.resolver = undefined;
        } else {
            this._finalcb.callback = callback;
        }
    }
}
