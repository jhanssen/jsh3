#include "utils.h"
#include <mutex>
#include <thread>
#include <string>
#include <deque>
#include <vector>
#include <memory>
#include <napi.h>
#include <uv.h>
#include <grp.h>
#include <unistd.h>
#include <sys/select.h>
#include <sys/wait.h>

struct AsyncPromise
{
    AsyncPromise(Napi::Promise::Deferred&& d, Napi::AsyncContext&& c)
        : promise(std::move(d)), ctx(std::move(c))
    {
    }
    Napi::Promise::Deferred promise;
    Napi::AsyncContext ctx;
};

struct ProcessOptions
{
    bool redirectStdin;
    bool redirectStdout;
    bool redirectStderr;
};

struct BufferEmitter : public std::enable_shared_from_this<BufferEmitter>
{
    struct Data
    {
        char* data;
        size_t size;
    };
    Queue<Data> queue;
    std::vector<Data> pending;

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

    static Napi::Value makeBuffer(const Napi::Env& env, char* str, size_t size);

    void emit(char* data, size_t size);
};

inline Napi::Value BufferEmitter::makeBuffer(const Napi::Env& env, char* str, size_t size)
{
    return Napi::Buffer<char>::New(env, str, size, [](const Napi::Env&, char* d) { free(d); });
}

struct Process
{
    std::string cmd;
    std::vector<std::string> args;
    std::vector<std::pair<std::string, std::string> > env;

    std::shared_ptr<BufferEmitter> emitStdout, emitStderr;

    int stdin;
    int stdout, stderr;
    pid_t pid;
    int status { -1 };
    bool running { false };
    bool needsWrite { false };
    bool pendingClose { false };

    std::unique_ptr<AsyncPromise> promise;

    struct Writer
    {
        std::weak_ptr<Process> process;
    };

    std::shared_ptr<Writer> writer;
    std::vector<std::string> newPendingWrite;
    std::deque<std::string> pendingWrite;
    size_t pendingOffset { 0 };
};

struct Reader
{
    Reader();

    uv_async_t async;
    Mutex mutex;
    uv_thread_t thread;
    std::vector<std::shared_ptr<BufferEmitter> > pendingemitters;
    std::vector<std::shared_ptr<Process> > newprocs, procs, doneprocs;
    int sigpipe[2];
    int wakeuppipe[2];
    bool stopped { true };

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
    char c = 'a';
    MutexLocker locker(&mutex);
    newprocs.push_back(proc);
    EINTRWRAP(e, ::write(wakeuppipe[1], &c, 1));
}

void BufferEmitter::emit(char* data, size_t size)
{
    //printf("emitting %zu\n", data.size());
    queue.push({ data, size });

    MutexLocker locker(&reader.mutex);
    reader.pendingemitters.push_back(shared_from_this());
}

static void handleRead(int* fd, const std::shared_ptr<BufferEmitter>& emitter)
{
    int nfd = *fd;
    int e;
    char buf[16384];
    for (;;) {
        EINTRWRAP(e, ::read(nfd, buf, sizeof(buf)));
        if (e > 0) {
            emitter->emit(strndup(buf, e), e);
        } else if (e == 0) {
            EINTRWRAP(e, ::close(nfd));
            *fd = -1;
            break;
        } else {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                break;
            EINTRWRAP(e, ::close(nfd));
            *fd = -1;
            break;
        }
    }
}

