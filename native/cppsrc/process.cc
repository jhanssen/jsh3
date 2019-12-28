Napi::Value Launch(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    return env.Undefined();
}

Napi::Object Setup(Napi::Env env, Napi::Object exports)
{
    exports.Set("launch", Napi::Function::New(env, Launch));
    return exports;
}

NODE_API_MODULE(process_native, Setup)
