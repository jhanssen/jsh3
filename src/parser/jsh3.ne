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
        comma: ",",
        nsleftright: { match: /[0-9]+<>/, value: (s: string) => parseInt(s) },
        sleftright: "<>",
        nsrightright: { match: /[0-9]+>>/, value: (s: string) => parseInt(s) },
        nsright: { match: /[0-9]+>/, value: (s: string) => parseInt(s) },
        nsleft: { match: /[0-9]+</, value: (s: string) => parseInt(s) },
        srightright: ">>",
        srightgr: ">=",
        sright: ">",
        sleftgr: "<=",
        sleft: "<",
        ampsrightright: "&>>",
        ampsright: "&>",
        and: "&&",
        or: "||",
        ampinteger: { match: /&[0-9+]+/, value: (s: string) => parseInt(s.slice(1)) },
        amp: "&",
        eqeq: "==",
        neq: "!=",
        eq: "=",
        ex: "!",
        semi: ";",
        pipe: "|",
        star: "*",
        jsstart: { match: "{", push: "jstype" },
        variable: { match: /\$[a-zA-Z0-9_]+/, value: (s: string) => s.slice(1) },
        keyword: [/if\b/, /else\b/, /elif\b/, /for\b/, /repeat\b/, /while\b/, /until\b/, /do\b/, /done\b/, /fi\b/, /true\b/, /false\b/],
        doublestringstart: { match: "\"", push: "doublestringstart" },
        singlestringstart: { match: "'", push: "singlestringstart" },
        integer: { match: /[0-9]+/, value: (s: string) => parseInt(s) },
        identifier: /[a-zA-Z0-9\-_./]+/
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
    jstype: {
        jstypecaptureout: "$",
        jstypestream: { match: ">", next: "js" },
        jstypeiterable: { match: "*", next: "js" },
        jstypereturn: { match: "^", next: "js" },
        jstypestring: { match: ":", next: "jstypestring" },
        jssinglestart: { match: "'", push: "jssinglestart" },
        jsdoublestart: { match: "\"", push: "jsdoublestart" },
        jsbackstart: { match: "`", push: "jsbackstart" },
        jsstart: { match: "{", push: "js" },
        jsend: { match: "}", pop: true },
        jscode: { match: /[^$>*^:'"`{}]/, next: "js", lineBreaks: true }
    },
    jstypestring: {
        jstypestringcontent: { match: /[^\s]+/, next: "js" }
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
        jssinglecontent: { match: /[^'\\\n]+/, lineBreaks: true }
    },
    jsdoublestart: {
        jsdoubleesc: /\\./,
        jsdoubleend: { match: "\"", pop: true },
        jsdoublecontent: { match: /[^"\\\n]+/, lineBreaks: true }
    },
    jsbackstart: {
        jsbackesc: /\\./,
        jsbackend: { match: "`", pop: true },
        jsstart: { match: "${", push: "js" },
        jsbackcontent: { match: /(?:(?!(?:`|\${|\\)).)+/, lineBreaks: true }
    }
});

%}

@lexer lexer

cmds -> cmdsep
      | ifCondition
      | whileCondition

cmdsep -> cmdlogical (_ (%semi | (%amp %ex:?)) _ cmdlogical:?):* {% extractCmdSep %}
cmdlogical -> cmdpipe (_ logical _ cmdpipe):* {% extractCmdLogical %}
cmdpipe -> (cmd | subshell | subshellout | js) (_ %pipe _ (cmd | subshell | subshellout | js)):* {% extractCmdPipe %}

logical -> %and | %or
amp -> null | %amp
ex -> null | %ex

cmd -> (variableAssignment %whitespace):* exe (%whitespace arg):* redir {% extractCmd %}
cmdmulti -> subcmdmulti {% extractCmdMulti %}
subcmdmulti -> cmd (%semi _ subcmdmulti):?

_ -> null | %whitespace {% function(d) { return null; } %}
__ -> %whitespace {% function(d) { return null; } %}

redirOut -> (%sright | %srightright | %nsright | %nsrightright | %ampsright | %ampsrightright) _ (%ampinteger | %identifier | %integer)
redirIn -> (%sleft | %nsleft) _ (%ampinteger | %identifier | %integer)
redirInOut -> (%sleftright | %nsleftright) _ (%identifier | %integer)
redirs -> _ (redirIn | redirOut | redirInOut)
redir -> null | redirs:+ {% extractRedir %}

ifCondition -> "if" __ conditions _ %semi _ "then" __ cmdmulti (__ elifCondition):? (__ "else" __ cmdmulti):? __ "fi" redir {% extractIf %}
elifCondition -> subelifCondition {% extractElIf %}
subelifCondition -> "elif" __ conditions _ %semi _ "then" __ cmdmulti (__ subelifCondition):?
whileCondition -> "while" __ conditions _ %semi _ "do" __ cmdmulti __ "done" redir {% extractWhile %}
jsCondition -> js
dollarCondition -> %variable
                 | %dollarvariable %variable %dollarvariableend {% extractDollarVariable %}
logicalCondition -> "true" | "false"
compare -> %srightgr
         | %sright
         | %sleftgr
         | %sleft
         | %eqeq
         | %neq
condition -> jsCondition
           | subshell
           | subshellout
           | dollarCondition
           | logicalCondition
           | singlestring
           | doublestring
           | %identifier
           | %integer
conditions -> subconditions {% extractConditions %}
subconditions -> condition (_ compare _ condition):? (__ logical __ subconditions):?
subshell -> %lparen _ cmds _ %rparen redir {% extractSubshell %}
subshellout -> %dollarlparen _ cmds _ %rparen {% extractSubshellOut %}
js -> jstypeblock (%lparen argnojs (_ %comma _ argnojs):* %rparen):? {% extractJSCode %}

jssingleblock -> %jssingleesc
               | %jssinglecontent
jsdoubleblock -> %jsdoubleesc
               | %jsdoublecontent
jsbackblock -> jsblock
             | %jsbackesc
             | %jsbackcontent
jstype -> %jstypecaptureout:? (%jstypestream | %jstypeiterable | %jstypereturn | (%jstypestring %jstypestringcontent)):?
jstypeblock -> %jsstart jstype _ (jspart):* _ %jsend
jsblock -> %jsstart _ (jspart):* _ %jsend
jspart -> jsblock
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
singlestring -> %singlestringstart singleblock:* %singlestringend {% extract1 %}
doublestring -> %doublestringstart doubleblock:* %doublestringend {% extract1 %}

value -> key
       | subshell
       | subshellout
       | js
       | singlestring {% id %}
       | doublestring {% id %}

variableAssignment -> key %eq value

argpart -> (%identifier | %integer) (%eq | %identifier | %integer):* {% extractArgPart %}

exe -> %identifier
     | %integer
     | %variable
     | %dollarvariable %variable %dollarvariableend {% extractDollarVariable %}
     | singlestring
     | doublestring
arg -> argpart
     | singlestring
     | doublestring
     | js
     | subshell
     | subshellout
     | %variable
     | %dollarvariable %variable %dollarvariableend {% extractDollarVariable %}
argnojs -> argpart
         | singlestring
         | doublestring
         | subshell
         | subshellout
         | %variable
         | %dollarvariable %variable %dollarvariableend {% extractDollarVariable %}

@{%

function extract1(d: any) {
    return d[1];
}

function extractDollarVariable(d: any) {
    return d[1];
}

function extractArgPart(d: any) {
    const newd0 = [Object.assign({}, d[0][0])];
    if (d[1] instanceof Array && d[1].length > 0) {
        // join all the items
        let str = newd0[0].text;
        for (const item of d[1]) {
            str += item[0].text
        }
        newd0[0].text = newd0[0].value = str;
    }
    return [newd0];
}

function extractJSCode(d: any) {
    if (d[0][0].type !== "jsstart") {
        throw new Error("can't find jsstart");
    }
    if (d[0][5].type !== "jsend") {
        throw new Error("can't find jsend");
    }
    const args = [];
    if (d[1] instanceof Array && d[1].length > 0) {
        args.push(d[1][1][0]);
        if (d[1][2] instanceof Array && d[1][2].length > 0) {
            for (let i = 0; i < d[1][2].length; ++i) {
                args.push(d[1][2][i][3][0]);
            }
        }
    }

    let jstype = "return";
    let capture = "exit";
    let start = d[0][0].offset;
    if (d[0][1] instanceof Array && d[0][1].length > 0) {
        if (d[0][1][0] !== null && d[0][1][0].type === "jstypecaptureout") {
            capture = "out";
            start = d[0][1][0].offset + d[0][1][0].text.length - 1;
        }
        if (d[0][1][1] !== null && d[0][1][1][0] !== null) {
            if ("type" in d[0][1][1][0]) {
                jstype = d[0][1][1][0].type.substr(6); // skip 'jstype'
                start = d[0][1][1][0].offset + d[0][1][1][0].text.length - 1;
            } else if ("type" in d[0][1][1][0][0] && d[0][1][1][0][0].type === "jstypestring" && d[0][1][1][0].length === 2) {
                jstype = d[0][1][1][0][1].value.toString();
                start = d[0][1][1][0][1].offset + d[0][1][1][0][1].text.length - 1;
            } else {
                throw new Error("Couldn't find jstype");
            }
        }
    }

    return { type: "jscode",
             jstype: jstype,
             capture: capture,
             start: start,
             end: d[0][5].offset,
             args: args.length > 0 ? args : undefined
           };
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

    return { type: "if", if: ifentries, elif: elifentries, else: elseentries, redirs: d[11] };
}

function extractWhile(d: any) {
    const entries = [];
    entries.push({ type: "condition", condition: d[2] }); // condition
    entries.push(d[8]); // body
    return { type: "while", while: entries, redirs: d[11] };
}

function extractConditions(d: any) {
    const o: any[] = [];
    const helper = (sub: any) => {
        if (!sub)
            return;
        const no = [];
        no.push(sub[0]);
        if (sub[1] instanceof Array && sub[1].length > 0) {
            // comparison
            no.push(sub[1][1][0]); // operator
            no.push(sub[1][3][0]); // operand
        }
        o.push(no);
        if (sub[2] instanceof Array && sub[2].length > 0) {
            // logical
            o.push(sub[2][1]);
            helper(sub[2][3]);
        }
    };
    helper(d[0]);
    return o;
}

function extractSubshell(d: any){
    return { type: "subshell", subshell: d[2][0], redirs: d[5] };
}

function extractSubshellOut(d: any) {
    return { type: "subshellOut", subshell: d[2][0] };
}

function extractCmdMulti(d: any) {
    const o: any[] = [];
    const helper = (sub: any) => {
        if (!sub)
            return;
        o.push(sub[0]);
        if (sub[1] instanceof Array) {
            helper(sub[1][2]);
        }
    };
    helper(d[0]);
    return o;
}

function extractCmd(d: any) {
    let a: any[] | undefined = undefined;
    if (d[0] instanceof Array && d[0].length > 0) {
        a = [];
        for (let i = 0; i < d[0].length; ++i) {
            const v = d[0][i][0][2];
            let val;
            if (v.length === 1) {
                if (v[0].length === 1) {
                    val = v[0][0];
                } else {
                    val = v[0];
                }
            } else {
                val = v;
            }
            a.push({ type: "assignment",
                     key: d[0][i][0][0][0],
                     value: val });
        }
    }
    const entries = [];
    entries.push(d[1][0]);
    if (d[2] instanceof Array) {
        for (let i = 0; i < d[2].length; ++i) {
            entries.push(d[2][i][1][0]);
        }
    }
    return { type: "cmd", assignments: a, cmd: entries, redirs: d[3] };
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

function merge(entries: any[], type: string, data: any) {
    let last: any | undefined;
    const traverse = (e: any) => {
        if (typeof e === "object" && e !== null) {
            if (e instanceof Array) {
                for (const ee of e) {
                    traverse(ee);
                }
            } else {
                if (e.type === type) {
                    last = e;
                }
                for (const [k, ee] of Object.entries(e)) {
                    traverse(ee);
                }
            }
        }
    };
    traverse(entries);
    if (last) {
        Object.assign(last, data);
    }
}

function extractCmdSep(d: any) {
    const entries = [d[0]];
    if (d[1] instanceof Array) {
        for (let i = 0; i < d[1].length; ++i) {
            if (d[1][i][1][0] instanceof Array) {
                if (d[1][i][1][0][0].type === "amp") {
                    merge(entries, "cmd", { amp: true });
                }
                if (d[1][i][1][0][1] !== null && d[1][i][1][0][1].type === "ex") {
                    merge(entries, "cmd", { ex: true });
                }
            }
            if (d[1][i][3] !== null) {
                entries.push(d[1][i][3]);
            }
        }
    }
    return { type: "sep", sep: entries };
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
    return { type: "pipe", pipe: entries.map(e => e[0]) };
}

function extract024(d: any) {
    const o = [];
    o.push(d[0]);
    o.push(d[2]);
    o.push(d[4]);
    return o;
}

%}
