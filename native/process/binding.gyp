{
    "targets": [{
	"target_name": "process_native",
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
	    "../cppsrc/process.cc",
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
