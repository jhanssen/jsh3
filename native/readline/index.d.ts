declare function nativeCallback(data: OWM.Event): void;

declare namespace Native
{
    export function start(callback: typeof nativeCallback): void;
    export function stop(): void;
}

export default Native;
