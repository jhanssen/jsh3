export interface Data
{
    type: string
    lines?: string[];
}

declare function nativeCallback(data: Data): void;

declare namespace Native
{
    export function start(callback: typeof nativeCallback): void;
    export function stop(): void;
    export function addHistory(line: string): Promise<void>;
}

export default Native;
