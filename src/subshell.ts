import { ReadProcess, Process, ProcessOptions } from "./process";
import { Readable, Writable, Duplex } from "stream";
import { Streamable } from "./streamable";
import { pathify } from "./utils";
import { expand } from "./expand";
import { env as envGet, push as envPush, pop as envPop } from "./variable";
import { commands as internalCommands } from "./commands";

interface CmdResult
{
    stdin: Writable | undefined;
    stdout: Readable | undefined;
    promise: Promise<number | undefined>;
}

async function runCmd(cmds: any, opts: ProcessOptions): Promise<CmdResult> {
    envPush();

    try {
        const env = envGet();
        if (cmds.assignments !== undefined) {
            for (const a of cmds.assignments) {
                // key has to be a number or identifier
                const key = a.key.value.toString();
                const val = await expand(a.value);
                //console.log(`expanded ${key} to '${val}'`);
                env[key] = val;
            }
        }

        const ps = [];
        for (const id of cmds.cmd) {
            ps.push(expand(id));
        }

        const args = await Promise.all(ps);
        const cmd: string | undefined = args.shift();
        if (!cmd) {
            throw new Error(`No cmd`);
        }

        if (cmd in internalCommands) {
            const internalCmd = internalCommands[cmd as keyof typeof internalCommands];
            return {
                stdin: undefined,
                stdout: undefined,
                promise: internalCmd(args, env)
            };
        }

        const rcmd = await pathify(cmd);
        const proc = new Process(rcmd, args, env, opts);

        envPop();

        return {
            stdin: opts.redirectStdin ? proc.stdin : undefined,
            stdout: opts.redirectStdout ? proc.stdout : undefined,
            promise: proc.status
        };
    } catch (e) {
        envPop();
        throw e;
    }
}

interface SubshellOptions
{
    readable?: SubshellReader;
    writable?: SubshellWriter;
}

class Pipe
{
    private _pipes: any;
    private _opts: SubshellOptions;

    constructor(pipes: any, opts: SubshellOptions) {
        this._pipes = pipes;
        this._opts = opts;
    }

