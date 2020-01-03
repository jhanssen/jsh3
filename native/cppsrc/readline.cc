#include "Redirector.h"
#include "utils.h"
#include <assert.h>
#include <memory>
#include <string>
#include <napi.h>
#include <uv.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <unistd.h>
#include <readline/readline.h>
#include <readline/history.h>

struct State
{
    Redirector redirector;
    uv_thread_t thread;
    uv_signal_t winch;
    int wakeupPipe[2];
    bool running { false };
    bool stopped { false };
    bool paused { false };
    bool pendingProcessTasks { false };
    Napi::FunctionReference callback;
    std::unique_ptr<Napi::AsyncContext> ctx;
    std::string historyFile;
    std::string prompt { "jsh3> " };

    enum class WakeupReason { Stop, Task, Complete, Winch };
    void wakeup(WakeupReason reason);

    struct {
        uv_async_t async;
        Queue<std::string> lines;
    } readline;

    struct {
        uv_async_t async;
        struct {
            std::string buffer;
            std::string text;
            int start, end;
        } pending;
        std::vector<std::string> results;
        bool inComplete { false };
        Mutex mutex;
    } completion;

    static void run(void* arg);
    static void lineHandler(char* line);
    static char** completer(const char* text, int start, int end);

    void readlineInit();
    void readlineDeinit();

    // pause state
    char* savedLine { nullptr };
    int savedPoint { 0 };

    void saveState();
    void restoreState();

    struct AsyncPromise
    {
        AsyncPromise(Napi::Promise::Deferred&& d, Napi::AsyncContext&& c)
            : promise(std::move(d)), ctx(std::move(c))
        {
        }
        Napi::Promise::Deferred promise;
        Napi::AsyncContext ctx;
    };

    struct TaskQuery
    {
        std::unique_ptr<AsyncPromise> promise;
        Variant argument;
        std::function<Variant(const Variant&)> task;
    };
    struct TaskReply
    {
        std::unique_ptr<AsyncPromise> promise;
        bool success;
        Variant value;
    };
    struct {
        uv_async_t async;
        Queue<TaskQuery> queries;
        Queue<TaskReply> replies;
    } tasks;

    Napi::Promise runTask(Napi::Env& env, const Napi::Value& argument,
                          std::function<Variant(const Variant&)>&& task);
};

static State state;

// handle utf-8
#define ADVANCE_CHAR(_str, _strsize, _i)        \
    do {                                        \
        if (_i + 1 <= _strsize) {               \
            if (_str[++_i] & 0x10000000)        \
                continue;                       \
        } else if (_i == _strsize) {            \
            ++_i;                               \
        }                                       \
    }                                           \
    while (0)

// ugh, maybe we should delegate this to js?
// also, how many times have I written this code now?
int char_is_quoted(char* string, int eindex)
{
    enum State {
        Normal,
        Double,
        Single,
        Escape
    };
    bool wasEscaped = false;
    std::vector<State> state;
    state.push_back(Normal);
    auto current = [&state]() {
                       return state.back();
                   };
    auto maybePop = [&state](State s) {
                        if (state.back() == s) {
                            state.pop_back();
                            return true;
                        }
                        return false;
                    };
    for (int i = 0; i <= eindex;) {
        wasEscaped = current() == Escape;
        switch (string[i]) {
        case '\\':
            switch (current()) {
            case Escape:
                state.pop_back();
                break;
            default:
                state.push_back(Escape);
                break;
            }
            break;
        case '"':
            switch (current()) {
            case Normal:
                state.push_back(Double);
                break;
            case Double:
                state.pop_back();
                break;
            default:
                break;
            }
            maybePop(Escape);
            break;
        case '\'':
            switch (current()) {
            case Normal:
                state.push_back(Single);
                break;
            case Single:
                state.pop_back();
                break;
            default:
                break;
            }
            maybePop(Escape);
            break;
        default:
            maybePop(Escape);
            break;
        }

        ADVANCE_CHAR(string, eindex, i);
    }
    //printf("got state %d for %d (%c - '%s')\n", eindex, string[eindex], string);
    return (!wasEscaped && current() == Normal) ? 0 : 1;
}

