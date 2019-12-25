#include <napi.h>
#include <uv.h>

Napi::Value Start(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    return env.Undefined();
}

void Stop(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
}

Napi::Object Setup(Napi::Env env, Napi::Object exports)
{
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    return exports;
}

NODE_API_MODULE(readline_native, Setup)
