import bsearch from "binary-search";
import { promisify } from "util";
import { stat, readdir } from "fs";
import { Completion as ReadlineCompletion } from "../../native/readline";
import { top } from "../variable";
import { commands as internalCommands } from "../commands";
import { finalize } from "./simple";
import * as utils from "../utils";

const cache: {
    globalExecutables: string[]
} = {
    globalExecutables: []
};

const promise = {
    readdir: promisify(readdir),
    stat: promisify(stat)
};

function fillGlobalExecutablesFromPath(path: string) {
    return (async function() {
        try {
            const read = await promise.readdir(path);
            for (const r of read) {
                // should we do a burst instead of just one by one?
                try {
                    if (await utils.isExecutable(utils.join(path, r)))
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

type TraverseFilter = (path: string) => Promise<boolean>;

export async function expand(dir: string, traverseFilter?: TraverseFilter): Promise<string[]> {
    const last = dir.lastIndexOf('/');
    // everything before and including the last slash is the directory we want to read
    const path = last === -1 ? "" : dir.substr(0, last + 1);
    // and everything after is our filter (which might be empy)
    const filter = last === -1 ? dir : dir.substr(last + 1).toLowerCase();
    //console.log("wepp", path, filter);

    let read = (await promise.readdir(path || ".")).concat([".", ".."]).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    if (traverseFilter) {
        // uuugh, rethink this!
        read = (await utils.filterAsync(read.map(r => path + r), traverseFilter)).map(r => r.substr(path.length));
    }
    read = await utils.mapAsync(read, async function(file) {
        try {
            const stats = await promise.stat(utils.join(path, file));
            if (stats.isDirectory())
                return file + "/";
        } catch (e) {
            // eat this error
        }
        return file;
    });
    if (filter.length === 0) {
        return finalize(read, dir);
    }

    let ret = bsearch(read, filter, (element, needle) => element.localeCompare(needle, "en", { sensitivity: "base" }));
    if (ret < 0) {
        ret = Math.abs(ret) - 1;
    }

    const comp = [];
    while (ret < read.length && read[ret].toLowerCase().startsWith(filter)) {
        comp.push(read[ret++]);
    }
    return finalize(comp, dir, path);
}

async function traverse(data: ReadlineCompletion, traverseFilter?: TraverseFilter): Promise<string[]> {
    // find the last '/', if we don't have one of those then we don't have any completions
    if (data.start === 0 && data.text.length === 0) {
        return [];
    }

    return await expand(data.text, traverseFilter);
}

export async function file(cmd: string, data: ReadlineCompletion): Promise<string[]> {

    if (cmd.length === 0)
        return [];
    if (data.start === 0) {
        if (cmd.indexOf('/') >= 0) {
            // if we start with a path character, traverse with an executable filter
            return await traverse(data, utils.isExecutableOrDirectory);
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
        return await traverse(data);
    }
    return [];
}


export function clearCache() {
    cache.globalExecutables = [];
}
