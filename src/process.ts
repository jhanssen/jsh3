import {
    default as NativeProcess,
    Launch as NativeProcessLaunch,
    InCtx as NativeProcessIn,
    OutCtx as NativeProcessOut,
    Options as NativeProcessOptions
} from "../native/process";

import { Readable, Writable } from "stream";

class ProcessWriter extends Writable
{
    private _launch: NativeProcessLaunch;
    private _ctx: NativeProcessIn;

    constructor(ctx: NativeProcessIn, launch: NativeProcessLaunch) {
        super();

        this._ctx = ctx;
        this._launch = launch;
    }

    _write(buf: Buffer, encoding: string, callback: (err: any) => void) {
        this._launch.write(this._ctx, buf);
        callback(null);
    }

    _final(callback: () => void) {
        this._launch.close(this._ctx);
        callback();
    }
}

type BufferOrNull = Buffer | null;

class ProcessReader extends Readable
{
    private _launch: NativeProcessLaunch;
    private _ctx: NativeProcessOut;
    private _paused: boolean;
    private _buffers: BufferOrNull[];

    constructor(ctx: NativeProcessOut, launch: NativeProcessLaunch) {
        super();

        this._paused = true;
        this._buffers = [];

        launch.listen(ctx, (buf: Buffer) => {
            if (this._paused) {
                this._buffers.push(buf);
            } else {
                if (!this.push(buf)) {
                    this._paused = true;
                }
            }
        });
        launch.promise.then(() => {
            if (this._paused) {
                this._buffers.push(null);
            } else {
                this.push(null);
            }
        }).catch(e => {
            this.push(null);
        });

        this._ctx = ctx;
        this._launch = launch;
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
}

export class Process
{
    private _launch: NativeProcessLaunch;

    constructor(cmd: string, args?: string[], env?: {[key: string]: string | undefined}, opts?: NativeProcessOptions) {
        this._launch = NativeProcess.launch(cmd, args, env, opts);
    }

    get status() {
        return this._launch.promise;
    }

    get stdout() {
        if (this._launch.stdoutCtx) {
            return new ProcessReader(this._launch.stdoutCtx, this._launch);
        }
        throw new Error("Invalid process");
    }

    get stderr() {
        if (this._launch.stderrCtx) {
            return new ProcessReader(this._launch.stderrCtx, this._launch);
        }
        throw new Error("Invalid process");
    }

    get stdin() {
        if (this._launch.stdinCtx) {
            return new ProcessWriter(this._launch.stdinCtx, this._launch);
        }
        throw new Error("Invalid process");
    }

    closeStdin() {
        if (this._launch.stdinCtx) {
            this._launch.close(this._launch.stdinCtx);
            this._launch.stdinCtx = undefined;
        } else {
            throw new Error("stdin not open");
        }
    }
}

export { NativeProcessOptions as ProcessOptions };

export interface ReadProcess {
    status: number | undefined;
    stdout: Buffer | undefined;
    stderr: Buffer | undefined;
}

export function readProcess(cmd: string, args?: string[], env?: {[key: string]: string}): Promise<ReadProcess> {
    return new Promise((resolve, reject) => {
        const launch = NativeProcess.launch(cmd, args, env);
        const read: ReadProcess = {
            status: 0,
            stdout: undefined,
            stderr: undefined
        };
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        launch.promise.then(status => {
            read.status = status;
            if (stdout.length > 0) {
                read.stdout = Buffer.concat(stdout);
            }
            if (stderr.length > 0) {
                read.stderr = Buffer.concat(stderr);
            }
            resolve(read);
        }).catch(e => {
            reject(e);
        });
        if (launch.stdinCtx) {
            launch.close(launch.stdinCtx);
        }
        if (launch.stdoutCtx) {
            launch.listen(launch.stdoutCtx, (buf: Buffer) => {
                stdout.push(buf);
            });
        }
        if (launch.stderrCtx) {
            launch.listen(launch.stderrCtx, (buf: Buffer) => {
                stderr.push(buf);
            });
        }
    });
}
