export interface InCtx {}
export interface OutCtx {}

export type StatusOn = "exited" | "stopped" | "error";

export interface Launch
{
    pid: number;
    write: (ctx: InCtx, buffer?: Buffer) => void;
    close: (ctx: InCtx) => void;
    listen: (ctx: OutCtx, listener: (buffer: Buffer) => void) => void;
    stdoutCtx?: OutCtx;
    stderrCtx?: OutCtx;
    stdinCtx?: InCtx;
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
        opts?: Options
    ): Launch;
}

export default Native;