void State::saveState()
{
    if (state.savedLine)
        return;
    state.savedPoint = rl_point;
    state.savedLine = rl_copy_text(0, rl_end);
    rl_save_prompt();
    rl_replace_line("", 0);
    rl_redisplay();
}

void State::restoreState()
{
    if (!state.savedLine)
        return;
    rl_restore_prompt();
    rl_replace_line(state.savedLine, 0);
    rl_point = state.savedPoint;
    rl_redisplay();
    free(state.savedLine);
    state.savedLine = 0;
}

static void handleOut(int fd, const std::function<void(const char*, int)>& write)
{
    bool saved = false;

    // read until the end of time
    char buf[16384];
    for (;;) {
        const ssize_t r = read(fd, buf, sizeof(buf));
        if (r == -1) {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                break;
            if (errno == EINTR)
                continue;
            // badness!
            return;
        } else if (!r) {
            // done?
            break;
        } else {
            if (!saved) {
                state.saveState();
                saved = true;
            }
            write(buf, r);
        }
    }

    if (saved) {
        state.restoreState();
    }
}

void State::wakeup(WakeupReason reason)
{
    int e;
    char r = static_cast<char>(reason);
    EINTRWRAP(e, ::write(state.wakeupPipe[1], &r, 1));
}

void State::lineHandler(char* line)
{
    if (!line) {
        // we're done
        state.stopped = true;
        return;
    }
    state.readline.lines.push(line);
    uv_async_send(&state.readline.async);

    free(line);
}

char** State::completer(const char* text, int start, int end)
{
    {
        MutexLocker locker(&state.completion.mutex);
        state.completion.inComplete = true;
        state.completion.pending = { std::string(rl_line_buffer), std::string(text), start, end };
        uv_async_send(&state.completion.async);
    }

    // ### if we want file completion, just return nullptr before setting this variable
    rl_attempted_completion_over = 1;

    // we want full control over the output
    rl_completion_suppress_append = 1;
    rl_completion_suppress_quote = 1;

    const int max = state.wakeupPipe[0];
    fd_set rdset;
    for (;;) {
        FD_ZERO(&rdset);
        FD_SET(state.wakeupPipe[0], &rdset);

        int r = select(max + 1, &rdset, 0, 0, 0);
        if (r <= 0) {
            // boo
            return nullptr;
        }

        if (FD_ISSET(state.wakeupPipe[0], &rdset)) {
            char c;
            for (;;) {
                EINTRWRAP(r, read(state.wakeupPipe[0], &c, 1));
                if (r == -1)
                    break;
                if (r == 1) {
                    const WakeupReason reason = static_cast<WakeupReason>(c);
                    switch (reason) {
                    case WakeupReason::Stop:
                        state.stopped = true;
                        break;
                    case WakeupReason::Task:
                        state.pendingProcessTasks = true;
                        break;
                    case WakeupReason::Complete: {
                        MutexLocker locker(&state.completion.mutex);
                        assert(!state.completion.inComplete);
                        if (!state.completion.results.empty()) {
                            char** array = static_cast<char**>(malloc((2 + state.completion.results.size()) * sizeof(*array)));
                            array[0] = strdup(longest_common_prefix(text, state.completion.results).c_str());
                            size_t ptr = 1;
                            for (const auto& m : state.completion.results) {
                                array[ptr++] = strdup(m.c_str());
                            }
                            array[ptr] = nullptr;
                            return array;
                        }
                        return nullptr; }
                    case WakeupReason::Winch:
                        rl_resize_terminal();
                        break;
                    }
                }
            }
        }
    }

    return nullptr;
}

void State::readlineInit()
{
    rl_initialize();
    rl_resize_terminal();

    rl_callback_handler_install(state.prompt.c_str(), lineHandler);

    using_history();
}

void State::readlineDeinit()
{
    rl_callback_handler_remove();
}

