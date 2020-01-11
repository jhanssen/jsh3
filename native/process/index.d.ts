export interface InCtx {}
export interface OutCtx {}

export interface Launch
{
    promise: Promise<number>;
    write:(ctx: InCtx, buffer?: Buffer) => void;
    close:(ctx: InCtx) => void;
    listen:(ctx: OutCtx, listener: (buffer: Buffer) => void) => void;
    stdoutCtx?: OutCtx;
    stderrCtx?: OutCtx;
    stdinCtx?: InCtx;
}

export interface Options
{
    redirectStdin: boolean;
    redirectStdout: boolean;
    redirectStderr: boolean;
}

declare namespace Native
{
    export function start(): void;
    export function stop(): void;
    export function uid(name?: string): number;
    export function gids(name?: string): number[];
    export function launch(cmd: string, args?: string[], env?: {[key: string]: string}, opts?: Options): Launch;
}

export default Native;
