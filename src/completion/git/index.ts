import { expand as expandFile } from "../file";
import { simple, finalize } from "../simple";
import { Completion as ReadlineCompletion } from "../../../native/readline";
import bsearch from "binary-search";

const main_porcelain_commands = {
    "add": "add file contents to index",
    "am": "apply patches from a mailbox",
    "archive": "create archive of files from named tree",
    "bisect": "find, by binary search, change that introduced a bug",
    "branch": "list, create, or delete branches",
    "bundle": "move objects and refs by archive",
    "checkout": "checkout branch or paths to working tree",
    "cherry-pick": "apply changes introduced by some existing commits",
    "citool": "graphical alternative to git commit",
    "clean": "remove untracked files from working tree",
    "clone": "clone repository into new directory",
    "commit": "record changes to repository",
    "describe": "show most recent tag that is reachable from a commit",
    "diff": "show changes between commits, commit and working tree, etc.",
    "fetch": "download objects and refs from another repository",
    "format-patch": "prepare patches for e-mail submission",
    "gc": "cleanup unnecessary files and optimize local repository",
    "grep": "print lines matching a pattern",
    "gui": "run portable graphical interface to git",
    "init": "create empty git repository or re-initialize an existing one",
    "log": "show commit logs",
    "merge": "join two or more development histories together",
    "mv": "move or rename file, directory, or symlink",
    "notes": "add or inspect object notes",
    "pull": "fetch from and merge with another repository or local branch",
    "push": "update remote refs along with associated objects",
    "range-diff": "compare two commit ranges",
    "rebase": "forward-port local commits to the updated upstream head",
    "reset": "reset current HEAD to specified state",
    "revert": "revert existing commits",
    "rm": "remove files from the working tree and from the index",
    "shortlog": "summarize git log output",
    "show": "show various types of objects",
    "stash": "stash away changes to dirty working directory",
    "status": "show working-tree status",
    "submodule": "initialize, update, or inspect submodules",
    "subtree": "split repository into subtrees and merge them",
    "tag": "create, list, delete or verify tag object signed with GPG",
    "worktree": "manage multiple working dirs attached to the same repository",
};

const ancillary_manipulator_commands = {
    "config": "get and set repository or global options",
    "fast-export": "data exporter",
    "fast-import": "import information into git directly",
    "filter-branch": "rewrite branches",
    "mergetool": "run merge conflict resolution tools to resolve merge conflicts",
    "pack-refs": "pack heads and tags for efficient repository access",
    "prune": "prune all unreachable objects from the object database",
    "reflog": "manage reflog information",
    "remote": "manage set of tracked repositories",
    "repack": "pack unpacked objects in a repository",
    "replace": "create, list, delete refs to replace objects",
};

const ancillary_interrogator_commands = {
    "blame": "show what revision and author last modified each line of a file",
    "cherry": "find commits not merged upstream",
    "count-objects": "count unpacked objects and display their disk consumption",
    "difftool": "show changes using common diff tools",
    "fsck": "verify connectivity and validity of objects in database",
    "get-tar-commit-id": "extract commit ID from an archive created using git archive",
    "help": "display help information about git",
    "instaweb": "instantly browse your working repository in gitweb",
    "interpret-trailers": "add or parse structured information in commit messages",
    "merge-tree": "show three-way merge without touching index",
    "rerere": "reuse recorded resolution of conflicted merges",
    "rev-parse": "pick out and massage parameters for other git commands",
    "show-branch": "show branches and their commits",
    "verify-commit": "check GPG signature of commits",
    "verify-tag": "check GPG signature of tags",
    "whatchanged": "show commit-logs and differences they introduce",
};

const interaction_commands = {
    "archimport": "import an Arch repository into git",
    "cvsexportcommit": "export a single commit to a CVS checkout",
    "cvsimport": "import a CVS \"repository\" into a git repository",
    "cvsserver": "run a CVS server emulator for git",
    "imap-send": "send a collection of patches to an IMAP folder",
    "quiltimport": "apply a quilt patchset",
    "request-pull": "generate summary of pending changes",
    "send-email": "send collection of patches as emails",
    "svn": "bidirectional operation between a Subversion repository and git",
};

