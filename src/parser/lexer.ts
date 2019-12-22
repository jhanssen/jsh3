const moo = require("moo");

const lexer = moo.states({
    main: {
        whitespace: /[ \t]+/,
        dollarlparen: "$(",
        dollarvariable: { match: "${", push: "dollarvariable" },
        lparen: "(",
        rparen: ")",
        lbracket: "[",
        rbracket: "]",
        sright: ">",
        sleft: "<",
        amp: "&",
        ex: "!",
        eq: "=",
        semi: ";",
        pipe: "|",
        jsstart: { match: "{", push: "js" },
        variable: { match: /\$[a-zA-Z0-9_]+/, value: (s: string) => s.slice(1) },
        keyword: ["if", "for", "repeat", "while", "until", "do", "done", "fi"],
        doublestring: { match: "\"", push: "doublestring" },
        singlestring: { match: "'", push: "singlestring" },
        identifier: /[a-zA-Z0-9_]+/
    },
    singlestring: {
        singleesc: "\\'",
        singlecontent: /[^'\n]+/,
        singlestringend: { match: "'", pop: true }
    },
    doublestring: {
        doubleesc: "\\\"",
        variable: { match: /\$[a-zA-Z0-9_]+/, value: (s: string) => s.slice(1) },
        dollarvariable: { match: "${", push: "dollarvariable" },
        doublecontent: /[^"$\n]+/,
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
        jssingleesc: "\\'",
        jssingleend: { match: "'", pop: true },
        jssinglecontent: /[^'\n]+/
    },
    jsdoublestart: {
        jsdoubleesc: "\\\"",
        jsdoubleend: { match: "\"", pop: true },
        jsdoublecontent: /[^"\n]+/
    },
    jsbackstart: {
        jsbackesc: "\\`",
        jsbackend: { match: "`", pop: true },
        jsstart: { match: "${", push: "js" },
        jsbackcontent: { match: /^(?:(?!(?:`|\${)).)+/, lineBreaks: true }
    }
});

//lexer.reset("var1={foo+'\\'tr}'} var2={`${hey}`} while var3=$foo");
lexer.reset('var1="foo$bar" foo$bar {12$3{45}6} 7$8 \'foo$bar\'');
for (;;) {
    const t = lexer.next();
    if (t === undefined)
        break;
    console.log(t);
}
