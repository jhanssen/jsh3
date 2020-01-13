import { default as Readline } from "../native/readline";
import { default as Process } from "../native/process";

async function exit(args: string[], env: {[key: string]: string | undefined}) {
    Process.stop();
    Readline.stop();
    process.exit();

    return 0;
}

export const commands = {
    exit: exit
};