void State::run(void*)
{
    auto processTasks = []() {
                            TaskQuery query;
                            for (;;) {
                                if (!state.tasks.queries.pop(query))
                                    break;
                                const auto ret = query.task(query.argument);
                                state.tasks.replies.push({ std::move(query.promise), true, std::move(ret) });
                                uv_async_send(&state.tasks.async);
                            }
                        };

    state.stopped = false;

    rl_persistent_signal_handlers = 0;
    rl_catch_signals = 0;
    rl_catch_sigwinch = 0;
    rl_change_environment = 0;
    rl_outstream = state.redirector.stderrFile();

    rl_char_is_quoted_p = char_is_quoted;
    rl_completer_quote_characters = "'\"";

    rl_attempted_completion_function = completer;

    state.readlineInit();

    fd_set rdset;

    const int stdoutfd = state.redirector.stdout();
    const int stderrfd = state.redirector.stderr();

    const auto stdoutfunc = std::bind(&Redirector::writeStdout, &state.redirector, std::placeholders::_1, std::placeholders::_2);
    const auto stderrfunc = std::bind(&Redirector::writeStderr, &state.redirector, std::placeholders::_1, std::placeholders::_2);

    int max = STDIN_FILENO;
    if (state.wakeupPipe[0] > max)
        max = state.wakeupPipe[0];
    if (stdoutfd > max)
        max = stdoutfd;
    if (stderrfd > max)
        max = stderrfd;

    for (;;) {
        FD_ZERO(&rdset);
        if (!state.paused) {
            FD_SET(STDIN_FILENO, &rdset);
            FD_SET(stdoutfd, &rdset);
            FD_SET(stderrfd, &rdset);
        }
        FD_SET(state.wakeupPipe[0], &rdset);

        int r = select(max + 1, &rdset, 0, 0, 0);
        if (r <= 0) {
            // boo
            break;
        }

        if (FD_ISSET(state.wakeupPipe[0], &rdset)) {
            char c;
            for (;;) {
                EINTRWRAP(r, read(state.wakeupPipe[0], &c, 1));
                if (r == -1)
                    break;
                if (r == 1) {
                    const WakeupReason reason = static_cast<WakeupReason>(c);
                    switch (reason) {
                    case WakeupReason::Stop:
                        state.stopped = true;
                        break;
                    case WakeupReason::Task:
                        processTasks();
                        break;
                    case WakeupReason::Complete:
                        break;
                    case WakeupReason::Winch:
                        rl_resize_terminal();
                        break;
                    }
                }
            }
        }
        if (!state.paused) {
            if (FD_ISSET(stdoutfd, &rdset)) {
                handleOut(stdoutfd, stdoutfunc);
            }
            if (FD_ISSET(stderrfd, &rdset)) {
                handleOut(stderrfd, stderrfunc);
            }
            if (FD_ISSET(STDIN_FILENO, &rdset)) {
                // read until we have nothing more to read
                if (r == -1) {
                    // ugh
                    break;
                }
                bool error = false;
                int rem;
                for (;;) {
                    rl_callback_read_char();
                    // loop while we have more characters
                    if (ioctl(STDIN_FILENO, FIONREAD, &rem) == -1) {
                        // ugh
                        error = true;
                        break;
                    }
                    if (!rem)
                        break;
                }
                if (error)
                    break;
            }
        }
        if (state.pendingProcessTasks) {
            state.pendingProcessTasks = false;
            processTasks();
        }
        if (state.stopped) {
            break;
        }
    }
}

Napi::Promise State::runTask(Napi::Env& env,
                             const Napi::Value& arg,
                             std::function<Variant(const Variant&)>&& task)
{
    auto deferred = Napi::Promise::Deferred::New(env);
    auto promise = deferred.Promise();
    Napi::AsyncContext ctx(env, "runTask");
    state.tasks.queries.push({
            std::make_unique<AsyncPromise>(std::move(deferred), std::move(ctx)),
            toVariant(arg),
            std::move(task)
        });
    state.wakeup(WakeupReason::Task);
    return promise;
}

void Complete(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!info[0].IsArray() && !info[0].IsUndefined()) {
        throw Napi::TypeError::New(env, "First argument needs to be an array of strings or undefined");
    }

    MutexLocker locker(&state.completion.mutex);
    if (!state.completion.inComplete) {
        throw Napi::TypeError::New(env, "Not completing");
    }
    state.completion.inComplete = false;
    state.completion.results.clear();

    if (info[0].IsArray()) {
        const auto arr = info[0].As<Napi::Array>();

        state.completion.results.reserve(arr.Length());

        for (size_t i = 0; i < arr.Length(); ++i) {
            state.completion.results.push_back(arr.Get(i).As<Napi::String>().Utf8Value());
        }
    }

    state.wakeup(State::WakeupReason::Complete);
}

