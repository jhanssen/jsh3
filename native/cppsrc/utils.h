#ifndef UTILS_H
#define UTILS_H

#include <uv.h>
#include <napi.h>
#include <assert.h>
#include <queue>
#include <errno.h>
#include <string>
#include <variant>
#include <vector>

#define EINTRWRAP(var, op)                      \
    do {                                        \
        var = op;                               \
    } while (var == -1 && errno == EINTR);

class Condition;

class Mutex
{
public:
    Mutex()
    {
        uv_mutex_init(&mMutex);
    }
    ~Mutex()
    {
        if (tLocked)
            unlock();
        uv_mutex_destroy(&mMutex);
    }

    void lock()
    {
        uv_mutex_lock(&mMutex);
        tLocked = true;
    }
    void unlock()
    {
        assert(tLocked);
        tLocked = false;
        uv_mutex_unlock(&mMutex);
    }

    bool locked() const { return tLocked; }

private:
    uv_mutex_t mMutex;
    thread_local static bool tLocked;

    friend class Condition;
};

class MutexLocker
{
public:
    MutexLocker(Mutex* m)
        : mMutex(m)
    {
        mMutex->lock();
    }

    ~MutexLocker()
    {
        if (mMutex->locked())
            mMutex->unlock();
    }

    void unlock()
    {
        mMutex->unlock();
    }

    void relock()
    {
        mMutex->lock();
    }

private:
    Mutex* mMutex;
};

class Condition
{
public:
    Condition()
    {
        uv_cond_init(&mCond);
    }

    ~Condition()
    {
        uv_cond_destroy(&mCond);
    }

    void wait(Mutex* mutex)
    {
        uv_cond_wait(&mCond, &mutex->mMutex);
    }

    void waitUntil(Mutex* mutex, uint64_t timeout)
    {
        uv_cond_timedwait(&mCond, &mutex->mMutex, timeout);
    }

    void signal()
    {
        uv_cond_signal(&mCond);
    }

    void broadcast()
    {
        uv_cond_broadcast(&mCond);
    }

private:
    uv_cond_t mCond;
};

template<typename T>
class Queue
{
public:
    Queue()
    {
    }

    ~Queue()
    {
    }

    void push(T&& t)
    {
        MutexLocker locker(&mMutex);
        mContainer.push(std::forward<T>(t));
    }

    bool pop(T& t)
    {
        MutexLocker locker(&mMutex);
        if (!mContainer.empty()) {
            t = std::move(mContainer.back());
            mContainer.pop();
            return true;
        } else {
            return false;
        }
    }

private:
    Mutex mMutex;
    std::queue<T> mContainer;
};

enum UndefinedType { Undefined };

typedef std::variant<double, std::string, const char*, bool, UndefinedType> Variant;

std::string longest_common_prefix(const std::string& s, const std::vector<std::string>& candidates);

Variant toVariant(Napi::Value value);
Napi::Value fromVariant(napi_env env, const Variant& variant);

inline Variant toVariant(Napi::Value value)
{
    switch (value.Type()) {
    case napi_undefined:
    case napi_null:
    case napi_symbol:
    case napi_object:
    case napi_function:
    case napi_external:
    case napi_bigint:
        return Variant(Undefined);
    case napi_boolean:
        return Variant(value.As<Napi::Boolean>().Value());
    case napi_number:
        return Variant(value.As<Napi::Number>().DoubleValue());
    case napi_string:
        return Variant(value.As<Napi::String>().Utf8Value());
    }
}

inline Napi::Value fromVariant(napi_env env, const Variant& variant)
{
    if (auto b = std::get_if<bool>(&variant)) {
        return Napi::Boolean::New(env, *b);
    } else if (auto n = std::get_if<double>(&variant)) {
        return Napi::Number::New(env, *n);
    } else if (auto s = std::get_if<std::string>(&variant)) {
        return Napi::String::New(env, *s);
    } else if (auto s = std::get_if<const char*>(&variant)) {
        return Napi::String::New(env, *s);
    }
    return Napi::Env(env).Undefined();
}

#endif
