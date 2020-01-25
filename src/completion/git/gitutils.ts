import { execFile } from "child_process";

const promise = {
    execFile: (file: string, args: string[], options?: { cwd: string }): Promise<{ stdout: string, stderr: string }> => {
        return new Promise((resolve, reject) => {
            execFile(file, args, options || {}, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout: stdout || "", stderr: stderr || "" });
            });
        });
    }
};

export async function toplevel(path: string): Promise<string | undefined> {
    try {
        const data = await promise.execFile("git", ["rev-parse", "--show-toplevel"], { cwd: path });
        return data.stdout.trimRight();
    } catch (e) {
    }
    return undefined;
}

export namespace status {
    export enum TrackedStatus {
        NotUpdated      = 0x1000,

        IndexUpdated    = 0x2,
        IndexAdded      = 0x4,
        IndexDeleted    = 0x8,
        IndexRenamed    = 0x10,
        IndexCopied     = 0x20,
        Index           = 0xFF,

        WorktreeChanged = 0x100,
        WorktreeDeleted = 0x200,
        WorktreeRenamed = 0x400,
        WorktreeCopied  = 0x800,
        Worktree        = 0xF00,
    }

    export enum UnmergedStatus {
        BothDeleted,
        AddedByUs,
        DeletedByThem,
        AddedByThem,
        DeletedByUs,
        BothAdded,
        BothModified
    }

    export interface Tracked {
        status: TrackedStatus;
        path: string;
    }

    export interface Unmerged {
        status: UnmergedStatus;
        path: string;
    }

    export interface Status {
        tracked?: Tracked[];
        unmerged?: Unmerged[];
        untracked?: string[];
    }

    function parseTracked(line: string, status: Status, pathIdx: number) {
        if (status.tracked === undefined) {
            status.tracked = [];
        }

        const path = line.split(' ')[pathIdx];
        switch (line[2]) {
        case '.':
            switch (line[3]) {
            case '.':
                status.tracked.push({ status: TrackedStatus.NotUpdated, path: path });
                return;
            case 'M':
                status.tracked.push({ status: TrackedStatus.WorktreeChanged, path: path });
                return;
            case 'D':
                status.tracked.push({ status: TrackedStatus.WorktreeDeleted, path: path });
                return;
            case 'R':
                status.tracked.push({ status: TrackedStatus.WorktreeRenamed, path: path });
                return;
            case 'C':
                status.tracked.push({ status: TrackedStatus.WorktreeCopied, path: path });
                return;
            default:
                throw new Error(`Unexpected worktree status ${line[3]}`);
            }
            break;
        case 'M':
            status.tracked.push({ status: TrackedStatus.IndexUpdated, path: path });
            return;
        case 'A':
            status.tracked.push({ status: TrackedStatus.IndexAdded, path: path });
            return;
        case 'D':
            status.tracked.push({ status: TrackedStatus.IndexDeleted, path: path });
            return;
        case 'R':
            status.tracked.push({ status: TrackedStatus.IndexRenamed, path: path });
            return;
        case 'C':
            status.tracked.push({ status: TrackedStatus.IndexCopied, path: path });
            return;
        }
        throw new Error(`Unexpected index status ${line[2]}`);
    }

    function parseUnmerged(line: string, status: Status) {
        if (status.unmerged === undefined) {
            status.unmerged = [];
        }

        const path = line.split(' ')[10];

        switch (line[2]) {
        case 'D':
            switch (line[3]) {
            case 'D':
                status.unmerged.push({ status: UnmergedStatus.BothDeleted, path: path });
                return;
            case 'U':
                status.unmerged.push({ status: UnmergedStatus.DeletedByUs, path: path });
                return;
            default:
                throw new Error(`Unknown umerged status ${line.substr(2, 2)}`);
            }
            break;
        case 'A':
            switch (line[3]) {
            case 'U':
                status.unmerged.push({ status: UnmergedStatus.AddedByUs, path: path });
                return;
            case 'A':
                status.unmerged.push({ status: UnmergedStatus.BothAdded, path: path });
                return;
            default:
                throw new Error(`Unknown umerged status ${line.substr(2, 2)}`);
            }
            break;
        case 'U':
            switch (line[3]) {
            case 'D':
                status.unmerged.push({ status: UnmergedStatus.DeletedByThem, path: path });
                return;
            case 'A':
                status.unmerged.push({ status: UnmergedStatus.AddedByThem, path: path });
                return;
            case 'U':
                status.unmerged.push({ status: UnmergedStatus.BothModified, path: path });
                return;
            default:
                throw new Error(`Unknown umerged status ${line.substr(2, 2)}`);
            }
            break;
        }

        throw new Error(`Unknown umerged status ${line.substr(2, 2)}`);
    }

    export async function get(path: string): Promise<Status | undefined> {
        let data: { stdout: string, stderr: string } | undefined;
        try {
            data = await promise.execFile("git", ["status", "--branch", "-u", "--porcelain=v2"], { cwd: path });
        } catch (err) {
        }
        if (data === undefined) {
            return undefined;
        }
        //console.log("got data", data.stdout.split('\0'));
        const status = data.stdout.split('\n');
        if (status.length === 0) {
            return {};
        }
        const ret: Status = {};
        for (const line of status) {
            if (line.length === 0)
                continue;
            switch (line[0]) {
            case '#':
                // header, skip for now
                break;
            case '1':
                // normal change
                parseTracked(line, ret, 8);
                break;
            case '2':
                parseTracked(line, ret, 9);
                break;
            case 'u':
                parseUnmerged(line, ret);
                break;
            case '?':
                if (ret.untracked === undefined) {
                    ret.untracked = [ line.substr(2) ];
                } else {
                    ret.untracked.push(line.substr(2));
                }
                break;
            case '!': // ignored, but we don't support that right now
            default:
                throw new Error(`Unknown status status ${line[0]}`);
            }
        }
        return ret;
    }
}

export namespace branch {
    export interface Branch {
        refname: string;
        objectname: string;
        objecttype: string;
    };

    export interface Branches {
        heads?: Branch[],
        remotes?: Branch[],
        tags?: Branch[]
    }

    function parseBranch(line: string[], skip: number) {
        const ret: Branch = {
            refname: line[0].substr(skip),
            objectname: line[1],
            objecttype: line[2]
        };
        return ret;
    }

    export async function get(path: string): Promise<Branches | undefined> {
        let data: { stdout: string, stderr: string } | undefined;
        try {
            data = await promise.execFile("git", ["for-each-ref", "refs/", "--format", "%(refname)%00%(objectname:short)%00%(objecttype)"], { cwd: path });
        } catch (err) {
        }
        if (data === undefined) {
            return undefined;
        }
        const status = data.stdout.split('\n');
        if (status.length === 0) {
            return {};
        }
        const ret: Branches = {};
        for (const line of status) {
            const br = line.split('\0');
            if (br.length === 0) {
                continue;
            }
            if (br[0].startsWith("refs/heads/")) {
                if (ret.heads === undefined) {
                    ret.heads = [];
                }
                ret.heads.push(parseBranch(br, 11));
            } else if (br[0].startsWith("refs/remotes/")) {
                if (ret.remotes === undefined) {
                    ret.remotes = [];
                }
                ret.remotes.push(parseBranch(br, 13));
            } else if (br[0].startsWith("refs/tags/")) {
                if (ret.tags === undefined) {
                    ret.tags = [];
                }
                ret.tags.push(parseBranch(br, 10));
            }
        }
        return ret;
    }
}
