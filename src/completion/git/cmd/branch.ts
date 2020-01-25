import { GitCompletion } from "..";
import { branch } from "../gitutils";
import { filterPath } from "../../simple";
import { basename, dirname } from "../../../utils";

async function branchcmd(input: string[]): Promise<string[]> {
    const last = input[input.length - 1];

    const dir = dirname(last);
    const file = basename(last);

    // complete on stuff from status directly
    const br = await branch.get(".");
    if (br === undefined) {
        // not a git repo?
        return [];
    }

    let candidates = [];
    // build a list of candidates
    if (br.heads) {
        for (const item of br.heads) {
            candidates.push(item.refname);
        }
    }
    if (br.remotes) {
        for (const item of br.remotes) {
            candidates.push(item.refname);
        }
    }
    if (br.tags) {
        for (const item of br.tags) {
            candidates.push(item.refname);
        }
    }

    candidates = candidates.filter(item => item.startsWith(dir)).map(item => item.substr(dir.length));
    if (!dir) {
        // we always have a HEAD at the root level?
        candidates.push("HEAD");
    }
    candidates.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

    // console.log("candidates", candidates, filterPath(candidates, file, last));

    return filterPath(candidates, file, dir);
}

export default <GitCompletion>branchcmd;
