#include "utils.h"
#include <mutex>
#include <thread>
#include <string>
#include <vector>
#include <memory>
#include <napi.h>
#include <uv.h>
#include <unistd.h>
#include <sys/select.h>

struct AsyncPromise
{
    AsyncPromise(Napi::Promise::Deferred&& d, Napi::AsyncContext&& c)
        : promise(std::move(d)), ctx(std::move(c))
    {
    }
    Napi::Promise::Deferred promise;
    Napi::AsyncContext ctx;
};

struct BufferEmitter
{
    Queue<std::string> queue;
    std::vector<std::string> pending;

    struct Async
    {
        Async(Napi::FunctionReference&& f, Napi::AsyncContext&& c)
            : listener(std::move(f)), ctx(std::move(c))
        {
        }
        Napi::FunctionReference listener;
        Napi::AsyncContext ctx;
    };
    std::shared_ptr<Async> async;

    void emit(const std::string& data);
};

struct Process
{
    std::string cmd;
    std::vector<std::string> args;
    std::vector<std::pair<std::string, std::string> > env;

    std::shared_ptr<BufferEmitter> emitStdin, emitStdout;

    int stdin;
    int stdout, stderr;
    pid_t pid;
    int status { -1 };
    bool running { false };

    std::unique_ptr<AsyncPromise> promise;
};

struct Reader
{
    Reader();

    uv_async_t async;
    std::mutex mutex;
    std::thread thread;
    std::vector<std::shared_ptr<BufferEmitter> > pendingemitters;
    std::vector<std::shared_ptr<Process> > newprocs, procs, doneprocs;
    int sigpipe[2];
    int wakeuppipe[2];

    static void handleSignal(int sig);
    void handleSigChld();

    void start(const Napi::Env& env);
    void stop(const Napi::Env& env);

    void add(const std::shared_ptr<Process>& proc);
};

static Reader reader;

Reader::Reader()
{
    sigpipe[0] = sigpipe[1] = -1;
    wakeuppipe[0] = wakeuppipe[1] = -1;
}

void Reader::add(const std::shared_ptr<Process>& proc)
{
    int e;
    char c = 'n';
    std::unique_lock<std::mutex> locker(mutex);
    newprocs.push_back(proc);
    EINTRWRAP(e, ::write(wakeuppipe[1], &c, 1));
}

