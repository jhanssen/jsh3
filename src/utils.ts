import { join as pathJoin } from "path";
import { stat } from "fs";
import { promisify } from "util";
import { env } from "./variable";
import { default as Process } from "../native/process";

const uid = Process.uid();
const gids = Process.gids();

const pstat = promisify(stat);

export async function pathify(cmd: string): Promise<string> {
    if (cmd.includes("/")) {
        return cmd;
    }
    const paths = (env().PATH || "").split(":");

    for (const p of paths) {
        try {
            const j = pathJoin(p, cmd);
            const stats = await pstat(j);
            if (stats.isFile()) {
                if ((uid === stats.uid && (stats.mode & 0o500) === 0o500)
                    || (gids.includes(stats.gid) && (stats.mode & 0o050) === 0o050)
                    || ((stats.mode & 0o005) === 0o005)) {
                    return j;
                }
            }
        } catch (e) {
        }
    }

    throw new Error(`Unable to find ${cmd} in PATH`);
}

export async function isExecutable(path: string): Promise<boolean> {
    try {
        const stats = await pstat(path);
        return (stats.isFile() && ((uid === stats.uid && (stats.mode & 0o500) === 0o500)
                                   || (gids.includes(stats.gid) && (stats.mode & 0o050) === 0o050)
                                   || ((stats.mode & 0o005) === 0o005)));
    } catch (e) {
        // ugh
    }
    return false;
}

export async function isExecutableOrDirectory(path: string): Promise<boolean> {
    try {
        const stats = await pstat(path);
        return (stats.isDirectory() ||
                (stats.isFile() && ((uid === stats.uid && (stats.mode & 0o500) === 0o500)
                                    || (gids.includes(stats.gid) && (stats.mode & 0o050) === 0o050)
                                    || ((stats.mode & 0o005) === 0o005))));
    } catch (e) {
        // ugh again
    }
    return false;
}

// mostly lifted from https://stackoverflow.com/questions/33355528/filtering-an-array-with-a-function-that-returns-a-promise
export async function filterAsync<T>(args: T[], predicate: (arg: T) => Promise<boolean>): Promise<T[]> {
    // Take a copy of the array, it might mutate by the time we've finished
    const data = Array.from(args);
    // Transform all the elements into an array of promises using the predicate
    // as the promise
    return Promise.all(data.map(element => predicate(element)))
    // Use the result of the promises to call the underlying sync filter function
        .then(result => {
            return data.filter((element, index) => {
                return result[index];
            });
        });
}

export async function mapAsync<T>(args: T[], mapper: (arg: T) => Promise<T>): Promise<T[]> {
    return Promise.all(args.map(mapper));
}

// the functions from path are completely garbage
export function dirname(str: string) {
    const ls = str.lastIndexOf('/');
    if (ls === -1) {
        return "";
    }
    return str.substr(0, ls + 1);
}

export function basename(str: string) {
    const ls = str.lastIndexOf('/');
    if (ls === -1) {
        return "";
    }
    return str.substr(ls + 1);
}

export function join(...args: string[]) {
    return args.filter(a => a.length > 0).join("/").replace(/\/\//g, "/");
}
