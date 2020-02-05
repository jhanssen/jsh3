import {
    default as NativeProcess,
    Launch as NativeProcessLaunch,
    InCtx as NativeProcessIn,
    OutCtx as NativeProcessOut,
    Options as NativeProcessOptions,
    StatusOn as NativeProcessStatusOn,
    Redirection as NativeProcessRedirection
} from "../native/process";

import { EventEmitter } from "events";
import { Readable, Writable } from "stream";

export type StatusResolveFunction = (value?: number | undefined | PromiseLike<number | undefined>) => void;
export type RejectFunction = (reason?: any) => void;

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

    constructor(ctx: NativeProcessOut, launch: NativeProcessLaunch, promise: Promise<number | undefined>) {
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
        promise.then(() => {
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

export class Process extends EventEmitter
{
    private _launch: NativeProcessLaunch;
    private _status: Promise<number | undefined>;
    private _statusResolve: StatusResolveFunction | undefined;
    private _statusReject: RejectFunction | undefined;
    private _name: string;

    constructor(cmd: string, args?: string[], env?: {[key: string]: string | undefined}, opts?: NativeProcessOptions, redirs?: NativeProcessRedirection[]) {
        super();

        this._name = cmd;

        this._status = new Promise<number | undefined>((resolve, reject) => {
            this._statusResolve = resolve;
            this._statusReject = reject;
        });
        this._launch = NativeProcess.launch(cmd, args, env, (type: NativeProcessStatusOn, status?: number | string) => {
            switch (type) {
            case "error":
                this.emit("error", status as string);
                if (this._statusReject) {
                    this._statusReject(status);
                }
                break;
            case "stopped":
                this.emit("stopped", this);
                break;
            case "exited":
                this.emit("exited", { status: status as number, process: this });
                if (this._statusResolve) {
                    this._statusResolve(status as number);
                    break;
                }
            }
        }, opts, redirs);
    }

    get name() {
        return this._name;
    }

    get status() {
        return this._status;
    }

    get stdout() {
        if (this._launch.stdoutCtx) {
            return new ProcessReader(this._launch.stdoutCtx, this._launch, this._status);
        }
        throw new Error("Invalid process");
    }

    get stderr() {
        if (this._launch.stderrCtx) {
            return new ProcessReader(this._launch.stderrCtx, this._launch, this._status);
        }
        throw new Error("Invalid process");
    }

    get stdin() {
        if (this._launch.stdinCtx) {
            return new ProcessWriter(this._launch.stdinCtx, this._launch);
        }
        throw new Error("Invalid process");
    }

    get pid() {
        if (this._launch.pid > 0) {
            return this._launch.pid;
        }
        throw new Error("Invalid process");
    }

    setForeground(resume?: boolean) {
        this._launch.setMode(this._launch.processCtx, "foreground", resume || false);
    }

    setBackground(resume?: boolean) {
        this._launch.setMode(this._launch.processCtx, "background", resume || false);
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
        const read: ReadProcess = {
            status: 0,
            stdout: undefined,
            stderr: undefined
        };
        const launch = NativeProcess.launch(cmd, args, env, (type: NativeProcessStatusOn, status?: number | string) => {
            switch (type) {
            case "error":
                reject(status);
                break;
            case "exited":
                if (typeof status !== "number") {
                    throw new Error("Status of exited must be a number");
                }
                read.status = status;
                if (stdout.length > 0) {
                    read.stdout = Buffer.concat(stdout);
                }
                if (stderr.length > 0) {
                    read.stderr = Buffer.concat(stderr);
                }
                resolve(read);
                break;
            }});
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
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
