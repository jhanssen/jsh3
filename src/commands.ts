import { default as Readline } from "../native/readline";
import { default as Process } from "../native/process";
import { expand } from "./expand";

async function exitcmd(args: string[], env: {[key: string]: string | undefined}, source: string) {
    Process.stop();
    Readline.stop();
    process.exit();

    return 0;
}

async function exportcmd(args: string[], env: {[key: string]: string | undefined}, source: string) {
    if (args.length < 2) {
        throw new Error("export needs at least two arguments");
    }
    env[args[0]] = await expand(args[1], source);
    return 0;
}

export const commands = {
    exit: exitcmd,
    export: exportcmd
};
