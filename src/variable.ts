type EnvType = typeof process.env;

const envs: EnvType[] = [
    Object.assign({}, process.env)
];

export function push() {
    envs.push(Object.assign({}, envs[envs.length - 1]));
}

export function pop() {
    return envs.pop();
}

export function env() {
    return envs[envs.length - 1];
}
