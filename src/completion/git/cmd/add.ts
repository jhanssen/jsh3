import { GitCompletion } from "..";
import { status, toplevel } from "../gitutils";
import { expand as expandFile } from "../../file";
import { filterPath } from "../../simple";
import { isDirectory, basename, dirname } from "../../../utils";

async function addcmd(input: string[]): Promise<string[]> {
    const last = input[input.length - 1];
    const lastempty = last.length === 0;
    const isdir = lastempty ? false : await isDirectory(last);

    const dir = isdir ? last : dirname(last);
    const file = isdir ? "" : basename(last);

    // make sure the dir is slashified
    if (isdir && last[last.length - 1] !== '/') {
        return [last + '/'];
    }

    // console.log("wull", dir, file, last);

    const top = await toplevel(dir || ".");
    if (top === undefined) {
        // not a git repo?
        return await expandFile(last, isDirectory);
    }

    const cwd = process.cwd();
    // if our top level is not under our current directory, bail.
    // maybe this could get confused with some symlinkery situation?
    if (cwd.indexOf(top) !== 0) {
        return [];
    }

    // complete on stuff from status directly
    const st = await status.get(dir || ".");
    if (st === undefined) {
        // really not a git repo?
        return [];
    }

    let candidates = [];
    // build a list of candidates
    if (st.tracked) {
        for (const tracked of st.tracked) {
            if (tracked.status & status.TrackedStatus.Worktree) {
                // we want this dude
                candidates.push(tracked.path);
            }
        }
    }
    if (st.unmerged) {
        for (const unmerged of st.unmerged) {
            // we want all unmerged?
            candidates.push(unmerged.path);
        }
    }
    if (st.untracked) {
        candidates = candidates.concat(st.untracked);
    }

    candidates.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

    // console.log("candidates", candidates, filterPath(candidates, file, last));

    return filterPath(candidates, file, dir);
}

export default <GitCompletion>addcmd;
