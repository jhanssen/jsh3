import { Completion as ReadlineCompletion } from "../../native/readline";
import { top } from "../variable";
import { isExecutable, isExecutableOrDirectory, longestCommonPrefix, filterAsync, mapAsync } from "../utils";
import { commands as internalCommands } from "../commands";
import { promisify } from "util";
import { stat, readdir } from "fs";
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

// the functions from path are completely garbage
function dirname(str: string) {
    const ls = str.lastIndexOf('/');
    if (ls === -1) {
        return "";
    }
    return str.substr(0, ls + 1);
}

function basename(str: string) {
    const ls = str.lastIndexOf('/');
    if (ls === -1) {
        return "";
    }
    return str.substr(ls + 1);
}

function join(...args: string[]) {
    return args.filter(a => a.length > 0).join("/").replace(/\/\//g, "/");
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

function finalize(items: string[], prefix: string, base?: string): string[] {
    if (items.length === 0) {
        return items;
    }
    if (items.length === 1) {
        if (items[0].length > 0) {
            if (items[0][items[0].length - 1] !== '/')
                items[0] += ' ';
            if (base !== undefined) {
                items[0] = base + items[0];
            }
        }
    } else {
        // find the longest common substring, set that as the first
        // element of the array and then prepend base (if exists)

        // this is a bit gnarly, should be reworked
        const has = prefix.length > 0 ? (prefix[prefix.length - 1] === '/') : false;
        prefix = join(dirname(prefix), longestCommonPrefix(basename(prefix), items));
        items.unshift(has ? slashify(prefix) : prefix);
    }
    return items;
}

type TraverseFilter = (path: string) => Promise<boolean>;

async function traverse(data: ReadlineCompletion, options?: { filter?: TraverseFilter }): Promise<string[]> {
    // find the last '/', if we don't have one of those then we don't have any completions
    if (data.start === 0 && data.text.length === 0) {
        return [];
    }

    const dir = data.text;
    const last = dir.lastIndexOf('/');
    // everything before and including the last slash is the directory we want to read
    const path = last === -1 ? "" : dir.substr(0, last + 1);
    // and everything after is our filter (which might be empy)
    const filter = last === -1 ? dir : dir.substr(last + 1).toLowerCase();
    //console.log("wepp", path, filter);

    let read = (await promise.readdir(path || ".")).concat([".", ".."]).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    if (options && options.filter) {
        // uuugh, rethink this!
        read = (await filterAsync(read.map(r => path + r), options.filter)).map(r => r.substr(path.length));
    }
    read = await mapAsync(read, async function(file) {
        try {
            const stats = await promise.stat(join(path, file));
            if (stats.isDirectory())
                return file + "/";
        } catch (e) {
            // eat this error
        }
        return file;
    });
    if (filter.length === 0) {
        return finalize(read, data.text);
    }

    let ret = bsearch(read, filter, (element, needle) => element.localeCompare(needle, "en", { sensitivity: "base" }));
    if (ret < 0) {
        ret = Math.abs(ret) - 1;
    }

    const comp = [];
    while (ret < read.length && read[ret].toLowerCase().startsWith(filter)) {
        comp.push(read[ret++]);
    }
    return finalize(comp, data.text, path);
}

export async function file(cmd: string, data: ReadlineCompletion): Promise<string[]> {

    if (cmd.length === 0)
        return [];
    if (data.start === 0) {
        if (cmd.indexOf('/') >= 0) {
            // if we start with a path character, traverse with an executable filter
            return await traverse(data, { filter: isExecutableOrDirectory });
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
                return finalize(comp, data.text);
            } else {
                ret = Math.abs(ret) - 1;
                const comp = [];
                while (ret < cache.globalExecutables.length && cache.globalExecutables[ret].startsWith(cmd)) {
                    comp.push(cache.globalExecutables[ret++]);
                }
                return finalize(comp, data.text);
            }
        }
    } else {
        // if we contain a '/' then we want to traverse a specific directory
        // otherwise we want to traverse the current directory.
        if (data.text.indexOf('/') >= 0) {
            return await traverse(data);
        } else {
            return await traverse(data);
        }
    }
    return [];
}


export function clearCache() {
    cache.globalExecutables = [];
}
