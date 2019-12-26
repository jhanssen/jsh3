import * as nearley from "nearley"
import { jsh3_grammar } from "./parser"
import { default as Readline, Data as ReadlineData } from "../native/readline";
import { join as pathJoin } from "path";
import { homedir } from "os";

const jsh3Parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));

//jsh3Parser.feed("./hello world { return `${foobar}`; } | grep 'ting'");
//jsh3Parser.feed("./hello \"world \\\"f\" 'trilli' | foo bar baz { 'foo!%&\\'bar' }");
//jsh3Parser.feed("./hello foo bar 3 'f'2> &1 > f < hey");
jsh3Parser.feed("./hello && trall; semmm | foo > &1 | bar &!");
//jsh3Parser.feed("./hello foo");
//jsh3Parser.feed("./hello 1 2 | foo 3 4");
console.log(JSON.stringify(jsh3Parser.results, null, 4));

function processLines(lines: string[]) {
    const promises: Promise<void>[] = [];
    for (const line of lines) {
        promises.push(Readline.addHistory(line, true));

        const parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));
        parser.feed(line);
        console.log(JSON.stringify(parser.results, null, 4));
    }
    Promise.all(promises).then(() => {
        console.log("added history");
    });
}

function processReadline(data: ReadlineData) {
    switch (data.type) {
    case "lines":
        processLines(data.lines || []);
    }
}

Readline.start(processReadline);
Readline.readHistory(pathJoin(homedir(), ".jsh_history")).then(() => {
    console.log("history loaded");
});
