// The stub launcher.
//
// It exists to hold the macOS Documents grant, which makes it the security
// boundary. Its whole contract: locate node, run the CLI script with the
// arguments it was given, relay the exit code. No other logic, ever. Anything
// that can live in bin/ or lib/ lives there, where editing it keeps the grant.
//
// `scriptPath` is fixed at build time in BuildConfig.swift, which build.sh
// generates. While the app is ad-hoc signed its identity is its hash, so any
// rebuild drops the grant (Apple TN3127).
//
// posix_spawn, never exec: the stub stays alive as the responsible process, so
// the grant it holds covers the node child and everything node runs.

import Darwin

// Fixed locations first, so a PATH entry cannot substitute a different node.
var candidates = [
    "/opt/homebrew/opt/node@22/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
]
if let path = getenv("PATH") {
    for dir in String(cString: path).split(separator: ":") {
        candidates.append("\(dir)/node")
    }
}

guard let node = candidates.first(where: { access($0, X_OK) == 0 }) else {
    fputs("stub: node not found\n", stderr)
    exit(127)
}

let args = [node, scriptPath] + CommandLine.arguments.dropFirst()
var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]

var pid: pid_t = 0
let rc = posix_spawn(&pid, node, nil, nil, &cargs, environ)
if rc != 0 {
    fputs("stub: posix_spawn failed: \(String(cString: strerror(rc)))\n", stderr)
    exit(126)
}

var status: Int32 = 0
while waitpid(pid, &status, 0) == -1 && errno == EINTR {}

// WIFEXITED / WEXITSTATUS / WTERMSIG are macros Swift cannot import.
let signal = status & 0x7f
exit(signal == 0 ? (status >> 8) & 0xff : 128 + signal)
