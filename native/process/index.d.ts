export interface InCtx {}
export interface OutCtx {}
export interface ProcessCtx {}

export type StatusOn = "exited" | "stopped" | "error";

export interface Launch
{
    pid: number;
    write: (ctx: InCtx, buffer?: Buffer) => void;
    close: (ctx: InCtx) => void;
    listen: (ctx: OutCtx, listener: (buffer: Buffer) => void) => void;
    setMode: (ctx: ProcessCtx, mode: "foreground" | "background", resume: boolean) => void;
    processCtx: ProcessCtx;
    stdoutCtx?: OutCtx;
    stderrCtx?: OutCtx;
    stdinCtx?: InCtx;
}

// this is kept in sync with process.cc
export const enum RedirectionType { Input, Output, InputOutput, OutputAppend }
export const enum RedirectionIOType { File, FD }

export interface Redirection
{
    redirectionType: RedirectionType;
    ioType: RedirectionIOType;

    file?: string;
    sourceFD: number;
    destFD: number;
}

export interface Options
{
    redirectStdin: boolean;
    redirectStdout: boolean;
    redirectStderr: boolean;
    interactive: {
        foreground: boolean;
        pgid: number | undefined;
    } | undefined;
}

declare namespace Native
{
    export function start(): void;
    export function stop(): void;
    export function uid(name?: string): number;
    export function gids(name?: string): number[];
    export function launch(
        cmd: string,
        args: string[] | undefined,
        env: {[key: string]: string | undefined} | undefined,
        callback: (type: StatusOn, status?: number | string) => void,
        opts?: Options,
        redirs?: Redirection[]
    ): Launch;
}

export default Native;
