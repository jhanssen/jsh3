import { default as Readline } from "../native/readline";
import { default as Process } from "../native/process";
import { EnvType } from "./variable";
import { jobs } from "./jobs";
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

async function* jobscmd(args: string[], env: EnvType, stdin?: Readable) {
    let idx = 0;
    for (const job of jobs) {
        if (job.stopped) {
            console.log(`[${++idx}]: ${job.name}`);
        }
    }
    yield 0;
}

async function* fgcmd(args: string[], env: EnvType, stdin?: Readable) {
    const id = args.length === 0 ? 1 : parseInt(args[0]);
    if (id <= 0) {
        throw new Error("fg needs a positive id");
    }

    let idx = 0;
    for (const job of jobs) {
        if (job.stopped && ++idx === id) {
            job.setForeground();
            break;
        }
    }
    yield 0;
}

async function* bgcmd(args: string[], env: EnvType, stdin?: Readable) {
    const id = args.length === 0 ? 1 : parseInt(args[0]);
    if (id <= 0) {
        throw new Error("bg needs a positive id");
    }

    let idx = 0;
    for (const job of jobs) {
        if (job.stopped && ++idx === id) {
            job.setBackground();
            break;
        }
    }
    yield 0;
}

export const builtinCommands = {
    env: envcmd,
    exit: exitcmd,
    export: exportcmd,
    rehash: rehashcmd,
    jobs: jobscmd,
    fg: fgcmd,
    bg: bgcmd
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
