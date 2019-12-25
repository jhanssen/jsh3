{
    "targets": [{
	"target_name": "readline_native",
	"cflags!": [ "-fno-exceptions" ],
	"cflags_cc!": [ "-fno-exceptions" ],
	"cflags_cc": [ "-std=c++17" ],
	"conditions": [
	    ['OS=="mac"', {
		"xcode_settings": {
		    "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
		    "OTHER_CFLAGS": [ "-std=c++17"],
		}
	    }]
	],
	"sources": [
	    "../cppsrc/readline.cc",
	    "../cppsrc/utils.cc",
	    "../cppsrc/Redirector.cc",
	],
	'include_dirs': [
	    "../cppsrc",
	    "<!@(node -p \"require('node-addon-api').include\")",
	    "<!@(PKG_CONFIG_PATH=/usr/local/opt/readline/lib/pkgconfig pkg-config readline --cflags-only-I | sed s/-I//g | sed s/readline$//g)",
	],
	'libraries': [
	    "<!@(PKG_CONFIG_PATH=/usr/local/opt/readline/lib/pkgconfig pkg-config readline --libs)",
	],
	'dependencies': [
	    "<!(node -p \"require('node-addon-api').gyp\")"
	]
    }]
}
