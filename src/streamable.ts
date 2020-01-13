import { Readable, Writable } from "stream";

export interface Streamable
{
    readonly status: Promise<number>;
    readonly stdout: Readable;
    readonly stderr: Readable;
    readonly stdin: Writable;

    closeStdin(): void;
}