static void handleWrite(Process* proc)
{
    if (proc->stdin == -1) {
        proc->pendingWrite.clear();
        return;
    }

    int e;
    while (!proc->pendingWrite.empty()) {
        const auto& str = proc->pendingWrite.front();
        EINTRWRAP(e, ::write(proc->stdin, &str[0] + proc->pendingOffset, str.size() - proc->pendingOffset));
        if (e > 0) {
            proc->pendingOffset += e;
            if (proc->pendingOffset == str.size()) {
                proc->pendingOffset = 0;
                proc->pendingWrite.pop_front();
            }
        } else if (e < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                proc->needsWrite = true;
            } else {
                // badness has occurred
                EINTRWRAP(e, ::close(proc->stdin));
                proc->stdin = -1;
            }
            return;
        }
    }
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
                          MutexLocker locker(&reader.mutex);
                          std::swap(dp, reader.doneprocs);
                          std::swap(pe, reader.pendingemitters);
                      }
                      for (const auto& e : pe) {
                          if (e->async) {
                              auto env = e->async->listener.Env();
                              Napi::HandleScope scope(env);
                              BufferEmitter::Data data;
                              for (;;) {
                                  if (!e->queue.pop(data))
                                      break;
                                  //printf("immediate %s\n", str.c_str());
                                  e->async->listener.MakeCallback(e->async->listener.Value(), { BufferEmitter::makeBuffer(env, data.data, data.size) }, e->async->ctx);
                              }
                          } else {
                              BufferEmitter::Data data;
                              for (;;) {
                                  if (!e->queue.pop(data))
                                      break;
                                  //printf("pending %s\n", str.c_str());
                                  e->pending.emplace_back(std::move(data));
                              }
                          }
                      }
                      for (const auto& p : dp) {
                          auto env = p->promise->promise.Env();
                          Napi::HandleScope scope(env);
                          Napi::CallbackScope callback(env, p->promise->ctx);

                          p->promise->promise.Resolve(Napi::Number::New(env, p->status));
                      }
                  });

    stopped = false;
    uv_thread_create(&thread,
                     [](void* arg) {
                         Reader* reader = static_cast<Reader*>(arg);
                         fd_set rdfds;
                         fd_set wrfds;
                         const int pmax = std::max(reader->wakeuppipe[0], reader->sigpipe[0]);
                         int e;
                         for (;;) {
                             //printf("top of thread\n");
                             FD_ZERO(&rdfds);
                             FD_ZERO(&wrfds);
                             FD_SET(reader->wakeuppipe[0], &rdfds);
                             FD_SET(reader->sigpipe[0], &rdfds);

                             bool newproc = false;

                             {
                                 MutexLocker locker(&reader->mutex);
                                 if (!reader->newprocs.empty()) {
                                     //printf("got new procs\n");
                                     reader->procs.reserve(reader->newprocs.size() + reader->procs.size());
                                     std::move(std::begin(reader->newprocs), std::end(reader->newprocs), std::back_inserter(reader->procs));
                                     reader->newprocs.clear();
                                     newproc = true;
                                 }
                             }

                             if (newproc) {
                                 // make sure that our new processes are still alive
                                 reader->handleSigChld();
                             }

                             int max = pmax;
                             for (const auto& proc : reader->procs) {
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
                                 {
                                     MutexLocker locker(&reader->mutex);
                                     if (!proc->newPendingWrite.empty()) {
                                         std::move(std::begin(proc->newPendingWrite), std::end(proc->newPendingWrite), std::back_inserter(proc->pendingWrite));
                                         proc->newPendingWrite.clear();
                                     }
                                 }
                                 if (!proc->pendingWrite.empty() && !proc->needsWrite) {
                                     handleWrite(proc.get());
                                 }
                                 if (proc->pendingWrite.empty() && proc->stdin != -1) {
                                     MutexLocker locker(&reader->mutex);
                                     if (proc->pendingClose) {
                                         //printf("closing stdin\n");
                                         proc->pendingClose = false;
                                         EINTRWRAP(e, ::close(proc->stdin));
                                         proc->stdin = -1;
                                     }
                                 }
                                 if (proc->stdin != -1 && proc->needsWrite) {
                                     FD_SET(proc->stdin, &wrfds);
                                 }
                             }

                             EINTRWRAP(e, ::select(max + 1, &rdfds, &wrfds, nullptr, nullptr));
                             if (e > 0) {
                                 if (FD_ISSET(reader->wakeuppipe[0], &rdfds)) {
                                     //printf("wakeup due to pipe\n");
                                     // deal with wakeup data
                                     unsigned char w;
                                     for (;;) {
                                         EINTRWRAP(e, ::read(reader->wakeuppipe[0], &w, 1));
                                         if (e == 1) {
                                         }
                                         // should handle error other than EAGAIN/EWOULDBLOCK
                                         if (e == -1)
                                             break;
                                     }
                                     MutexLocker locker(&reader->mutex);
                                     if (reader->stopped)
                                         return;
                                 }
                                 if (FD_ISSET(reader->sigpipe[0], &rdfds)) {
                                     //printf("wakeup due to signal\n");
                                     // deal with signal data
                                     unsigned char s;
                                     for (;;) {
                                         EINTRWRAP(e, ::read(reader->sigpipe[0], &s, 1));
                                         if (e == 1 && s == SIGCHLD) {
                                             reader->handleSigChld();
                                         }
                                         // should handle error other than EAGAIN/EWOULDBLOCK
                                         if (e == -1)
                                             break;
                                     }
                                 }
                                 for (const auto& proc : reader->procs) {
                                     if (proc->stdout != -1 && FD_ISSET(proc->stdout, &rdfds)) {
                                         //printf("wakeup due to stdout\n");
                                         // deal with proc stdout
                                         handleRead(&proc->stdout, proc->emitStdout);
                                         if (!proc->running && proc->stdout == -1 && proc->stderr == -1) {
                                             // notify js
                                             MutexLocker locker(&reader->mutex);
                                             reader->doneprocs.push_back(proc);
                                         }
                                         uv_async_send(&reader->async);
                                     }
                                     if (proc->stderr != -1 && FD_ISSET(proc->stderr, &rdfds)) {
                                         //printf("wakeup due to stderr\n");
                                         // deal with proc stderr
                                         handleRead(&proc->stderr, proc->emitStderr);
                                         if (!proc->running && proc->stdout == -1 && proc->stderr == -1) {
                                             // notify js
                                             MutexLocker locker(&reader->mutex);
                                             reader->doneprocs.push_back(proc);
                                         }
                                         uv_async_send(&reader->async);
                                     }
                                     if (proc->needsWrite && proc->stdin != -1 && FD_ISSET(proc->stdin, &wrfds)) {
                                         proc->needsWrite = false;
                                     }
                                 }
                             } else if (e < 0) {
                                 // bad
                             }
                         }
                     }, this);
}

