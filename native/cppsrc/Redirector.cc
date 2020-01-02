#include "Redirector.h"
#include "utils.h"
#include <unistd.h>
#include <string.h>
#include <fcntl.h>

Redirector::Redirector()
    : mPaused(false)
{
    // should make this a bit more resilient against errors

    // first dup our real stdout and stderr
    EINTRWRAP(mStdout.real, dup(STDOUT_FILENO));
    EINTRWRAP(mStderr.real, dup(STDERR_FILENO));

    // make two pipes
    ::pipe(mStdout.pipe);
    ::pipe(mStderr.pipe);

    int e;
    // make the read end non-blocking
    e = fcntl(mStdout.pipe[0], F_GETFL);
    fcntl(mStdout.pipe[0], F_SETFL, e | O_NONBLOCK);
    e = fcntl(mStderr.pipe[0], F_GETFL);
    fcntl(mStderr.pipe[0], F_SETFL, e | O_NONBLOCK);

    // dup our stdout and stderr fds
    EINTRWRAP(e, dup2(mStdout.pipe[1], STDOUT_FILENO));
    EINTRWRAP(e, dup2(mStderr.pipe[1], STDERR_FILENO));

    // make our file ptrs
    mStdout.file = fdopen(mStdout.real, "w");
    mStderr.file = fdopen(mStderr.real, "w");

    // open /dev/null
    EINTRWRAP(mDevNull, open("/dev/null", O_WRONLY));
}

Redirector::~Redirector()
{
    // close the pipes
    int e;
    EINTRWRAP(e, ::close(mStdout.pipe[0]));
    EINTRWRAP(e, ::close(mStdout.pipe[1]));
    EINTRWRAP(e, ::close(mStderr.pipe[0]));
    EINTRWRAP(e, ::close(mStderr.pipe[1]));

    // close /dev/null
    EINTRWRAP(e, ::close(mDevNull));

    // restore our file descriptors
    EINTRWRAP(e, dup2(mStdout.real, STDOUT_FILENO));
    EINTRWRAP(e, dup2(mStderr.real, STDERR_FILENO));

    // and close our file ptrs, not sure if this is needed
    EINTRWRAP(e, fclose(mStdout.file));
    EINTRWRAP(e, fclose(mStderr.file));
}

void Redirector::writeStdout(const char* data, int len)
{
    if (len == -1)
        len = strlen(data);
    int w;
    EINTRWRAP(w, write(mStdout.real, data, len));
}

void Redirector::writeStderr(const char* data, int len)
{
    if (len == -1)
        len = strlen(data);
    int w;
    EINTRWRAP(w, write(mStderr.real, data, len));
}

void Redirector::pause()
{
    if (mPaused)
        return;
    mPaused = true;
    // restore fds
    int e;
    EINTRWRAP(e, dup2(mStdout.real, STDOUT_FILENO));
    EINTRWRAP(e, dup2(mStderr.real, STDERR_FILENO));
}

void Redirector::quiet()
{
    if (mPaused)
        return;
    mPaused = true;
    // quiet fds
    int e;
    EINTRWRAP(e, dup2(mDevNull, STDOUT_FILENO));
    EINTRWRAP(e, dup2(mDevNull, STDERR_FILENO));
}

void Redirector::resume()
{
    if (!mPaused)
        return;
    mPaused = false;
    // restore fds
    int e;
    EINTRWRAP(e, dup2(mStdout.pipe[1], STDOUT_FILENO));
    EINTRWRAP(e, dup2(mStderr.pipe[1], STDERR_FILENO));
}