Napi::Value Start(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (state.running) {
        return env.Undefined();
    }

    int r = pipe(state.wakeupPipe);
    if (r == -1) {
        // badness
        state.wakeupPipe[0] = state.wakeupPipe[1] = -1;
        throw Napi::TypeError::New(env, "Failed to create wakeup pipe");
    }
    r = fcntl(state.wakeupPipe[0], F_GETFL);
    if (r == -1) {
        // horribleness
        close(state.wakeupPipe[0]);
        close(state.wakeupPipe[1]);
        state.wakeupPipe[0] = state.wakeupPipe[1] = -1;
        throw Napi::TypeError::New(env, "Failed to get wakeup flags");
    }
    fcntl(state.wakeupPipe[0], F_SETFL, r | O_NONBLOCK);

    if (!info[0].IsFunction()) {
        throw Napi::TypeError::New(env, "First argument needs to be a callback function");
    }
    state.callback = Napi::Persistent(info[0].As<Napi::Function>());

    state.ctx = std::make_unique<Napi::AsyncContext>(env, "ReadlineAsync");

    auto handleAsync = [](uv_async_t* async) {
        if (async == &state.readline.async) {
            std::vector<std::string> data;
            std::string line;
            for (;;) {
                if (!state.readline.lines.pop(line))
                    break;
                data.push_back(std::move(line));
            }

            auto env = state.ctx->Env();

            Napi::HandleScope scope(env);

            Napi::Array lines = Napi::Array::New(env, data.size());
            for (size_t i = 0; i < data.size(); ++i) {
                lines.Set(i, data[i]);
            }

            Napi::Object obj = Napi::Object::New(env);
            obj.Set("type", "lines");
            obj.Set("lines", lines);

            try {
                state.callback.MakeCallback(state.callback.Value(), { obj }, *state.ctx);
            } catch (const Napi::Error& e) {
                printf("line callback: exception from js: %s\n%s\n", e.what(), e.Message().c_str());
            }
        } else if (async == &state.tasks.async) {
            State::TaskReply reply;
            for (;;) {
                if (!state.tasks.replies.pop(reply))
                    break;
                auto env = reply.promise->promise.Env();
                Napi::HandleScope scope(env);
                Napi::CallbackScope callback(env, reply.promise->ctx);

                try {
                    if (reply.success) {
                        reply.promise->promise.Resolve(fromVariant(env, reply.value));
                    } else {
                        reply.promise->promise.Reject(fromVariant(env, reply.value));
                    }
                } catch (const Napi::Error& e) {
                    printf("promise callback: exception from js: %s\n%s\n", e.what(), e.Message().c_str());
                }
            }
        } else if (async == &state.completion.async) {
            auto env = state.ctx->Env();

            Napi::HandleScope scope(env);

            Napi::Object obj = Napi::Object::New(env);
            Napi::Object comp = Napi::Object::New(env);
            {
                MutexLocker locker(&state.completion.mutex);
                comp.Set("buffer", Napi::String::New(env, state.completion.pending.buffer));
                comp.Set("text", Napi::String::New(env, state.completion.pending.text));
                comp.Set("start", Napi::Number::New(env, state.completion.pending.start));
                comp.Set("end", Napi::Number::New(env, state.completion.pending.end));
                comp.Set("complete", Napi::Function::New(env, Complete));
            }
            obj.Set("type", "completion");
            obj.Set("completion", comp);

            try {
                state.callback.MakeCallback(state.callback.Value(), { obj }, *state.ctx);
            } catch (const Napi::Error& e) {
                printf("complete callback: exception from js: %s\n%s\n", e.what(), e.Message().c_str());
            }
        }
    };

    uv_async_init(uv_default_loop(), &state.readline.async, handleAsync);
    uv_async_init(uv_default_loop(), &state.tasks.async, handleAsync);
    uv_async_init(uv_default_loop(), &state.completion.async, handleAsync);

    uv_signal_init(uv_default_loop(), &state.winch);
    uv_signal_start(&state.winch, [](uv_signal_t*, int) {
                                      state.wakeup(State::WakeupReason::Winch);
                                  }, SIGWINCH);

    uv_thread_create(&state.thread, State::run, 0);
    state.running = true;

    return env.Undefined();
}

