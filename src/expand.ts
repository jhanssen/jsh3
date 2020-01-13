import { runSubshell } from "./subshell";
import { env } from "./variable";

function expandVariable(value: any) {
    return env()[value.value] || "";
}

function numberCoerce(value: number | undefined) {
    if (value === undefined)
        return -1;
    return value;
}

export async function expand(value: any, source: string): Promise<string> {
    if (typeof value === "object" && "type" in value) {
        switch (value.type) {
        case "variable":
            return expandVariable(value);
        case "subshell":
            return numberCoerce((await runSubshell(value, source)).status).toString();
        case "subshellOut":
            return ((await runSubshell(value, source)).stdout || "").toString().trimRight();
        }
        if (value.value !== undefined) {
            return value.value.toString();
        }
    }
    if (value instanceof Array) {
        const ps = [];
        for (const sub of value) {
            ps.push(expand(sub, source));
        }
        return (await Promise.all(ps)).join("");
    }
    return value.toString();
}
