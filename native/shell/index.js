var native;
var ok = false;

try {
    native = require('./build/Debug/shell_native.node');
    module.exports = native;
    ok = true;
} catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
        throw e;
    }
}

if (!ok) {
    native = require('./build/Release/shell_native.node');
    module.exports = native;
}