    async execute(): Promise<number | undefined> {
        // launch all processes, then pipe their inputs / outputs
        const all: CmdResult[] = [];

        // if we have an existing subshell readable, that should be the destination of our last entry in the pipe chain
        const finalDestination: Writable | undefined = this._opts.readable;
        // and if we have an existing subshell writable, that should feed into our first stdin
        let firstSource: Readable | undefined;
        if (this._opts.writable) {
            const owritable = this._opts.writable;
            // fucking typescript
            const ofirstSource = new SubshellReader();
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
        const pnum = this._pipes.length;
        for (let i = 0; i < pnum; ++i) {
            const p = this._pipes[i];
            switch (p.type) {
            case "cmd":
                all.push(await runCmd(p, {
                    redirectStdin: source !== undefined || i > 0,
                    redirectStdout : i < pnum - 1 || finalDestination !== undefined,
                    redirectStderr: false
                }));
                break;
            case "subshell":
                let subopts: SubshellOptions = {};
                if (i < pnum - 1 || finalDestination !== undefined) {
                    subopts.readable = new SubshellReader();
                }
                if (source !== undefined || i > 0) {
                    subopts.writable = new SubshellWriter();
                }
                all.push({
                    stdout: subopts.readable,
                    stdin: subopts.writable,
                    promise: subshell(p, subopts)
                });
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
            promises.push(a.promise);
        }

        const results = await Promise.all(promises);

        // resolve with the exit code of the last pipe entry
        return results[results.length - 1];
    }
}

class LogicalOperations
{
    private _logicals: any;
    private _opts: SubshellOptions;

    constructor(logicals: any, opts: SubshellOptions) {
        this._logicals = logicals;
        this._opts = opts;
    }

    [Symbol.asyncIterator]() {
        return {
            _idx: 0,
            _done: false,
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
                            pipe(operand, this._opts)
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
                            subshell(operand, this._opts)
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
    private _opts: SubshellOptions;

    constructor(seps: any, opts: SubshellOptions) {
        this._seps = seps;
        this._opts = opts;
    }

    [Symbol.asyncIterator]() {
        return {
            _idx: 0,
            _seps: this._seps,
            _opts: this._opts,
            next(): Promise<IteratorResult<number | undefined>> {
                if (this._idx >= this._seps.length) {
                    return Promise.resolve({ done: true, value: undefined });
                } else {
                    return new Promise((resolve, reject) => {
                        const item = this._seps[this._idx++];
                        if (item.type === "logical") {
                            logical(item, this._opts)
                                .then(val => { resolve({ done: false, value: val }); })
                                .catch(reject);
                        } else if (item.type === "subshell" || item.type === "subshellOut") {
                            subshell(item, this._opts)
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

async function pipe(cmds: any, opts: SubshellOptions): Promise<number | undefined> {
    if (cmds.type !== "pipe") {
        throw new Error(`Invalid logical type ${cmds.type}`);
    }
    const pipes = new Pipe(cmds.pipe, opts);
    return await pipes.execute();
}

async function logical(cmds: any, opts: SubshellOptions): Promise<number | undefined> {
    if (cmds.type !== "logical") {
        throw new Error(`Invalid logical type ${cmds.type}`);
    }
    const logicals = new LogicalOperations(cmds.logical, opts);
    let rp: number | undefined = undefined;
    for await (const nrp of logicals) {
        if (nrp === undefined)
            continue;
        rp = nrp;
    }
    return rp;
}

async function subshell(cmds: any, opts: SubshellOptions): Promise<number | undefined> {
    let subopts: SubshellOptions | undefined;
    if (cmds.type === "subshell") {
        subopts = opts;
    } else if (cmds.type === "subshellOut") {
        subopts = {
            readable: new SubshellReader(),
            writable: new SubshellWriter()
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
        const seps = new CommandSeparators(cmds.subshell.sep, subopts);
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

export async function runSubshell(cmds: any): Promise<SubshellResult> {
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
                opts.readable = new SubshellReader(),
                opts.writable = new SubshellWriter();
                // fall through
            case "subshell":
                seps = new CommandSeparators(cmds.subshell.sep, opts);
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

export async function runSeparators(cmds: any): Promise<number | undefined> {
    if (cmds.type !== "sep") {
        throw new Error(`Invalid sep type ${cmds.type}`);
    }
    const seps = new CommandSeparators(cmds.sep, {});
    let rp: number | undefined = undefined;
    for await (const s of seps) {
        if (s === undefined)
            continue;
        rp = s;
    }
    return rp;
}

type WriteFinalFunction = () => void;
type WriteCallbackFunction = (err: any) => void;

class SubshellReader extends Duplex
{
    private _paused: boolean;
    private _buffers: { buf: Buffer | null, callback: WriteCallbackFunction | WriteFinalFunction }[];

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

    _final(callback: WriteFinalFunction) {
        if (this._paused) {
            this._buffers.push({ buf: null, callback: callback });
        } else {
            this.push(null);
            callback();
        }
    }

    _callCallback(data: { buf: Buffer | null, callback: WriteCallbackFunction | WriteFinalFunction }) {
        if (data.buf === null) {
            (data.callback as WriteFinalFunction)();
        } else {
            (data.callback as WriteCallbackFunction)(null);
        }
    }
}

type WriteResolveFunction = (value?: IteratorResult<Buffer | undefined> | PromiseLike<IteratorResult<Buffer | undefined>>) => void;

class SubshellWriter extends Writable
{
    private _buffers: { buf: Buffer, callback: WriteCallbackFunction }[];
    private _finalcb: WriteFinalFunction | undefined;
    private _paused: boolean;

    constructor() {
        super();

        this._paused = true;
        this._buffers = [];

        this.once("newListener", event => {
            if (event === "data") {
                this._paused = false;

                process.nextTick(() => {
                    for (const buf of this._buffers) {
                        buf.callback(null);
                        this.emit("data", buf.buf);
                    }
                    this._buffers = [];
                    if (this._finalcb) {
                        this._finalcb();
                        this.emit("end");
                        this._finalcb = undefined;
                    }
                });
            }
        });
    }

    _write(buf: Buffer, encoding: string, callback: (err: any) => void) {
        if (this._paused) {
            this._buffers.push({ buf: buf, callback: callback });
        } else {
            callback(null);
            this.emit("data", buf);
        }
    }

    _final(callback: WriteFinalFunction) {
        if (this._paused) {
            this._finalcb = callback;
        } else {
            callback();
            this.emit("end");
        }
    }
}
