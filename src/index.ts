import * as nearley from "nearley"
import { jsh3_grammar } from "./parser"
import { default as Readline, Data as ReadlineData, Completion as ReadlineCompletion } from "../native/readline";
import { default as Process } from "../native/process";
import { join as pathJoin } from "path";
import { homedir } from "os";

const jsh3Parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));

//jsh3Parser.feed("./hello world { return `${foobar}`; } | grep 'ting'");
//jsh3Parser.feed("./hello \"world \\\"f\" 'trilli' | foo bar baz { 'foo!%&\\'bar' }");
//jsh3Parser.feed("./hello foo bar 3 'f'2> &1 > f < hey");
//jsh3Parser.feed("./hello && trall; semmm | foo > &1 | bar &!");
//jsh3Parser.feed("./hello foo");
//jsh3Parser.feed("./hello 1 2 | foo 3 4");
//console.log(JSON.stringify(jsh3Parser.results, null, 4));

function handlePauseRl(cmd: string, args: string[]) {
    const timeout = (args.length > 0 && parseInt(args[0])) || 0;
    if (!timeout) {
        console.log("no timeout");
        return;
    }
    console.log("pausing");
    return new Promise((resolve, reject) => {
        Readline.pause().then(() => {
            setTimeout(() => {
                Readline.resume().then(() => {
                    console.log("resuming");
                    resolve();
                });
            }, timeout);
            setTimeout(() => {
                Readline.setPrompt("hello> ");
            }, timeout * 2);
        }).catch(e => {
            reject(e);
        });
    });
}

function handleInternalCmd(cmd: string, args: string[]) {
    switch (cmd) {
    case "pauserl":
        handlePauseRl(cmd, args);
        return true;
    }
}

function visitCmd(node: any) {
    const args: string[] = [];
    for (const id of node.cmd) {
        args.push(id.value);
    }
    const cmd = args.shift();
    if (!cmd)
        return;
    if (handleInternalCmd(cmd, args))
        return true;
    const p = Process.launch(cmd, args);
    p.promise.then(status => {
        console.log("status", status);
    }).catch(e => {
        console.error("failed to launch", e);
    });
    if (p.stdinCtx) {
        p.close(p.stdinCtx);
    }
    if (p.stdoutCtx) {
        p.listen(p.stdoutCtx, (buf: Buffer) => {
            console.log("out", buf.toString());
        });
    }
    if (p.stderrCtx) {
        p.listen(p.stderrCtx, (buf: Buffer) => {
            console.log("err", buf.toString());
        });
    }
    //console.log(args);
    return true;
}

function visit(node: any) {
    if (node instanceof Array) {
        for (const item of node) {
            visit(item);
        }
        return;
    }

    switch (node.type) {
    case "cmd":
        if (visitCmd(node))
            return;
        break;
    }

    const data = node[node.type];
    if (data instanceof Array) {
        for (const item of data) {
            visit(item);
        }
    }
}

function processLines(lines: string[] | undefined) {
    if (!lines)
        return;

    const promises: Promise<void>[] = [];
    for (const line of lines) {
        promises.push(Readline.addHistory(line, true));

        const parser = new nearley.Parser(nearley.Grammar.fromCompiled(jsh3_grammar));
        parser.feed(line);
        if (parser.results) {
            visit(parser.results);
        }
    }
    Promise.all(promises).then(() => {
        console.log("added history");
    });
}

function processCompletion(data: ReadlineCompletion | undefined) {
    if (!data)
        return;

    //console.log("want to complete", data);
    data.complete(["faff"]);
}

function processReadline(data: ReadlineData) {
    switch (data.type) {
    case "lines":
        processLines(data.lines);
        break;
    case "completion":
        processCompletion(data.completion);
        break;
    }
}

Readline.start(processReadline);
Readline.readHistory(pathJoin(homedir(), ".jsh_history")).then(() => {
    console.log("history loaded", pathJoin(homedir(), ".jsh_history"));
});
Process.start();