void Reader::start(const Napi::Env& env)
{
    if (sigpipe[0] != -1) {
        throw Napi::TypeError::New(env, "Reader already started");
    }
    int r = pipe(sigpipe);
    if (r == -1) {
        // badness
        sigpipe[0] = sigpipe[1] = -1;
        throw Napi::TypeError::New(env, "Failed to create sig pipe");
    }
    r = fcntl(sigpipe[0], F_GETFL);
    if (r == -1) {
        // horribleness
        close(sigpipe[0]);
        close(sigpipe[1]);
        sigpipe[0] = sigpipe[1] = -1;
        throw Napi::TypeError::New(env, "Failed to get sig flags");
    }
    fcntl(sigpipe[0], F_SETFL, r | O_NONBLOCK);

    r = pipe(wakeuppipe);
    if (r == -1) {
        // badness
        wakeuppipe[0] = wakeuppipe[1] = -1;
        throw Napi::TypeError::New(env, "Failed to create wakeup pipe");
    }
    r = fcntl(wakeuppipe[0], F_GETFL);
    if (r == -1) {
        // horribleness
        close(wakeuppipe[0]);
        close(wakeuppipe[1]);
        wakeuppipe[0] = wakeuppipe[1] = -1;
        throw Napi::TypeError::New(env, "Failed to get wakeup flags");
    }
    fcntl(wakeuppipe[0], F_SETFL, r | O_NONBLOCK);

    signal(SIGCHLD, handleSignal);

    uv_async_init(uv_default_loop(), &async,
                  [](uv_async_t*) {
                      std::vector<std::shared_ptr<Process> > dp;
                      std::vector<std::shared_ptr<BufferEmitter> > pe;
                      {
                          std::unique_lock<std::mutex> locker(reader.mutex);
                          std::swap(dp, reader.doneprocs);
                          std::swap(pe, reader.pendingemitters);
                      }
                      for (const auto& p : dp) {
                          auto env = p->promise->promise.Env();
                          Napi::HandleScope scope(env);
                          Napi::CallbackScope callback(env, p->promise->ctx);

                          p->promise->promise.Resolve(Napi::Number::New(env, p->status));
                      }
                      for (const auto& e : pe) {
                          if (e->async) {
                              auto env = e->async->listener.Env();
                              Napi::HandleScope scope(env);
                              std::string str;
                              for (;;) {
                                  if (!e->queue.pop(str))
                                      break;
                                  e->async->listener.MakeCallback(e->async->listener.Value(), { Napi::Buffer<char>::New(env, &str[0], str.size()) }, e->async->ctx);
                              }
                          } else {
                              std::string str;
                              for (;;) {
                                  if (!e->queue.pop(str))
                                      break;
                                  e->pending.push_back(std::move(str));
                              }
                          }
                      }
                  });

    thread = std::thread([this]() {
                 fd_set rdfds;
                 const int pmax = std::max(wakeuppipe[0], sigpipe[0]);
                 int e;
                 for (;;) {
                     FD_ZERO(&rdfds);
                     FD_SET(wakeuppipe[0], &rdfds);
                     FD_SET(sigpipe[0], &rdfds);

                     bool newproc = false;

                     {
                         std::unique_lock<std::mutex> locker(mutex);
                         if (!newprocs.empty()) {
                             procs.reserve(newprocs.size() + procs.size());
                             std::move(std::begin(newprocs), std::end(newprocs), std::back_inserter(procs));
                             newprocs.clear();
                             newproc = true;
                         }
                     }

                     if (newproc) {
                         // make sure that our new processes are still alive
                         handleSigChld();
                     }

                     int max = pmax;
                     for (const auto& proc : procs) {
                         if (proc->stdout != -1) {
                             FD_SET(proc->stdout, &rdfds);
                             if (proc->stdout > max)
                                 max = proc->stdout;
                         }
                         if (proc->stderr != -1) {
                             FD_SET(proc->stderr, &rdfds);
                             if (proc->stderr > max)
                                 max = proc->stderr;
                         }
                     }

                     EINTRWRAP(e, ::select(max + 1, &rdfds, nullptr, nullptr, nullptr));
                     if (e > 0) {
                         if (FD_ISSET(wakeuppipe[0], &rdfds)) {
                             // deal with wakeup data
                             unsigned char w;
                             EINTRWRAP(e, ::read(sigpipe[0], &w, 1));
                             if (e == 1) {
                             }
                         }
                         if (FD_ISSET(sigpipe[0], &rdfds)) {
                             // deal with signal data
                             unsigned char s;
                             EINTRWRAP(e, ::read(sigpipe[0], &s, 1));
                             if (e == 1 && s == SIGCHLD) {
                                 handleSigChld();
                             }
                         }
                         for (const auto& proc : procs) {
                             if (proc->stdout != -1 && FD_ISSET(proc->stdout, &rdfds)) {
                                 // deal with proc stdout
                             }
                             if (proc->stderr != -1 && FD_ISSET(proc->stderr, &rdfds)) {
                                 // deal with proc stderr
                             }
                         }
                     } else if (e < 0) {
                         // bad
                     }
                 }
             });
}

void Reader::stop(const Napi::Env& env)
{
    if (sigpipe[0] == -1) {
        throw Napi::TypeError::New(env, "Reader already stopped");
    }

    int e;
    EINTRWRAP(e, ::close(sigpipe[0]));
    EINTRWRAP(e, ::close(sigpipe[1]));
    sigpipe[0] = sigpipe[1] = -1;
}

void Reader::handleSigChld()
{
    int status;
    pid_t w;
    for (const auto& proc : procs) {
        EINTRWRAP(w, waitpid(proc->pid, &status, WNOHANG | WUNTRACED));
        if (w > 0) {
            proc->running = false;
            proc->status = status;
            if (proc->stdout == -1 && proc->stderr == -1) {
                // all done, notify js
                std::unique_lock<std::mutex> locker(mutex);
                doneprocs.push_back(proc);
                uv_async_send(&async);
            }
        }
    }
}

