import { runSubshell, runJS } from "./subshell";
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
        case "jscode":
            if (value.capture === "out") {
                const js = await runJS(value, source, { redirectStdin: false, redirectStdout: true });
                let ret = "";
                if (js.stdout) {
                    for await (const data of js.stdout) {
                        ret += data.toString();
                    }
                }
                return ret.trimRight();
            } else if (value.capture === "exit") {
                const js = await runJS(value, source, { redirectStdin: false, redirectStdout: false });
                let status: number | undefined;
                if (js.status) {
                    status = await js.status;
                }
                return (status || 0).toString();
            } else {
                throw new Error(`Unimplemented js capture ${value.capture}`);
            }
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
