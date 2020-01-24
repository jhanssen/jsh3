import { Completion as ReadlineCompletion } from "../../native/readline";
import { top } from "../variable";
import { isExecutable } from "../utils";
import { commands as internalCommands } from "../commands";
import { promisify } from "util";
import { stat, readdir } from "fs";
import { join } from "path";
import bsearch from "binary-search";

const cache: {
    globalExecutables: string[]
} = {
    globalExecutables: []
};

const promise = {
    readdir: promisify(readdir),
    stat: promisify(stat)
};

function slashify(str: string) {
    if (str.length > 0 && str[str.length - 1] !== '/')
        str += '/';
    return str;
}

function fillGlobalExecutablesFromPath(path: string) {
    return (async function() {
        try {
            const read = await promise.readdir(path);
            for (const r of read) {
                // should we do a burst instead of just one by one?
                try {
                    if (await isExecutable(join(path, r)))
                        cache.globalExecutables.push(r);
                } catch (e) {
                    // eat this too
                }
            }
        } catch (e) {
            // just eat this
        }
    })();
}

function fillGlobalExecutables() {
    // add internal commands
    cache.globalExecutables = Object.keys(internalCommands);

    // traverse PATH
    const path = top().PATH;
    if (path === undefined)
        return Promise.resolve();
    const paths = path.split(':');
    const promises = [];
    for (const p of paths) {
        // stat and stuff
        promises.push(fillGlobalExecutablesFromPath(p));
    }

    return Promise.all(promises);
}

function finalize(items: string[], base?: string): string[] {
    if (items.length === 1) {
        if (items[0].length > 0) {
            if (items[0][items[0].length - 1] !== '/')
                items[0] += ' ';
            if (base !== undefined) {
                items[0] = base + items[0];
            }
        }
    }
    return items;
}

// mostly lifted from https://stackoverflow.com/questions/33355528/filtering-an-array-with-a-function-that-returns-a-promise
async function filterAsync<T>(args: T[], predicate: (arg: T) => Promise<boolean>): Promise<T[]> {
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

async function mapAsync<T>(args: T[], mapper: (arg: T) => Promise<T>): Promise<T[]> {
    return Promise.all(args.map(mapper));
}

type TraverseFilter = (path: string) => Promise<boolean>;

async function traverse(dir: string, traverseFilter?: TraverseFilter): Promise<string[]> {
    // find the last '/', if we don't have one of those then we don't have any completions
    const last = dir.lastIndexOf('/');
    if (last === -1) {
        return [];
    }
    // everything before and including the last slash is the directory we want to read
    const path = dir.substr(0, last + 1);
    // and everything after is our filter (which might be empy)
    const filter = dir.substr(last + 1);
    //console.log("wepp", path, filter);

    let read = (await promise.readdir(path)).concat([".", ".."]).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    if (traverseFilter) {
        read = await filterAsync(read, traverseFilter);
    }
    read = await mapAsync(read, async function(file) {
        const stats = await promise.stat(join(path, file));
        if (stats.isDirectory())
            return file + "/";
        return file;
    });
    if (filter.length === 0) {
        return read;
    }

    let ret = bsearch(read, filter, (element, needle) => element.localeCompare(needle, "en", { sensitivity: "base" }));
    if (ret < 0) {
        ret = Math.abs(ret) - 1;
    }

    const comp = [];
    while (ret < read.length && read[ret].startsWith(filter)) {
        comp.push(read[ret++]);
    }
    return finalize(comp, path);
}

export async function file(cmd: string, data: ReadlineCompletion): Promise<string[]> {

    if (cmd.length === 0)
        return [];
    if (data.start === 0) {
        if (cmd.indexOf('/') >= 0) {
            // if we start with a path character, traverse with an executable filter
            return await traverse(cmd, isExecutable);
        } else {
            // if we don't start with a path character ('.' or '/') then complete on global executables
            if (cache.globalExecutables.length === 0) {
                await fillGlobalExecutables();
                cache.globalExecutables.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
            }
            let ret = bsearch(cache.globalExecutables, cmd, (element, needle) => element.localeCompare(needle, "en", { sensitivity: "base" }));
            //const ret = bsearch(cache.globalExecutables, cmd, (element, needle) => needle.localeCompare(element));
            if (ret >= 0) {
                // exact match, but also include all subsequent matches that starts with the thing
                const comp = [ cmd ];
                while (ret + 1 < cache.globalExecutables.length) {
                    if (cache.globalExecutables[ret + 1].startsWith(cmd)) {
                        comp.push(cache.globalExecutables[ret + 1]);
                        ++ret;
                    } else {
                        break;
                    }
                }
                return finalize(comp);
            } else {
                ret = Math.abs(ret) - 1;
                const comp = [];
                while (ret < cache.globalExecutables.length && cache.globalExecutables[ret].startsWith(cmd)) {
                    comp.push(cache.globalExecutables[ret++]);
                }
                return finalize(comp);
            }
        }
    } else {
        // if we contain a '/' then we want to traverse a specific directory
        // otherwise we want to traverse the current directory.
        if (data.text.indexOf('/') >= 0) {
            return await traverse(data.text);
        } else {
            return await traverse("./" + data.text);
        }
    }
    return [];
}


export function clearCache() {
    cache.globalExecutables = [];
}