void Reader::handleSignal(int sig)
{
    int e;
    unsigned char csig = sig;
    EINTRWRAP(e, ::write(reader.sigpipe[1], &csig, 1));
}

void Listen(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!info[0].IsObject()) {
        throw Napi::TypeError::New(env, "First argument needs to be a ctx");
    }

    auto emitter = Wrap<std::shared_ptr<BufferEmitter> >::unwrap(info[0]);
    if (!emitter) {
        throw Napi::TypeError::New(env, "First argument is not a ctx");
    }

    if (!info[1].IsFunction() && !info[1].IsUndefined()) {
        throw Napi::TypeError::New(env, "Second argument needs to be a function or undefined");
    }

    if (info[1].IsFunction()) {
        if (emitter->async) {
            throw Napi::TypeError::New(env, "Emitter already got a listener");
        }
        emitter->async = std::make_shared<BufferEmitter::Async>(Napi::Persistent(info[1].As<Napi::Function>()), Napi::AsyncContext(env, "bufferEmitter"));
        if (!emitter->pending.empty()) {
            for (auto& str : emitter->pending) {
                emitter->async->listener.Call(emitter->async->listener.Value(), { Napi::Buffer<char>::New(env, &str[0], str.size()) });
            }
            emitter->pending.clear();
        }
    } else {
        emitter->async.reset();
    }
}

