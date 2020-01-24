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
    const stats = await pstat(path);
    return !!(stats.isFile() && ((uid === stats.uid && stats.mode & 0o500)
                                 || (gids.includes(stats.gid) && stats.mode & 0o050)
                                 || (stats.mode & 0o005)));
}
