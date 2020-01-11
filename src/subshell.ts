import { ReadProcess, Process } from "./process";

class Pipe
{
    private _pipes: any;
    private _subst: boolean;

    constructor(pipes: any, subst: boolean) {
        this._pipes = pipes.pipe;
        this._subst = subst;
    }

    [Symbol.asyncIterator]() {
        return {
            _idx: 0,
            _subst: this._subst,
            _pipes: this._pipes,
            next(): Promise<IteratorResult<ReadProcess | undefined>> {
                if (this._idx >= this._pipes.length) {
                    return Promise.resolve({ done: true, value: undefined });
                } else {
                    return new Promise((resolve, reject) => {
                        // if this is the last entry in the pipe list then we should write directly to stdout
                        // unless we're in a $() expansion, in which case we'll do substitution
                        const redirStdout = this._subst || this._idx < this._pipes.length - 1;
                        const redirStdin = this._idx > 0;

                        const opts = {
                            redirectStdin: redirStdin,
                            redirectStdout: redirStdout,
                            redirectStderr: false
                        };

                        Need to have a common expander (expand.ts?)
                    });
                }
            }
        }
    }
}

class LogicalOperations
{
    private _logicals: any;
    private _subst: boolean;

    constructor(logicals: any, subst: boolean) {
        this._logicals = logicals.logical;
    }

    [Symbol.asyncIterator]() {
        return {
            _idx: 0,
            _done: false,
            _subst: this._subst,
            _logicals: this._logicals,
            next(): Promise<IteratorResult<ReadProcess | undefined>> {
                if (this._done || this._idx >= this._logicals.length) {
                    return Promise.resolve({ done: true, value: undefined });
                } else {
                    return new Promise((resolve, reject) => {
                        const operator = (this._idx + 1 < this._logicals.length) ? this._logicals[this._idx + 1].value : undefined;
                        const operand = this._logicals[this._idx];
                        this._idx += 2;
                        if (operand.type === "pipe") {
                            pipe(operand, this._subst)
                                .then(val => {
                                    if (!val) {
                                        resolve({ done: false, value: undefined });
                                        return;
                                    }
                                    if (val.status && operator === "&&")
                                        this._done = true;
                                    else if (!val.status && operator === "||")
                                        this._done = true;
                                    resolve({ done: false, value: val });
                                }).catch(reject);
                        } else if (operand.type === "subshell" || operand.type === "subshellOut") {
                            subshell(operand, this._subst)
                                .then(val => {
                                    if (!val) {
                                        resolve({ done: false, value: undefined });
                                        return;
                                    }
                                    if (val.status && operator === "&&")
                                        this._done = true;
                                    else if (!val.status && operator === "||")
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
    private _subst: boolean;

    constructor(seps: any, subst: boolean) {
        this._seps = seps.sep;
        this._subst = subst;
    }

    [Symbol.asyncIterator]() {
        return {
            _idx: 0,
            _seps: this._seps,
            _subst: this._subst,
            next(): Promise<IteratorResult<ReadProcess | undefined>> {
                if (this._idx >= this._seps.length) {
                    return Promise.resolve({ done: true, value: undefined });
                } else {
                    return new Promise((resolve, reject) => {
                        const item = this._seps[this._idx++];
                        if (item.type === "logical") {
                            logical(item, this._subst)
                                .then(val => { resolve({ done: false, value: val }); })
                                .catch(reject);
                        } else if (item.type === "subshell" || item.type === "subshellOut") {
                            subshell(item, this._subst)
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

async function pipe(cmds: any, subst: boolean): Promise<ReadProcess> {
    const pipes = new Pipe(cmds.pipe, subst);
    const rp: ReadProcess = { status: undefined, stdout: undefined, stderr: undefined };
    return rp;
}

async function logical(cmds: any, subst: boolean): Promise<ReadProcess> {
    const logicals = new LogicalOperations(cmds.logical, subst);
    const rp: ReadProcess = { status: undefined, stdout: undefined, stderr: undefined };
    for await (const nrp of logicals) {
        if (!nrp)
            continue;
        rp.status = nrp.status;
        if (nrp.stdout !== undefined) {
            if (rp.stdout === undefined)
                rp.stdout = nrp.stdout;
            else
                rp.stdout = Buffer.concat([rp.stdout, nrp.stdout]);
        }
        if (nrp.stderr !== undefined) {
            if (rp.stderr === undefined)
                rp.stderr = nrp.stderr;
            else
                rp.stderr = Buffer.concat([rp.stderr, nrp.stderr]);
        }
    }
    return rp;
}

export async function subshell(cmds: any, subst?: boolean): Promise<ReadProcess> {
    let seps: CommandSeparators | undefined;
    if (cmds.type === "subshell") {
        seps = new CommandSeparators(cmds.subshell, false || (subst === undefined ? false : subst));
    } else if (cmds.type === "subshellOut") {
        seps = new CommandSeparators(cmds.subshell, true);
    }
    if (seps === undefined) {
        throw new Error(`Invalid subshell type: ${cmds.type}`);
    }
    const rp: ReadProcess = { status: undefined, stdout: undefined, stderr: undefined };
    for await (const result of seps) {
        console.log(result);
    }
    return rp;
}
