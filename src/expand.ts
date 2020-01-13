import { runSubshell } from "./subshell";
import { env } from "./variable";

function expandVariable(value: any) {
    return env[value.value] || "";
}

export async function expand(value: any): Promise<any> {
    if (typeof value === "object" && "type" in value) {
        switch (value.type) {
        case "variable":
            return expandVariable(value);
        case "subshell":
            return (await runSubshell(value)).status;
        case "subshellOut":
            return (await runSubshell(value)).stdout;
        }
        if (value.value !== undefined) {
            return value.value.toString();
        }
    }
    if (value instanceof Array) {
        const ps = [];
        for (const sub of value) {
            ps.push(expand(sub));
        }
        return (await Promise.all(ps)).join("");
    }
    return value;
}
