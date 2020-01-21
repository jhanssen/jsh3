#include "utils.h"
#include <assert.h>
#include <memory>
#include <string>
#include <napi.h>
#include <uv.h>
#include <unistd.h>
#include <signal.h>
#include <pwd.h>
#include <sys/types.h>

struct {
    pid_t pid, pgid;
    bool is_interactive;
    struct termios tmodes;
} static state;

Napi::Value Start(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    state.pid = getpid();
    state.is_interactive = isatty(STDIN_FILENO) != 0;
    if (state.is_interactive) {
        while (tcgetpgrp(STDIN_FILENO) != (state.pgid = getpgrp()))
            kill(state.pid, SIGTTIN);

        setpgid(state.pid, state.pid);
        state.pgid = getpgrp();
        if (state.pgid != state.pid) {
            // more badness
            throw Napi::TypeError::New(env, "Unable to set process as group leader");
        }

        signal(SIGTSTP, SIG_IGN);
        signal(SIGTTIN, SIG_IGN);
        signal(SIGTTOU, SIG_IGN);

        if (tcsetpgrp(STDIN_FILENO, state.pgid) == -1) {
            throw Napi::TypeError::New(env, "Unable to set process group for terminal");
        }
        if (tcgetattr(STDIN_FILENO, &state.tmodes) == -1) {
            throw Napi::TypeError::New(env, "Unable to get terminal attributes for terminal");
        }
    } else {
        state.pgid = getpgrp();
    }

    auto obj = Napi::Object::New(env);
    obj.Set("pid", Napi::Number::New(env, state.pid));
    obj.Set("pgid", Napi::Number::New(env, state.pgid));
    obj.Set("interactive", Napi::Boolean::New(env, state.is_interactive));

    return obj;
}

Napi::Value Stop(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    return env.Undefined();
}

void Restore(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!state.is_interactive) {
        throw Napi::TypeError::New(env, "Can't restore state for non-interactive shell");
    }
    if (tcsetpgrp(STDIN_FILENO, state.pgid) == -1) {
        throw Napi::TypeError::New(env, "Unable to set process group for terminal");
    }
    int mode = TCSADRAIN;
    if (info[0].IsString()) {
        const auto& str = info[0].As<Napi::String>().Utf8Value();
        if (str == "now") {
            mode = TCSANOW;
        } else if (str == "drain") {
            mode = TCSADRAIN;
        } else if (str == "flush") {
            mode = TCSAFLUSH;
        } else {
            throw Napi::TypeError::New(env, "Invalid mode for restore");
        }
    }

    if (tcsetattr(STDIN_FILENO, mode, &state.tmodes) == -1) {
        throw Napi::TypeError::New(env, "Unable to set terminal attributes for terminal");
    }
}

Napi::Object Setup(Napi::Env env, Napi::Object exports)
{
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("restore", Napi::Function::New(env, Restore));
    return exports;
}

NODE_API_MODULE(shell_native, Setup)