void Reader::stop(const Napi::Env& env)
{
    if (sigpipe[0] == -1) {
        throw Napi::TypeError::New(env, "Reader already stopped");
    }

    {
        MutexLocker locker(&mutex);
        stopped = true;
    }

    int e;
    char c = 'q';
    EINTRWRAP(e, ::write(reader.wakeuppipe[1], &c, 1));

    uv_thread_join(&thread);

    EINTRWRAP(e, ::close(sigpipe[0]));
    EINTRWRAP(e, ::close(sigpipe[1]));
    sigpipe[0] = sigpipe[1] = -1;

    uv_close(reinterpret_cast<uv_handle_t*>(&reader.async), nullptr);

    signal(SIGCHLD, SIG_DFL);
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
                MutexLocker locker(&mutex);
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

void Write(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!info[0].IsObject()) {
        throw Napi::TypeError::New(env, "First argument needs to be a ctx");
    }

    auto writer = Wrap<std::shared_ptr<Process::Writer> >::unwrap(info[0]);
    if (!writer) {
        throw Napi::TypeError::New(env, "First argument is not a ctx");
    }

    auto proc = writer->process.lock();
    if (!proc) {
        throw Napi::TypeError::New(env, "Process is dead");
    }

    if (info[1].IsBuffer()) {
        auto buf = info[1].As<Napi::Buffer<const char> >();
        const std::string str(buf.Data(), buf.Length());
        MutexLocker locker(&reader.mutex);
        proc->newPendingWrite.push_back(std::move(str));
    } else if (info[1].IsUndefined()) {
        MutexLocker locker(&reader.mutex);
        proc->pendingClose = true;
    } else {
        throw Napi::TypeError::New(env, "Data is not a buffer or undefined");
    }

    int e;
    char c = 'w';
    EINTRWRAP(e, ::write(reader.wakeuppipe[1], &c, 1));
}

void Close(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!info[0].IsObject()) {
        throw Napi::TypeError::New(env, "First argument needs to be a ctx");
    }

    auto writer = Wrap<std::shared_ptr<Process::Writer> >::unwrap(info[0]);
    if (!writer) {
        throw Napi::TypeError::New(env, "First argument is not a ctx");
    }

    auto proc = writer->process.lock();
    if (!proc) {
        throw Napi::TypeError::New(env, "Process is dead");
    }

    MutexLocker locker(&reader.mutex);
    proc->pendingClose = true;

    int e;
    char c = 'w';
    EINTRWRAP(e, ::write(reader.wakeuppipe[1], &c, 1));
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
                emitter->async->listener.Call(emitter->async->listener.Value(), { BufferEmitter::makeBuffer(env, str.data, str.size) });
            }
            emitter->pending.clear();
        }
    } else {
        emitter->async.reset();
    }
}

