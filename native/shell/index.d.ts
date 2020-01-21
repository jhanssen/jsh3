export interface Shell
{
    pid: number;
    pgid: number;
    interactive: boolean;
}

type RestoreType = "drain" | "flush" | "now";

declare namespace Native
{
    export function start(): Shell;
    export function stop(): void;
    export function restore(type?: RestoreType): void;
}

export default Native;
