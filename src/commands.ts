import { default as Readline } from "../native/readline";
import { default as Process } from "../native/process";
import { EnvType } from "./variable";
import { clearCache as clearExecutableCache } from "./completion/file";

async function exitcmd(args: string[], env: EnvType) {
    Process.stop();
    Readline.stop();
    process.exit();

    return 0;
}

async function exportcmd(args: string[], env: EnvType) {
    if (args.length < 2) {
        throw new Error("export needs at least two arguments");
    }
    env[args[0]] = args[1];
    return 0;
}

async function envcmd(args: string[], env: EnvType) {
    for (const [k, v] of Object.entries(env)) {
        console.log(`${k}=${v}`);
    }
    return 0;
}

async function rehashcmd(args: string[], env: EnvType) {
    clearExecutableCache();
    return 0;
}

export const commands = {
    env: envcmd,
    exit: exitcmd,
    export: exportcmd,
    rehash: rehashcmd
};
