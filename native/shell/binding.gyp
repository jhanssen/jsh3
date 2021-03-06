{
    "variables" : {
	"conditions": [
	    # Define variables that points at OS-specific paths.
	    ["OS=='mac'", {
		"osx_ver": "<!(bash -c \"sw_vers -productVersion\")",
	    }]
	]
    },
    "targets": [{
	"target_name": "shell_native",
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
	    "../cppsrc/shell.cc",
	    "../cppsrc/utils.cc",
	],
	'include_dirs': [
	    "../cppsrc",
	    "<!@(node -p \"require('node-addon-api').include\")"
	],
	'dependencies': [
	    "<!(node -p \"require('node-addon-api').gyp\")"
	]
    }]
}