static Napi::Object launchProcess(const Napi::Env& env, std::shared_ptr<Process>& proc, const ProcessOptions& opts)
{
    // we'll need to notify the parent if we can't exec,
    // create a pipe with CLOEXEC and write to it if
    // we fail

    proc->promise = std::make_unique<AsyncPromise>(Napi::Promise::Deferred::New(env), Napi::AsyncContext(env, "process"));
    auto promise = proc->promise->promise.Promise();

    int runpipe[2];
    ::pipe(runpipe);
    fcntl(runpipe[1], F_SETFD, fcntl(runpipe[1], F_GETFD) | FD_CLOEXEC);

    int stdinpipe[2] = { -1, -1 };
    if (opts.redirectStdin) {
        ::pipe(stdinpipe);
    }

    int stdoutpipe[2] = { -1, -1 };
    if (opts.redirectStdout) {
        ::pipe(stdoutpipe);
    }

    int stderrpipe[2] = { -1, -1 };
    if (opts.redirectStderr) {
        ::pipe(stderrpipe);
    }

    int e;

    const pid_t pid = fork();
    if (pid == 0) {
        // child

        signal(SIGINT, SIG_DFL);
        signal(SIGQUIT, SIG_DFL);
        signal(SIGTSTP, SIG_DFL);
        signal(SIGTTIN, SIG_DFL);
        signal(SIGTTOU, SIG_DFL);
        signal(SIGCHLD, SIG_DFL);

        EINTRWRAP(e, ::close(runpipe[0]));

        if (opts.redirectStdin) {
            EINTRWRAP(e, ::close(stdinpipe[1]));
            EINTRWRAP(e, dup2(stdinpipe[0], STDIN_FILENO));
            EINTRWRAP(e, ::close(stdinpipe[0]));
        }
        if (opts.redirectStdout) {
            EINTRWRAP(e, ::close(stdoutpipe[0]));
            EINTRWRAP(e, dup2(stdoutpipe[1], STDOUT_FILENO));
            EINTRWRAP(e, ::close(stdoutpipe[1]));
        }
        if (opts.redirectStderr) {
            EINTRWRAP(e, ::close(stderrpipe[0]));
            EINTRWRAP(e, dup2(stderrpipe[1], STDERR_FILENO));
            EINTRWRAP(e, ::close(stderrpipe[1]));
        }

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

        _exit(-1);
    } else if (pid > 0) {
        // parent

        if (opts.redirectStdin) {
            EINTRWRAP(e, ::close(stdinpipe[0]));
        }
        if (opts.redirectStdout) {
            EINTRWRAP(e, ::close(stdoutpipe[1]));
        }
        if (opts.redirectStderr) {
            EINTRWRAP(e, ::close(stderrpipe[1]));
        }

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
            if (opts.redirectStdin) {
                EINTRWRAP(e, ::close(stdinpipe[1]));
            }
            if (opts.redirectStdout) {
                EINTRWRAP(e, ::close(stdoutpipe[0]));
            }
            if (opts.redirectStderr) {
                EINTRWRAP(e, ::close(stderrpipe[0]));
            }

            proc->promise->promise.Reject(Napi::String::New(env, "Failed to launch process"));
            proc.reset();
        } else {
            // add this process to our read list
            proc->stdin = stdinpipe[1];
            proc->stdout = stdoutpipe[0];
            proc->stderr = stderrpipe[0];

            if (opts.redirectStdin) {
                e = fcntl(stdinpipe[1], F_GETFL);
                if (e != -1) {
                    fcntl(stdinpipe[1], F_SETFL, e | O_NONBLOCK);
                }
            }
            if (opts.redirectStdout) {
                e = fcntl(stdoutpipe[0], F_GETFL);
                if (e != -1) {
                    fcntl(stdoutpipe[0], F_SETFL, e | O_NONBLOCK);
                }
            }
            if (opts.redirectStderr) {
                e = fcntl(stderrpipe[0], F_GETFL);
                if (e != -1) {
                    fcntl(stderrpipe[0], F_SETFL, e | O_NONBLOCK);
                }
            }

            proc->pid = pid;
            proc->running = true;

            if (opts.redirectStderr) {
                proc->emitStderr = std::make_shared<BufferEmitter>();
            }
            if (opts.redirectStdout) {
                proc->emitStdout = std::make_shared<BufferEmitter>();
            }
            if (opts.redirectStdin) {
                proc->writer = std::make_shared<Process::Writer>();
                proc->writer->process = proc;
            }

            reader.add(proc);
        }
    } else {
        // error
    }

    auto obj = Napi::Object::New(env);
    if (proc) {
        if (opts.redirectStderr) {
            obj.Set("stderrCtx", Wrap<std::shared_ptr<BufferEmitter> >::wrap(env, proc->emitStderr));
        }
        if (opts.redirectStdout) {
            obj.Set("stdoutCtx", Wrap<std::shared_ptr<BufferEmitter> >::wrap(env, proc->emitStdout));
        }
        if (opts.redirectStdin) {
            obj.Set("stdinCtx", Wrap<std::shared_ptr<Process::Writer> >::wrap(env, proc->writer));
        }
    }
    obj.Set("listen", Napi::Function::New(env, Listen));
    obj.Set("write", Napi::Function::New(env, Write));
    obj.Set("close", Napi::Function::New(env, Close));
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
            if (!v.IsUndefined()) {
                env.push_back(std::make_pair(k.As<Napi::String>().Utf8Value(), v.As<Napi::String>().Utf8Value()));
            }
        }
        proc->env = std::move(env);
    }
    ProcessOptions opts = {
        true, true, true
    };
    if (info[3].IsObject()) {
        const auto obj = info[3].As<Napi::Object>();
        opts.redirectStdin = obj.Get("redirectStdin").As<Napi::Boolean>().Value();
        opts.redirectStdout = obj.Get("redirectStdout").As<Napi::Boolean>().Value();
        opts.redirectStderr = obj.Get("redirectStderr").As<Napi::Boolean>().Value();
    }

    return launchProcess(env, proc, opts);
}