static Napi::Object launchProcess(const Napi::Env& env, std::shared_ptr<Process>& proc)
{
    // we'll need to notify the parent if we can't exec,
    // create a pipe with CLOEXEC and write to it if
    // we fail

    proc->promise = std::make_unique<AsyncPromise>(Napi::Promise::Deferred::New(env), Napi::AsyncContext(env, "process"));
    auto promise = proc->promise->promise.Promise();

    int runpipe[2];
    ::pipe(runpipe);
    fcntl(runpipe[1], F_SETFD, fcntl(runpipe[1], F_GETFD) | FD_CLOEXEC);

    int stdinpipe[2];
    ::pipe(stdinpipe);

    int stdoutpipe[2];
    ::pipe(stdoutpipe);

    int stderrpipe[2];
    ::pipe(stderrpipe);

    int e;

    const pid_t pid = fork();
    if (pid == 0) {
        // child

        EINTRWRAP(e, ::close(runpipe[0]));
        EINTRWRAP(e, ::close(stdinpipe[1]));
        EINTRWRAP(e, ::close(stdoutpipe[0]));
        EINTRWRAP(e, ::close(stderrpipe[0]));

        signal(SIGINT, SIG_DFL);
        signal(SIGQUIT, SIG_DFL);
        signal(SIGTSTP, SIG_DFL);
        signal(SIGTTIN, SIG_DFL);
        signal(SIGTTOU, SIG_DFL);
        signal(SIGCHLD, SIG_DFL);

        EINTRWRAP(e, dup2(stdinpipe[0], STDIN_FILENO));
        EINTRWRAP(e, ::close(stdinpipe[0]));
        EINTRWRAP(e, dup2(stdoutpipe[1], STDOUT_FILENO));
        EINTRWRAP(e, ::close(stdoutpipe[1]));
        EINTRWRAP(e, dup2(stderrpipe[1], STDERR_FILENO));
        EINTRWRAP(e, ::close(stderrpipe[1]));

        const char** argv = reinterpret_cast<const char**>(malloc((proc->args.size() + 2) * sizeof(char*)));
        argv[0] = strdup(proc->cmd.c_str());
        argv[proc->args.size() + 1] = 0;
        int idx = 0;
        for (const std::string& arg : proc->args) {
            argv[++idx] = strdup(arg.c_str());
        }

        char** envp = reinterpret_cast<char**>(malloc((proc->env.size() + 1) * sizeof(char*)));
        envp[proc->env.size()] = 0;
        idx = 0;
        for (const auto& env : proc->env) {
            envp[idx++] = strdup((env.first + "=" + env.second).c_str());
        }

        execve(proc->cmd.c_str(), const_cast<char*const*>(argv), envp);

        // notify parent
        char c = 1;
        EINTRWRAP(e, ::write(runpipe[1], &c, 1));
        EINTRWRAP(e, ::close(runpipe[1]));

        exit(-1);
    } else if (pid > 0) {
        // parent

        EINTRWRAP(e, ::close(stdinpipe[0]));
        EINTRWRAP(e, ::close(stdoutpipe[1]));
        EINTRWRAP(e, ::close(stderrpipe[1]));

        bool ok = true;
        EINTRWRAP(e, ::close(runpipe[1]));
        fd_set rdfds;
        for (;;) {
            FD_ZERO(&rdfds);
            FD_SET(runpipe[0], &rdfds);
            EINTRWRAP(e, ::select(runpipe[0] + 1, &rdfds, 0, 0, 0));
            if (e == -1) {
                // not good
                ok = false;
                break;
            } else if (e > 0 && FD_ISSET(runpipe[0], &rdfds)) {
                char c;
                EINTRWRAP(e, ::read(runpipe[0], &c, 1));
                if (e == -1 || e == 1) {
                    // job went bad
                    ok = false;
                }
                EINTRWRAP(e, ::close(runpipe[0]));
                break;
            }
        }

        if (!ok) {
            EINTRWRAP(e, ::close(stdinpipe[1]));
            EINTRWRAP(e, ::close(stdoutpipe[0]));
            EINTRWRAP(e, ::close(stderrpipe[0]));

            proc->promise->promise.Reject(Napi::String::New(env, "Failed to launch process"));
            proc.reset();
        } else {
            // add this process to our read list
            proc->stdin = stdinpipe[1];
            proc->stdout = stdoutpipe[0];
            proc->stderr = stderrpipe[0];
            proc->pid = pid;
            proc->running = true;

            proc->emitStdin = std::make_shared<BufferEmitter>();
            proc->emitStdout = std::make_shared<BufferEmitter>();

            reader.add(proc);
        }
    } else {
        // error
    }

    auto obj = Napi::Object::New(env);
    if (proc) {
        obj.Set("stdinCtx", Wrap<std::shared_ptr<BufferEmitter> >::wrap(env, proc->emitStdin));
        obj.Set("stdoutCtx", Wrap<std::shared_ptr<BufferEmitter> >::wrap(env, proc->emitStdout));
        obj.Set("listen", Napi::Function::New(env, Listen));
    }
    obj.Set("promise", promise);

    return obj;
}

void Start(const Napi::CallbackInfo& info)
{
    reader.start(info.Env());
}

void Stop(const Napi::CallbackInfo& info)
{
    reader.stop(info.Env());
}

Napi::Value Launch(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!info[0].IsString()) {
        throw Napi::TypeError::New(env, "First argument needs to be a string");
    }

    auto proc = std::make_shared<Process>();
    proc->cmd = info[0].As<Napi::String>().Utf8Value();

    if (info[1].IsArray()) {
        std::vector<std::string> args;
        const auto array = info[1].As<Napi::Array>();
        for (size_t i = 0; i < array.Length(); ++i) {
            args.push_back(array.Get(i).As<Napi::String>().Utf8Value());
        }
        proc->args = std::move(args);
    }
    if (info[2].IsObject()) {
        std::vector<std::pair<std::string, std::string> > env;
        const auto obj = info[2].As<Napi::Object>();
        const auto props = obj.GetPropertyNames();
        for (size_t i = 0; i < props.Length(); ++i) {
            const auto k = props.Get(i);
            const auto v = obj.Get(k);
            env.push_back(std::make_pair(k.As<Napi::String>().Utf8Value(), v.As<Napi::String>().Utf8Value()));
        }
        proc->env = std::move(env);
    }

    return launchProcess(env, proc);
}

Napi::Object Setup(Napi::Env env, Napi::Object exports)
{
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("launch", Napi::Function::New(env, Launch));
    return exports;
}

NODE_API_MODULE(process_native, Setup)