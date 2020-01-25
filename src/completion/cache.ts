import { join } from "path";

const items: Map<string, any> = new Map<string, any>();

export namespace cache {
    export function set(key: string, data: any): void;
    export function set(key: string, path: string, data: any): void;

    export function set(key: string, path: string | any, data?: any) {
        if (data !== undefined) {
            items.set(join(key, path), data);
        } else {
            items.set(key, path);
        }
    }

    export function get(key: string, path?: string): any | undefined {
        if (typeof path === "string") {
            return items.get(join(key, path));
        } else {
            return items.get(key);
        }
    }

    export function clear() {
        items.clear();
    }
}
