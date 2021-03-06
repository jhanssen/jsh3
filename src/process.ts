import {
    default as NativeProcess,
    Launch as NativeProcessLaunch,
    InCtx as NativeProcessIn,
    OutCtx as NativeProcessOut,
    Options as NativeProcessOptions,
    StatusOn as NativeProcessStatusOn,
    Redirection as NativeProcessRedirection,
    Signals as NativeProcessSignals
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

    constructor(cmd: string, args: string[], env: {[key: string]: string | undefined}, opts: NativeProcessOptions, redirs?: NativeProcessRedirection[]) {
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
                this.emit("stopped", { status: status as number, process: this });
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

export function stopReason(signal: number) {
    switch (signal) {
    case NativeProcessSignals.SIGSTOP:
        return "(signal)";
    case NativeProcessSignals.SIGTTIN:
        return "(tty input)";
    case NativeProcessSignals.SIGTTOU:
        return "(tty output)";
    }
    return "";
}

export function signalName(signal: number) {
    switch (signal) {
    case NativeProcessSignals.SIGHUP:
        return "SIGHUP";
    case NativeProcessSignals.SIGINT:
        return "SIGINT";
    case NativeProcessSignals.SIGQUIT:
        return "SIGQUIT";
    case NativeProcessSignals.SIGILL:
        return "SIGILL";
    case NativeProcessSignals.SIGTRAP:
        return "SIGTRAP";
    case NativeProcessSignals.SIGABRT:
        return "SIGABRT";
    case NativeProcessSignals.SIGEMT:
        return "SIGEMT";
    case NativeProcessSignals.SIGFPE:
        return "SIGFPE";
    case NativeProcessSignals.SIGKILL:
        return "SIGKILL";
    case NativeProcessSignals.SIGBUS:
        return "SIGBUS";
    case NativeProcessSignals.SIGSEGV:
        return "SIGSEGV";
    case NativeProcessSignals.SIGSYS:
        return "SIGSYS";
    case NativeProcessSignals.SIGPIPE:
        return "SIGPIPE";
    case NativeProcessSignals.SIGALRM:
        return "SIGALRM";
    case NativeProcessSignals.SIGTERM:
        return "SIGTERM";
    case NativeProcessSignals.SIGURG:
        return "SIGURG";
    case NativeProcessSignals.SIGSTOP:
        return "SIGSTOP";
    case NativeProcessSignals.SIGTSTP:
        return "SIGTSTP";
    case NativeProcessSignals.SIGCONT:
        return "SIGCONT";
    case NativeProcessSignals.SIGCHLD:
        return "SIGCHLD";
    case NativeProcessSignals.SIGTTIN:
        return "SIGTTIN";
    case NativeProcessSignals.SIGTTOU:
        return "SIGTTOU";
    case NativeProcessSignals.SIGIO:
        return "SIGIO";
    case NativeProcessSignals.SIGXCPU:
        return "SIGXCPU";
    case NativeProcessSignals.SIGXFSZ:
        return "SIGXFSZ";
    case NativeProcessSignals.SIGVTALRM:
        return "SIGVTALRM";
    case NativeProcessSignals.SIGPROF:
        return "SIGPROF";
    case NativeProcessSignals.SIGWINCH:
        return "SIGWINCH";
    case NativeProcessSignals.SIGINFO:
        return "SIGINFO";
    case NativeProcessSignals.SIGUSR1:
        return "SIGUSR1";
    }
    return "unknown";
}

export { NativeProcessOptions as ProcessOptions };
