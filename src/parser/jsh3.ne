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
        srightright: ">>",
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
        jsstart: { match: "{", push: "js" },
        variable: { match: /\$[a-zA-Z0-9_]+/, value: (s: string) => s.slice(1) },
        keyword: [/if\b/, /else\b/, /elif\b/, /for\b/, /repeat\b/, /while\b/, /until\b/, /do\b/, /done\b/, /fi\b/, /true\b/, /false\b/],
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
cmdmulti -> subcmdmulti {% extractCmdMulti %}
subcmdmulti -> cmd (%semi _ subcmdmulti):?

_ -> null | %whitespace {% function(d) { return null; } %}
__ -> %whitespace {% function(d) { return null; } %}

redirOut -> (%sright | %srightright | %nsright) _ (%ampinteger | %identifier | %integer)
redirIn -> %sleft _ (%identifier | %integer)
redirs -> _ (redirIn | redirOut)
redir -> null | redirs:+ {% extractRedir %}

ifCondition -> "if" __ conditions _ %semi _ "then" __ cmdmulti (__ elifCondition):? (__ "else" __ cmdmulti):? __ "fi" redir {% extractIf %}
elifCondition -> subelifCondition {% extractElIf %}
subelifCondition -> "elif" __ conditions _ %semi _ "then" __ cmdmulti (__ subelifCondition):?
whileCondition -> "while" __ conditions _ %semi _ "do" __ cmdmulti __ "done" redir {% extractWhile %}
jsCondition -> %jsstart _ jsblock:? _ %jsend {% extractJSCode %}
cmdCondition -> %lparen _ cmd _ %rparen {% extractCmdCondition %}
dollarCondition -> %variable
                 | %dollarvariable %variable %dollarvariableend {% extractDollarVariable %}
logicalCondition -> "true" | "false"
condition -> jsCondition
           | cmdCondition
           | dollarCondition
           | logicalCondition
conditions -> subconditions {% extractConditions %}
subconditions -> condition (__ logical __ subconditions):?

js -> %jsstart _ jsblock:? _ %jsend {% extractJSCode %}

jssingleblock -> %jssingleesc
               | %jssinglecontent
jsdoubleblock -> %jsdoubleesc
               | %jsdoublecontent
jsbackblock -> js
             | %jsbackesc
             | %jsbackcontent
jsblock -> js
         | %jscode
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
             | %dollarvariable %variable %dollarvariableend {% extractDollarVariable %}
singlestring -> %singlestringstart singleblock:* %singlestringend
doublestring -> %doublestringstart doubleblock:* %doublestringend

value -> key
       | singlestring {% id %}
       | doublestring {% id %}

variableAssignment -> key %eq value

exe -> %identifier
     | %integer
     | %variable
     | %dollarvariable %variable %dollarvariableend {% extractDollarVariable %}
     | singlestring
     | doublestring
arg -> %identifier
     | %integer
     | singlestring
     | doublestring
     | jsblock
     | %lparen _ cmd _ %rparen
     | %variable
     | %dollarvariable %variable %dollarvariableend {% extractDollarVariable %}

@{%

function extract1(d: any) {
    return d[1];
}

function extractDollarVariable(d: any) {
    return d[1];
}

function extractJSCode(d: any) {
    if (d[0].type !== "jsstart") {
        throw new Error("can't find jsstart");
    }
    if (d[4].type !== "jsend") {
        throw new Error("can't find jsend");
    }
    return [
        { type: "jscode",
          start: d[0].offset,
          end: d[4].offset
        }
    ];
}

function extractElIf(d: any) {
    const o: any[] = [];
    const helper = (sub: any) => {
        if (!sub)
            return;
        const elifEntry = [];
        elifEntry.push({ type: "condition", condition: sub[2] });
        elifEntry.push(sub[8]);
        o.push({ type: "elifEntry", elifEntry: elifEntry });

        if (sub[9] instanceof Array && sub[9].length > 0) {
            helper(sub[9][1]);
        }
    };
    helper(d[0]);
    return o;
}

function extractIf(d: any) {
    const o = [];
    const ifentries = [];
    ifentries.push({ type: "condition", condition: d[2] }); // condition
    ifentries.push(d[8]); // body
    let elifentries: any[] | undefined = undefined;
    if (d[9] instanceof Array && d[9].length > 0) {
        elifentries = d[9][1];
    }
    let elseentries: any[] | undefined = undefined;
    if (d[10] instanceof Array && d[10].length > 0) {
        elseentries = d[10][0][3];
    }

    o.push({ type: "if", if: ifentries, elif: elifentries, else: elseentries, redirs: d[11] });
    return o;
}

function extractWhile(d: any) {
    const o = [];
    const entries = [];
    entries.push({ type: "condition", condition: d[2] }); // condition
    entries.push(d[8]); // body
    o.push({ type: "while", while: entries, redirs: d[11] });
    return o;
}

function extractConditions(d: any) {
    const o: any[] = [];
    const helper = (sub: any) => {
        if (!sub)
            return;
        o.push(sub[0]);
        if (sub[1] instanceof Array && sub[1].length > 0) {
            o.push(sub[1][1]);
            helper(sub[1][3]);
        }
    };
    helper(d[0]);
    return o;
}

function extractCmdCondition(d: any) {
    return [d[2][1]];
}

function extractCmdMulti(d: any) {
    const o: any[] = [];
    const helper = (sub: any) => {
        if (!sub)
            return;
        o.push(sub[0][1]);
        if (sub[1] instanceof Array) {
            helper(sub[1][2]);
        }
    };
    helper(d[0]);
    return o;
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
    o.push({ type: "cmd", cmd: entries, redirs: d[3] });
    return o;
}

function extractRedir(d: any) {
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
