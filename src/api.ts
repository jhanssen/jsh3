import { EnvType } from "./variable";
import { SubshellResult } from "./subshell";
import { DeclaredFunction } from "./commands";

export interface API {
    declare(name: string, func: DeclaredFunction): void;
    export(name: string, value: string | undefined): void;
    run(cmdline: string): Promise<SubshellResult>;
    setPrompt(prompt: string): Promise<void>;
}
