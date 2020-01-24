import { join as pathJoin } from "path";
import { stat } from "fs";
import { promisify } from "util";
import { env } from "./variable";
import { default as Process } from "../native/process";

const uid = Process.uid();
const gids = Process.gids();

const pstat = promisify(stat);

export function pathify(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        if (cmd.includes("/")) {
            resolve(cmd);
            return;
        }
        const paths = (env().PATH || "").split(":");

        let num = 0;
        const reject1 = () => {
            if (++num === paths.length) {
                reject(`File not found ${cmd}`);
            }
        };

        for (const p of paths) {
            // should maybe do these sequentially in order to avoid races
            const j = pathJoin(p, cmd);
            stat(j, (err, stats) => {
                if (err || !stats) {
                    reject1();
                    return;
                }
                if (stats.isFile()) {
                    if ((uid === stats.uid && stats.mode & 0o500)
                        || (gids.includes(stats.gid) && stats.mode & 0o050)
                        || (stats.mode & 0o005)) {
                        resolve(j);
                    } else {
                        reject1();
                    }
                } else {
                    reject1();
                }
            });
        }
    });
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

// adopted from https://github.com/eliben/code-for-blog/blob/master/2016/readline-samples/utils.cpp, public domain
export function longestCommonPrefix(base: string, strings: string[]): string
{
    switch (strings.length) {
    case 0:
        return "";
    case 1:
        return strings[0];
    }
    let prefix = base;
    const first = strings[0];
    const num = strings.length;
    while (true) {
        let nextloc = prefix.length;
        if (first.length <= nextloc) {
            return prefix;
        }
        let nextchar = first[nextloc];
        for (let i = 1; i < num; ++i) {
            const cur = strings[i];
            if (cur.length <= nextloc || cur[nextloc] !== nextchar) {
                return prefix;
            }
        }
        prefix += nextchar;
    }
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
