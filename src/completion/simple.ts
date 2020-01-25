import { Completion as ReadlineCompletion } from "../../native/readline";
import { join, dirname, basename } from "../utils";
import bsearch from "binary-search";

function slashify(str: string) {
    if (str.length > 0 && str[str.length - 1] !== '/')
        str += '/';
    return str;
}

export function simple(input: ReadlineCompletion): string[] {
    const out = input.buffer.substr(0, input.end).split(' ').filter(e => e.length > 0);
    if (input.buffer[input.end - 1] === " ") {
        out.push("");
    }
    return out;
}

// adapted from https://github.com/eliben/code-for-blog/blob/master/2016/readline-samples/utils.cpp, public domain
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

export function finalize(items: string[], prefix: string, base?: string): string[] {
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

export function sorted(items: string[], filter: string): string[] {
    let ret = bsearch(items, filter, (element, needle) => element.localeCompare(needle, "en", { sensitivity: "base" }));
    if (ret < 0) {
        ret = Math.abs(ret) - 1;
    }
    const comp = [];
    while (ret < items.length && items[ret].toLowerCase().startsWith(filter)) {
        comp.push(items[ret++]);
    }
    return finalize(comp, filter);
}

export function filterPath(items: string[], base: string, prefix: string): string[] {
    const ret = [];
    for (const item of items) {
        if (item.indexOf(base) !== 0)
            continue;
        // find the previous and next breaks
        let next = item.indexOf('/', base.length);
        if (next === -1) {
            next = item.length;
        }
        let prev = base.length - 1;
        while (prev >= 0 && item[prev] !== '/') {
            --prev;
        }
        if (prev < 0)
            prev = 0;
        const newitem = item.substr(prev, next - prev + 1);
        if (ret.indexOf(newitem) === -1)
            ret.push(newitem);
    }
    return finalize(ret, prefix, prefix);
}