Napi::Value Uid(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    if (!info[0].IsString()) {
        return Napi::Number::New(env, getuid());
    }

    const auto user = info[0].As<Napi::String>().Utf8Value();

    struct passwd pwd;
    struct passwd* result;
    char buf[16384];

    getpwnam_r(user.c_str(), &pwd, buf, sizeof(buf), &result);
    if (result == nullptr) {
        throw Napi::TypeError::New(env, "No such user");
    }

    return Napi::Number::New(env, result->pw_uid);
}

Napi::Value Gids(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    struct passwd pwd;
    struct passwd* result;
    char buf[16384];

    if (!info[0].IsString()) {
        const uid_t uid = getuid();

        getpwuid_r(uid, &pwd, buf, sizeof(buf), &result);
        if (result == nullptr) {
            throw Napi::TypeError::New(env, "No pwd entry for user");
        }
    } else {
        const auto user = info[0].As<Napi::String>().Utf8Value();

        getpwnam_r(user.c_str(), &pwd, buf, sizeof(buf), &result);
        if (result == nullptr) {
            throw Napi::TypeError::New(env, "No such user");
        }
    }

    int groups = 20;
#ifdef __APPLE__
    std::vector<int> gids;
#else
    std::vector<gid_t> gids;
#endif
    gids.resize(groups);

    for (;;) {
        const int oldg = groups;
        const int g = getgrouplist(result->pw_name, result->pw_gid, &gids[0], &groups);
        if (g < 0) {
            if (groups <= oldg) {
                throw Napi::TypeError::New(env, "Can't get number of groups");
            }
            gids.resize(groups);
        } else {
            if (g > 0)
                groups = g;
            break;
        }
    }

    Napi::Array gs = Napi::Array::New(env, groups);
    for (int i = 0; i < groups; ++i) {
        gs.Set(i, Napi::Number::New(env, gids[i]));
    }
    return gs;
}

Napi::Object Setup(Napi::Env env, Napi::Object exports)
{
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("launch", Napi::Function::New(env, Launch));
    exports.Set("uid", Napi::Function::New(env, Uid));
    exports.Set("gids", Napi::Function::New(env, Gids));
    return exports;
}

NODE_API_MODULE(process_native, Setup)