const plumbing_manipulator_commands = {
    "apply": "apply patch to files and/or to index",
    "checkout-index": "copy files from index to working directory",
    "commit-tree": "create new commit object",
    "hash-object": "compute object ID and optionally create a blob from a file",
    "index-pack": "build pack index file for an existing packed archive",
    "merge-file": "run a three-way file merge",
    "merge-index": "run merge for files needing merging",
    "mktag": "create tag object",
    "mktree": "build tree-object from git ls-tree formatted text",
    "pack-objects": "create packed archive of objects",
    "prune-packed": "remove extra objects that are already in pack files",
    "read-tree": "read tree information into directory index",
    "symbolic-ref": "read and modify symbolic references",
    "unpack-objects": "unpack objects from packed archive",
    "update-index": "register file contents in the working directory to the index",
    "update-ref": "update object name stored in a reference safely",
    "write-tree": "create tree from the current index",
};

const plumbing_interrogator_commands = {
    "cat-file": "provide content or type information for repository objects",
    "diff-files": "compare files in working tree and index",
    "diff-index": "compare content and mode of blobs between index and repository",
    "diff-tree": "compare content and mode of blobs found via two tree objects",
    "for-each-ref": "output information on each ref",
    "ls-files": "information about files in index/working directory",
    "ls-remote": "show references in a remote repository",
    "ls-tree": "list contents of a tree object",
    "merge-base": "find as good a common ancestor as possible for a merge",
    "name-rev": "find symbolic names for given revisions",
    "pack-redundant": "find redundant pack files",
    "rev-list": "list commit object in reverse chronological order",
    "show-index": "show packed archive index",
    "show-ref": "list references in a local repository",
    "unpack-file": "create temporary file with blob's contents",
    "var": "show git logical variable",
    "verify-pack": "validate packed git archive files",
};

const plumbing_sync_commands = {
    "daemon": "run a really simple server for git repositories",
    "fetch-pack": "receive missing objects from another repository",
    "http-backend": "run a server side implementation of Git over HTTP",
    "send-pack": "push objects over git protocol to another repository",
    "update-server-info": "update auxiliary information file to help dumb servers",
};

const plumbing_sync_helper_commands = {
    "http-fetch": "download from remote git repository via HTTP",
    "http-push": "push objects over HTTP/DAV to another repository",
    "parse-remote": "routines to help parsing remote repository access parameters",
    "receive-pack": "receive what is pushed into repository",
    "shell": "restricted login shell for GIT-only SSH access",
    "upload-archive": "send archive back to git-archive",
    "upload-pack": "send objects packed back to git fetch-pack",
};

const plumbing_internal_helper_commands = {
    "check-attr": "display gitattributes information",
    "check-ignore": "debug gitignore/exclude files",
    "check-mailmap": "show canonical names and email addresses of contacts",
    "check-ref-format": "ensure that a reference name is well formed",
    "fmt-merge-msg": "produce merge commit message",
    "mailinfo": "extract patch and authorship from a single email message",
    "mailsplit": "split mbox file into a list of files",
    "merge-one-file": "standard helper-program to use with git merge-index",
    "patch-id": "compute unique ID for a patch",
    "stripspace": "filter out empty lines",
};

export type GitCompletion = (input: string[]) => Promise<string[]>;

const completions: {[key: string]: { help: string, completion: GitCompletion }} = {};
let sortedCompletions: string[] | undefined;

async function fileCompletion(input: string[]): Promise<string[]> {
    return await expandFile(input[input.length - 1]);
}

async function initCompletion(cmds: {[key: string]: string}) {
    for (const [cmd, help] of Object.entries(cmds)) {
        try {
            completions[cmd] = { help: help, completion: await import(`./cmd/${cmd}`) };
        } catch (e) {
            if (typeof e === "object" && e.code === "MODULE_NOT_FOUND") {
                completions[cmd] = { help: help, completion: fileCompletion };
            } else {
                throw e;
            }
        }
    }
}

(async function() {
    try {
        await initCompletion(main_porcelain_commands);
    } catch (e) {
        console.log("failed to init git completions", e);
    }
    sortedCompletions = Object.keys(completions).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
})();

export async function git(cmd: string, data: ReadlineCompletion): Promise<string[]> {
    const input = simple(data);
    // 'git' is input[0], the command is input[1] etc
    // console.log(input);
    if (input.length < 2 || sortedCompletions === undefined) {
        // bail
        return [];
    }
    if (input.length === 2) {
        // complete on command
        let ret = bsearch(sortedCompletions, input[1], (element, needle) => element.localeCompare(needle, "en", { sensitivity: "base" }));
        if (ret < 0) {
            ret = Math.abs(ret) - 1;
        }
        const comp = [];
        while (ret < sortedCompletions.length && sortedCompletions[ret].toLowerCase().startsWith(input[1])) {
            comp.push(sortedCompletions[ret++]);
        }
        return finalize(comp, input[1]);
    } else if (input[1] in completions) {
        const comp = completions[input[1]];
        return await comp.completion(input);
    }
    return [];
}