void Stop(const Napi::CallbackInfo& info)
{
    state.wakeup(State::WakeupReason::Stop);
    uv_thread_join(&state.thread);
}

Napi::Value Pause(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    return state.runTask(env, env.Undefined(),
                         [](const Variant& arg) -> Variant {
                             if (state.paused)
                                 return Undefined;
                             state.paused = true;
                             rl_set_prompt("");
                             rl_replace_line("", 0);
                             rl_redisplay();
                             state.redirector.quiet();
                             state.readlineDeinit();
                             return Undefined;
                         });
}

Napi::Value Resume(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    return state.runTask(env, env.Undefined(),
                         [](const Variant& arg) -> Variant {
                             if (!state.paused)
                                 return Undefined;
                             state.paused = false;
                             state.redirector.resume();
                             state.readlineInit();
                             return Undefined;
                         });
}

Napi::Value Clear(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    return state.runTask(env, env.Undefined(),
                         [](const Variant& arg) -> Variant {
                             rl_callback_sigcleanup();

                             if (rl_undo_list)
                                 rl_free_undo_list ();
                             rl_clear_message();
                             rl_crlf();
                             rl_point = rl_mark = 0;
                             rl_kill_text (rl_point, rl_end);
                             rl_mark = 0;
                             rl_reset_line_state();
                             return Undefined;
                         });
}

Napi::Value SetPrompt(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!info[0].IsString()) {
        throw Napi::TypeError::New(env, "First argument needs to be a string");
    }

    return state.runTask(env, info[0],
                         [](const Variant& arg) -> Variant {
                             if (auto nstr = std::get_if<std::string>(&arg)) {
                                 state.prompt = *nstr;
                                 rl_set_prompt(nstr->c_str());
                                 rl_redisplay();
                             }
                             return Undefined;
                         });
}

Napi::Value AddHistory(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!info[0].IsString()) {
        throw Napi::TypeError::New(env, "First argument needs to be a string");
    }
    const bool write = info[1].IsBoolean() ? info[1].As<Napi::Boolean>().Value() : false;

    return state.runTask(env, info[0],
                         [write](const Variant& arg) -> Variant {
                             if (auto nstr = std::get_if<std::string>(&arg)) {
                                 auto cur = current_history();
                                 if (!cur) {
                                     // last one?
                                     cur = history_get(history_base + history_length - 1);
                                 }
                                 if (cur) {
                                     if (!strcmp(nstr->c_str(), cur->line))
                                         return Undefined;
                                 }
                                 add_history(nstr->c_str());
                                 history_set_pos(history_length);
                                 if (write && !state.historyFile.empty())
                                     write_history(state.historyFile.c_str());
                             }
                             return Undefined;
                         });
}

Napi::Value ReadHistory(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!info[0].IsString()) {
        throw Napi::TypeError::New(env, "First argument needs to be a string");
    }

    return state.runTask(env, info[0],
                         [](const Variant& arg) -> Variant {
                             if (auto nstr = std::get_if<std::string>(&arg)) {
                                 state.historyFile = *nstr;
                                 const int ret = read_history(nstr->c_str());
                                 if (!ret) {
                                     using_history();
                                 }
                             }
                             return Undefined;
                         });
}

Napi::Value WriteHistory(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!info[0].IsString()) {
        throw Napi::TypeError::New(env, "First argument needs to be a string");
    }

    return state.runTask(env, info[0],
                         [](const Variant& arg) -> Variant {
                             if (auto nstr = std::get_if<std::string>(&arg)) {
                                 state.historyFile = *nstr;
                                 write_history(nstr->c_str());
                             }
                             return Undefined;
                         });
}

Napi::Object Setup(Napi::Env env, Napi::Object exports)
{
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("pause", Napi::Function::New(env, Pause));
    exports.Set("resume", Napi::Function::New(env, Resume));
    exports.Set("clear", Napi::Function::New(env, Clear));
    exports.Set("setPrompt", Napi::Function::New(env, SetPrompt));
    exports.Set("addHistory", Napi::Function::New(env, AddHistory));
    exports.Set("readHistory", Napi::Function::New(env, ReadHistory));
    exports.Set("writeHistory", Napi::Function::New(env, WriteHistory));
    return exports;
}

NODE_API_MODULE(readline_native, Setup)
