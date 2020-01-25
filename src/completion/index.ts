import { Completion as ReadlineCompletion } from "../../native/readline";
import { file } from "./file";
import { git } from "./git";
import { cache } from "./cache";

type CompleterFunction = (cmd: string, data: ReadlineCompletion) => Promise<string[]>;

const cmds: {[key: string]: CompleterFunction} = {
    git: git,
};

function extractcmd(data: ReadlineCompletion)
{
    if (data.start === 0) {
        return data.text;
    }
    return data.buffer.split(' ')[0];
}

export function complete(data: ReadlineCompletion)
{
    let completer: CompleterFunction | undefined;

    const cmd = extractcmd(data);
    if (data.start > 0 && cmd in cmds) {
        completer = cmds[cmd];
    }

    if (completer === undefined) {
        completer = file;
    }

    completer(cmd, data).then(completion => {
        data.complete(completion);
    }).catch(err => {
        console.error(err);
        data.complete([]);
    });
}

export { cache };
