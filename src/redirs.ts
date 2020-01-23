import { Redirection, RedirectionType, RedirectionIOType } from "../native/process";

function makeRedirection(redir: any, type: RedirectionType, sourceFD: number)
{
    if (redir.type === "ampinteger") {
        return {
            redirectionType: type,
            ioType: RedirectionIOType.FD,
            sourceFD: sourceFD,
            destFD: redir.value
        };
    } else {
        return {
            redirectionType: type,
            ioType: RedirectionIOType.File,
            file: redir.value.toString(),
            sourceFD: sourceFD,
            destFD: -1
        }
    }
}

export function parseRedirections(redirs: any): Redirection[]
{
    if (!(redirs instanceof Array) || (redirs.length % 2) != 0) {
        throw new Error("Redirs needs to be an array and it's length needs to be divisible by 2");
    }
    let out: Redirection[] = [];
    if (!redirs.length) {
        return out;
    }
    for (let i = 0; i < redirs.length; i += 2) {
        switch (redirs[i].type) {
        case "nsleft":
            out.push(makeRedirection(redirs[i + 1], RedirectionType.Input, redirs[i].value));
            break;
        case "sleft":
            out.push(makeRedirection(redirs[i + 1], RedirectionType.Input, 0));
            break;
        case "nsright":
            out.push(makeRedirection(redirs[i + 1], RedirectionType.Output, redirs[i].value));
            break;
        case "sright":
            out.push(makeRedirection(redirs[i + 1], RedirectionType.Output, 1));
            break;
        case "nsrightright":
            out.push(makeRedirection(redirs[i + 1], RedirectionType.OutputAppend, redirs[i].value));
            break;
        case "srightright":
            out.push(makeRedirection(redirs[i + 1], RedirectionType.OutputAppend, 1));
            break;
        case "ampsright":
            if (redirs[i + 1].type === "ampinteger") {
                throw new Error("Can't have &[n] after &>");
            }
            out.push(makeRedirection(redirs[i + 1], RedirectionType.Output, 1));
            out.push(makeRedirection(redirs[i + 1], RedirectionType.Output, 2));
            break;
        case "ampsrightright":
            if (redirs[i + 1].type === "ampinteger") {
                throw new Error("Can't have &[n] after &>>");
            }
            out.push(makeRedirection(redirs[i + 1], RedirectionType.OutputAppend, 1));
            out.push(makeRedirection(redirs[i + 1], RedirectionType.OutputAppend, 2));
            break;
        case "nsleftright":
            if (redirs[i + 1].type === "ampinteger") {
                throw new Error("Can't have &[n] after [n]<>");
            }
            out.push(makeRedirection(redirs[i + 1], RedirectionType.InputOutput, redirs[i].value));
            break;
        case "sleftright":
            if (redirs[i + 1].type === "ampinteger") {
                throw new Error("Can't have &[n] after <>");
            }
            out.push(makeRedirection(redirs[i + 1], RedirectionType.InputOutput, 0));
            break;
        }
    }
    return out;
}
