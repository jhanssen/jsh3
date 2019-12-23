import * as nearley from "nearley"
import { jsh3_grammar } from "./parser"

const jsh3Parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));

//jsh3Parser.feed("./hello world { return `${foobar}`; } | grep 'ting'");
jsh3Parser.feed("./hello world | foo bar baz { 'foo!%&\\'bar' }");
console.log(JSON.stringify(jsh3Parser.results, null, 4));
