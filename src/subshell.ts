import { ReadProcess, Process } from "./process";
import { Readable, Writable } from "stream";
import { Streamable } from "./streamable";
import { pathify } from "./utils";
import { expand } from "./expand";
import { env as envGet, push as envPush, pop as envPop } from "./variable";
import { commands as internalCommands } from "./commands";

interface Options
{
    readable: SubshellReader;
    writable: SubshellWriter;
}

async function runCmd(cmds: any, opts?: Options) {
    envPush();

    let status: number | undefined;

    try {
        const env = envGet();
        if (cmds.assignments !== undefined) {
            for (const a of cmds.assignments) {
                // key has to be a number or identifier
                const key = a.key.value.toString();
                const val = await expand(a.value);
                //console.log(`expanded ${key} to '${val.toString().trimRight()}'`);
                env[key] = val.toString().trimRight();
            }
        }

        const ps = [];
        for (const id of cmds.cmd) {
            ps.push(expand(id));
        }

        const args = await Promise.all(ps);
        const cmd: string = args.shift();
        if (!cmd)
            return;

        if (cmd in internalCommands) {
            const internalCmd = internalCommands[cmd as keyof typeof internalCommands];
            return await internalCmd(args, env);
        }

        const rcmd = await pathify(cmd);

        const procOpts = {
            redirectStdin: (opts && opts.writable) ? true : false,
            redirectStdout: (opts && opts.readable) ? true : false,
            redirectStderr: false
        };
        const proc = new Process(rcmd, args, env, procOpts);

        const readProcess = async () => {
            if (!opts || !opts.writable)
                return;
            for await (const buf of proc.stdout) {
                opts.readable._write(buf);
            }
            opts.readable._write(null);
        };

        const writeProcess = async () => {
            if (!opts || !opts.readable)
                return;
            for await (const buf of opts.writable) {
                proc.stdin.write(buf);
            }
            proc.stdin.end();
        };

        const all = await Promise.all([readProcess(), writeProcess(), proc.status]);
        status = all[2];
    } catch (e) {
        envPop();
        throw e;
    }

    envPop();
    return status;
}

class Pipe
{
    private _pipes: any;
    private _opts: Options | undefined;

    constructor(pipes: any, opts?: Options) {
        this._pipes = pipes;
        this._opts = opts;
    }

    [Symbol.asyncIterator]() {
        return {
            _idx: 0,
            _opts: this._opts,
            _pipes: this._pipes,
            next(): Promise<IteratorResult<number | undefined>> {
                if (this._idx >= this._pipes.length) {
                    return Promise.resolve({ done: true, value: undefined });
                } else {
                    return new Promise((resolve, reject) => {
                        // if this is the last entry in the pipe list then we should write directly to stdout
                        // unless we're in a $() expansion, in which case we'll do substitution
                        const redirStdout = this._opts !== undefined || this._idx < this._pipes.length - 1;
                        const redirStdin = this._idx > 0;

                        const will = this._pipes[this._idx++];
                        // console.log("will run", will);
                        switch (will.type) {
                        case "subshell":
                            subshell(will, this._opts).then(val => { resolve({ done: false, value: val }); });
                            break;
                        case "cmd":
                            runCmd(will, this._opts).then(val => { resolve({ done: false, value: val }); });
                            break;
                        default:
                            reject(`Invalid cmd type ${will.type}`);
                            break;
                        }
                    });
                }
            }
        }
    }
}

class LogicalOperations
{
    private _logicals: any;
    private _opts: Options | undefined;

