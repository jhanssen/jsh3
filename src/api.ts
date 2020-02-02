import { EnvType } from "./variable";
import { SubshellResult } from "./subshell";

export interface API {
    declare(name: string, func: (args: string[], env: EnvType) => Promise<number | undefined>): void;
    export(name: string, value: string | undefined): void;
    run(cmdline: string): Promise<SubshellResult>;
    setPrompt(prompt: string): Promise<void>;
}
