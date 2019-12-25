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
	nsright: { match: /[0-9]+>/, value: (s: string) => parseInt(s) },
	sright: ">",
	sleft: "<",
	and: "&&",
	or: "||",
	ampinteger: { match: /&[0-9+]+/, value: (s: string) => parseInt(s.slice(1)) },
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
	doublestringstart: { match: "\"", push: "doublestringstart" },
	singlestringstart: { match: "'", push: "singlestringstart" },
	integer: { match: /[0-9]+/, value: (s: string) => parseInt(s) },
	identifier: /[a-zA-Z0-9_./]+/
    },
    singlestringstart: {
	singleesc: /\\./,
	singlestring: /[^'\\\n]+/,
	singlestringend: { match: "'", pop: true }
    },
    doublestringstart: {
	doubleesc: /\\./,
	variable: { match: /\$[a-zA-Z0-9_]+/, value: (s: string) => s.slice(1) },
	dollarvariable: { match: "${", push: "dollarvariable" },
	doublestring: /[^"$\\\n]+/,
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

cmds -> cmdamp {% extractCmdAmp %}
      | ifCondition
      | whileCondition

cmdamp -> cmdsemi _ amp ex
cmdsemi -> cmdpipe (_ %semi _ cmdpipe):* {% extractCmdSemi %}
cmdpipe -> cmdlogical (_ %pipe _ cmdlogical):* {% extractCmdPipe %}
cmdlogical -> cmd (_ logical _ cmd):* {% extractCmdLogical %}

logical -> %and | %or
amp -> null | %amp
ex -> null | %ex

cmd -> (variableAssignment %whitespace):* exe (%whitespace arg):* redir {% extractCmd %}

_ -> null | %whitespace {% function(d) { return null; } %}

redirOut -> (%sright | %nsright) _ (%ampinteger | %identifier | %integer)
redirIn -> %sleft _ (%identifier | %integer)
redirs -> _ (redirIn | redirOut)
redir -> null | redirs:+

ifCondition -> "if" _ condition _ "then" _ cmd:* _ ("elif" _ condition _ "then" _ cmd:*):* _ ("else" _ cmd:*):* _ "fi" redir
whileCondition -> "while" _ condition _ "do" _ cmd:* _ "done" redir
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
	 | %jssinglestart jssingleblock:* %jssingleend
	 | %jsdoublestart jsdoubleblock:* %jsdoubleend
	 | %jsbackstart jsbackblock:* %jsbackend

key -> %identifier
     | %integer

singleblock -> %singleesc
	     | %singlestring
doubleblock -> %doubleesc
	     | %doublestring
	     | %variable
	     | %dollarvariable %variable %dollarvariableend
singlestring -> %singlestringstart singleblock:* %singlestringend
doublestring -> %doublestringstart doubleblock:* %doublestringend

value -> key
       | singlestring {% id %}
       | doublestring {% id %}

variableAssignment -> key %eq value

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
    const o = [];
    if (d[0] instanceof Array) {
	const a = [];
	for (let i = 0; i < d[0].length; ++i) {
	    const v = d[0][i][0][2];
	    a.push({ type: "assignment",
		     key: d[0][i][0][0][0],
		     value: v.length === 1 ? v[0][0] : v });
	}
	o.push(a);
    }
    const entries = [];
    entries.push(d[1][0]);
    if (d[2] instanceof Array) {
	for (let i = 0; i < d[2].length; ++i) {
	    entries.push(d[2][i][1][0]);
	}
    }
    o.push({ type: "cmd", cmd: entries, redirs: extractRedirs(d[3]) });
    return o;
}

function extractRedirs(d: any) {
    if (!d.length)
	return d;
    const o = [];
    for (let i = 0; i < d[0].length; ++i) {
	const k = d[0][i][1][0][0];
	if (k instanceof Array && k.length === 1)
	    o.push(k[0]);
	else
	    o.push(k);
	o.push(d[0][i][1][0][2][0]);
    }
    return o;
}

function extractCmdSemi(d: any) {
    const entries = [d[0]];
    if (d[1] instanceof Array) {
        for (let i = 0; i < d[1].length; ++i) {
            entries.push(d[1][i][3]);
	}
    }
    return { type: "semi", semi: entries };
}

function extractCmdLogical(d: any) {
    const entries = [d[0]];
    if (d[1] instanceof Array) {
        for (let i = 0; i < d[1].length; ++i) {
            entries.push(d[1][i][1][0]);
            entries.push(d[1][i][3]);
	}
    }
    return { type: "logical", logical: entries };
}

function extractCmdPipe(d: any) {
    const entries = [d[0]];
    if (d[1] instanceof Array) {
        for (let i = 0; i < d[1].length; ++i) {
            entries.push(d[1][i][3]);
	}
    }
    return { type: "pipe", pipe: entries };
}

function extractCmdAmp(d: any) {
    const entry = [d[0]];
    if (d[2] instanceof Array && d[2].length === 1)
        entry.push(d[2][0]);
    if (d[3] instanceof Array && d[3].length === 1)
        entry.push(d[3][0]);
    return { type: "cmdamp", cmdamp: entry };
}

function extract024(d: any) {
    const o = [];
    o.push(d[0]);
    o.push(d[2]);
    o.push(d[4]);
    return o;
}

%}
