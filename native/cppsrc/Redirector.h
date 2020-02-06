#ifndef REDIRECTOR_H
#define REDIRECTOR_H

#include <stdio.h>

class Redirector
{
public:
    Redirector();
    ~Redirector();

    int stdout() const { return mStdout.pipe[0]; }
    int stderr() const { return mStderr.pipe[0]; }

    int realStdout() const { return mStdout.real; }
    int realStderr() const { return mStderr.real; }

    FILE* stdoutFile() const { return mStdout.file; }
    FILE* stderrFile() const { return mStderr.file; }

    void writeStdout(const char* data, int len = -1);
    void writeStderr(const char* data, int len = -1);

    void quiet();
    void pause();
    void resume();

private:
    struct Dup
    {
        int real;
        int pipe[2];
        FILE* file;
    };

    Dup mStdout, mStderr;
    int mDevNull;
    bool mPaused;
};

#endif