    constructor(logicals: any, opts?: Options) {
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

type UpdateStreamableFunction = (streamable: Streamable) => void;

class CommandSeparators
{
    private _seps: any;
    private _opts: Options | undefined;

    constructor(seps: any, opts?: Options) {
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

async function pipe(cmds: any, opts?: Options): Promise<number | undefined> {
    if (cmds.type !== "pipe") {
        throw new Error(`Invalid logical type ${cmds.type}`);
    }
    const pipes = new Pipe(cmds.pipe, opts);
    let rp: number | undefined;
    for await (const p of pipes) {
        if (p === undefined)
            continue;
        rp = p;
    }
    return rp;
}

async function logical(cmds: any, opts?: Options): Promise<number | undefined> {
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

async function subshell(cmds: any, opts?: Options): Promise<number | undefined> {
    let subopts: Options | undefined;
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
    let opts: Options | undefined;
    let seps: CommandSeparators | undefined;

    const result: SubshellResult = {
        status: undefined,
        stdout: undefined
    };

    envPush();

    try {
        switch (cmds.type) {
            case "subshellOut":
                opts = {
                    readable: new SubshellReader(),
                    writable: new SubshellWriter()
                }
                // fall through
            case "subshell":
                seps = new CommandSeparators(cmds.subshell.sep, opts);
                break;
        }

        if (seps === undefined) {
            throw new Error(`Invalid subshell type: ${cmds.type}`);
        }

        if (opts) {
            const o = opts;
            o.writable.end();
            o.readable.on("data", chunk => {
                if (result.stdout === undefined) {
                    result.stdout = chunk;
                } else {
                    result.stdout = Buffer.concat([result.stdout, chunk]);
                }
            });
            o.readable.on("end", () => {
                o.readable.removeAllListeners();
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
    const seps = new CommandSeparators(cmds.sep);
    let rp: number | undefined = undefined;
    for await (const s of seps) {
        if (s === undefined)
            continue;
        rp = s;
    }
    return rp;
}

type BufferOrNull = Buffer | null;

class SubshellReader extends Readable
{
    private _paused: boolean;
    private _buffers: BufferOrNull[];

    constructor() {
        super();

        this._paused = true;
        this._buffers = [];
    }

    _read(size: number) {
        for (let i = 0; i < this._buffers.length; ++i) {
            if (!this.push(this._buffers[i])) {
                // we got so far
                this._buffers.splice(0, i + 1);
                return;
            }
        }
        this._buffers = [];
        this._paused = false;
    }

    _write(buf: Buffer | null) {
        if (this._paused) {
            this._buffers.push(buf);
        } else {
            if (!this.push(buf)) {
                this._paused = true;
            }
        }
    }
}

type WriteFinalFunction = () => void;
type WriteCallbackFunction = (err: any) => void;
type WriteResolveFunction = (value?: IteratorResult<Buffer | undefined> | PromiseLike<IteratorResult<Buffer | undefined>>) => void;

class SubshellWriter extends Writable
{
    private _buffers: { buf: Buffer, callback: WriteCallbackFunction }[];
    private _finalcb: WriteFinalFunction | undefined;
    private _resolver: WriteResolveFunction | undefined;

    constructor() {
        super();

        this._buffers = [];
    }

    _write(buf: Buffer, encoding: string, callback: (err: any) => void) {
        if (this._resolver) {
            callback(null);
            this._resolver({ done: false, value: buf });
            this._resolver = undefined;
        } else {
            this._buffers.push({ buf: buf, callback: callback });
        }
    }

    _final(callback: () => void) {
        if (this._resolver) {
            callback();
            this._resolver({ done: true, value: undefined });
            this._resolver = undefined;
        } else {
            this._finalcb = callback;
        }
    }

    [Symbol.asyncIterator]() {
        return {
            that: this,
            next(): Promise<IteratorResult<Buffer | undefined>> {
                return new Promise((resolve, reject) => {
                    const that = this.that;
                    if (that._buffers.length > 0) {
                        const buf = that._buffers.shift();
                        if (buf === undefined) {
                            throw new Error("shifted undefined in SubshellWriter");
                        }
                        buf.callback(null);
                        resolve({ done: false, value: buf.buf });
                    } else if (that._finalcb) {
                        that._finalcb();
                        that._finalcb = undefined;
                        resolve({ done: true, value: undefined });
                    } else {
                        that._resolver = resolve;
                    }
                });
            }
        }
    }
}
