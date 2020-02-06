import { Process } from "./process";
import { EventEmitter } from "events";
import { default as Readline } from "../native/readline";
import { default as Shell } from "../native/shell";

export class Job extends EventEmitter
{
    private _procs: Process[];
    private _stopped: number;
    private _finished: number;
    private _total: number;
    private _foreground: boolean;
    private _name: string | undefined;

    constructor(foreground: boolean) {
        super();

        this._procs = [];
        this._stopped = 0;
        this._finished = 0;
        this._total = 0;
        this._foreground = foreground;
    }

    get foreground() {
        return this._foreground;
    }

    get stopped() {
        return this._total > 0 && this._stopped === this._total;
    }

    get name() {
        if (this._name === undefined) {
            throw new Error("No name for job");
        }
        return this._name;
    }

    get valid() {
        return this._total > 0;
    }

    addProcess(proc: Process) {
        this._procs.push(proc);
        ++this._total;

        if (this._name === undefined) {
            this._name = proc.name;
        }

        proc.on("stopped", (p: { status: number, process: Process }) => {
            const idx = this._procs.indexOf(p.process);
            if (idx === -1) {
                throw new Error(`Stopped process that doesn't exist`);
            }
            ++this._stopped;
            if (this._stopped > this._total) {
                throw new Error(`More stopped processes than added processes`);
            }
            if (this._stopped === this._total) {
                if (this._foreground) {
                    Shell.restore();
                    Readline.resume().then(() => {
                        this.emit("stopped", p.status);
                    });
                } else {
                    this.emit("stopped", p.status);
                }
            }
        });

        proc.on("exited", (p: { status: number, process: Process }) => {
            const idx = this._procs.indexOf(p.process);
            if (idx === -1) {
                throw new Error(`Exited process that doesn't exist`);
            }
            this._procs.splice(idx, 1);

            ++this._finished;
            if (this._finished === this._total) {
                // fully finished
                this.emit("finished", p.status);
                this._stopped = 0;
            }
        });
    }

    setForeground() {
        if (!this._procs.length) {
            throw new Error(`Can't foreground job with no processes`);
        }
        if (this._stopped !== this._total) {
            throw new Error(`Can't foreground job if process is not stopped`);
        }
        // do the first one only
        this._foreground = true;
        this._stopped = 0;
        Readline.pause().then(() => {
            this._procs[0].setForeground(true);
        });
    }

    setBackground(resume?: boolean) {
        if (!this._procs.length) {
            throw new Error(`Can't background job with no processes`);
        }
        if (this._stopped !== this._total) {
            throw new Error(`Can't foreground job if process is not stopped`);
        }
        // do the first one only
        this._procs[0].setBackground(true);
        this._foreground = false;
        this._stopped = 0;
    }
}
