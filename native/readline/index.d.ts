export interface Completion
{
    buffer: string;
    text: string;
    start: number;
    end: number;
    complete(data?: string[]): void;
}

export interface Data
{
    type: string
    lines?: string[];
    completion?: Completion;
}

declare function nativeCallback(data: Data): void;

declare namespace Native
{
    export function start(callback: typeof nativeCallback): void;
    export function stop(): void;
    export function pause(): Promise<void>;
    export function resume(): Promise<void>;
    export function clear(): Promise<void>;
    export function setPrompt(prompt: string): Promise<void>;
    export function addHistory(line: string, write?: boolean): Promise<void>;
    export function writeHistory(file: string): Promise<void>;
    export function readHistory(file: string): Promise<void>;
}

export default Native;
