import { AssertionError } from "assert";

export function assert(condition: any, msg?: string): asserts condition {
    if (!condition) {
        throw new AssertionError({ message: msg })
    }
}
