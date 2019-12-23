@preprocessor typescript

@{%
const moo = require("moo");

const lexer = moo.states({
    main: {
	whitespace: { match: /[ \t]+/, lineBreaks: true },
	dollarlparen: "$(",
	dollarvariable: { match: "${", push: "dollarvariable" },
	lparen: "(",
	rparen: ")",
	lbracket: "[",
	rbracket: "]",
	sright: ">",
	sleft: "<",
	and: "&&",
	or: "||",
	amp: "&",
	ex: "!",
	eq: "=",
	semi: ";",
	pipe: "|",
	star: "*",
	slash: "/",
	jsstart: { match: "{", push: "js" },
	variable: { match: /\$[a-zA-Z0-9_]+/, value: (s: string) => s.slice(1) },
	keyword: ["if", "for", "repeat", "while", "until", "do", "done", "fi"],
	doublestring: { match: "\"", push: "doublestring" },
	singlestring: { match: "'", push: "singlestring" },
	integer: /[0-9]+/,
	identifier: /[a-zA-Z0-9_./]+/
    },
    singlestring: {
	singleesc: /\\./,
	singlecontent: /[^'\\\n]+/,
	singlestringend: { match: "'", pop: true }
    },
    doublestring: {
	doubleesc: /\\./,
	variable: { match: /\$[a-zA-Z0-9_]+/, value: (s: string) => s.slice(1) },
	dollarvariable: { match: "${", push: "dollarvariable" },
	doublecontent: /[^"$\\\n]+/,
	doublestringend: { match: "\"", pop: true }
    },
    dollarvariable: {
	variable: { match: /[^}\n]+/ },
	dollarvariableend: { match: "}", pop: true }
    },
    js: {
	jssinglestart: { match: "'", push: "jssinglestart" },
	jsdoublestart: { match: "\"", push: "jsdoublestart" },
	jsbackstart: { match: "`", push: "jsbackstart" },
	jsstart: { match: "{", push: "js" },
	jsend: { match: "}", pop: true },
	jscode: { match: /[^'"`{}]+/, lineBreaks: true }
    },
    jssinglestart: {
	jssingleesc: /\\./,
	jssingleend: { match: "'", pop: true },
	jssinglecontent: /[^'\\\n]+/
    },
    jsdoublestart: {
	jsdoubleesc: /\\./,
	jsdoubleend: { match: "\"", pop: true },
	jsdoublecontent: /[^"\\\n]+/
    },
    jsbackstart: {
	jsbackesc: /\\./,
	jsbackend: { match: "`", pop: true },
	jsstart: { match: "${", push: "js" },
	jsbackcontent: { match: /^(?:(?!(?:`|\${|\\)).)+/, lineBreaks: true }
    }
});

%}

@lexer lexer

cmds -> cmd (_ %pipe _ cmds):* {% extractCmds %}
      | ifCondition

cmd -> exe (%whitespace arg):* {% extractCmd %}

_ -> null | %whitespace {% function(d) { return null; } %}

ifCondition -> "if" _ condition _ "then" _ cmd:* _ "fi"
jsCondition -> %jsstart _ jsblock:? _ %jsend
cmdCondition -> %lparen _ cmd _ %rparen
condition -> jsCondition
	   | cmdCondition

js -> %jsstart _ jsblock:* _ %jsend {% extract024 %}

jssingleblock -> %jssingleesc
	       | %jssinglecontent
jsdoubleblock -> %jsdoubleesc
	       | %jsdoublecontent
jsbackblock -> js
	     | %jsbackesc
	     | %jsbackcontent
jsblock -> js
	 | %jscode {% id %}
	 | %jssinglestart jssingleblock:* %jssingleend {% extract1 %}
	 | %jsdoublestart jsdoubleblock:* %jsdoubleend
	 | %jsbackstart jsbackblock:* %jsbackend

key -> %identifier
     | %integer

singleblock -> %singleesc
	     | %singlecontent
doubleblock -> %doubleesc
	     | %doublecontent
	     | %variable
	     | %dollarvariable %variable %dollarvariableend
singlestring -> %singlestring singleblock:* %singlestringend
doublestring -> %doublestring doubleblock:* %doublestringend

value -> key
       | singlestring
       | doublestring

variable -> key %eq value

exe -> %identifier
     | %integer
     | %variable
     | %dollarvariable %variable %dollarvariableend
     | singlestring
     | doublestring
arg -> %identifier
     | %integer
     | singlestring
     | doublestring
     | jsblock
     | %lparen _ cmd _ %rparen
     | %variable
     | %dollarvariable %variable %dollarvariableend

@{%

function extract1(d: any) {
    return d[1];
}

function extractCmd(d: any) {
    const o = [d[0][0]];
    if (d[1] instanceof Array) {
	for (let i = 0; i < d[1].length; ++i) {
	    o.push(d[1][i][1][0]);
	}
    }
    return o;
}

function extractCmds(d: any) {
    const o = [d[0]];
    for (let i = 0; i < d[1].length; ++i) {
	o.push(d[1][i][1]);
	o.push(extractCmd([d[1][i][3]]));
    }
    return o;
}

function extract024(d: any) {
    const o = [];
    o.push(d[0]);
    o.push(d[2]);
    o.push(d[4]);
    return o;
}

%}
