import { default as Readline } from "../native/readline";
import { default as Process } from "../native/process";
import { EnvType } from "./variable";
import { clearCache as clearExecutableCache } from "./completion/file";
import { Readable } from "stream";

async function* exitcmd(args: string[], env: EnvType, stdin?: Readable) {
    Process.stop();
    Readline.stop();
    process.exit();

    yield 0;
}

async function* exportcmd(args: string[], env: EnvType, stdin?: Readable) {
    if (args.length < 2) {
        throw new Error("export needs at least two arguments");
    }
    env[args[0]] = args[1];
    yield 0;
}

async function* envcmd(args: string[], env: EnvType, stdin?: Readable) {
    for (const [k, v] of Object.entries(env)) {
        console.log(`${k}=${v}`);
    }
    yield 0;
}

async function* rehashcmd(args: string[], env: EnvType, stdin?: Readable) {
    clearExecutableCache();
    yield 0;
}

export const builtinCommands = {
    env: envcmd,
    exit: exitcmd,
    export: exportcmd,
    rehash: rehashcmd
};

export type CommandFunction = (args: string[], env: EnvType, stdin?: Readable) => AsyncIterable<Buffer | string | number>;

export const declaredCommands: {
    commands: {[key: string]: CommandFunction},
    add: (name: string, cmd: CommandFunction) => void,
    remove: (name: string) => void
} = {
    commands: {},
    add: (name: string, cmd: CommandFunction) => {
        declaredCommands.commands[name] = cmd;
    },
    remove: (name: string) => {
        delete declaredCommands.commands[name];
    }
};
