const loose = require("acorn-loose");
const readline = require("readline");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});


rl.prompt();

rl.on('line', (input) => {
    if (input === "exit") {
        process.exit();
    } else {
        console.log(JSON.stringify(loose.parse(input), null, 4));
        rl.prompt();
    }
});
