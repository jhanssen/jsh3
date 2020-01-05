{
    "variables" : {
	"rl_include": "3rdparty/readline-install/include",
	"rl_libs": "../3rdparty/readline-install/lib/libreadline.a ../3rdparty/readline-install/lib/libhistory.a",
	"conditions": [
	    # Define variables that points at OS-specific paths.
	    ["OS=='mac'", {
		"os_libs": "-lncurses",
		"osx_ver": "<!(bash -c \"sw_vers -productVersion\")",
	    }, {
		"os_libs": "-ltinfo"
	    }]
	]
    },
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
		    "MACOSX_DEPLOYMENT_TARGET": "<(osx_ver)",
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
	    "<(rl_include)",
	],
	'libraries': [
	    "<(rl_libs)",
	    "<(os_libs)",
	],
	'dependencies': [
	    "<!(node -p \"require('node-addon-api').gyp\")"
	]
    }]
}
