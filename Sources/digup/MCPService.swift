// `digup mcp`: the read-only MCP server over this index (the protocol itself is Sources/DigUpKit/MCP.swift). One process
// per agent session, spoken over stdin and stdout as newline-delimited JSON-RPC 2.0; stdout carries the protocol and
// nothing else, so diagnostics go to stderr. The model is brought up lazily and only when a meaning search needs it:
// words-only search, and every other tool, work without one.

import DigUpKit
import Foundation

/// `digup mcp [--root DIR]... [--print-config claude-desktop|claude-code|cursor]`.
func mcpService(_ args: Arguments) throws -> Int32 {
    if let target = args.values["--print-config"] {
        let known = ["claude-desktop", "claude-code", "cursor"]
        guard known.contains(target) else {
            throw CLIError("--print-config takes \(known.joined(separator: ", ")), not \(target)")
        }
        print(try mcpConfig(args, target: target))
        return 0
    }
    let folder = args.indexFolder
    var embedder: (any Embedder)?
    let server = MCPServer(index: folder, roots: args.lists["--root"] ?? [], vectors: { text, code in
        if embedder == nil {
            embedder = try makeEmbedder(textOnly: true, log: folder.appendingPathComponent("worker-query.log"))
        }
        return try embedder?.embedTexts([code ? Prompts.codeQuery(text) : Prompts.query(text)]).first
    }, vectorSource: { embedderSource() }, model: {
        guard let source = embedderSource() else { return ["ready": false] }
        return ["ready": true, "source": source]
    })
    while let line = readLine(strippingNewline: true) {
        guard let reply = server.handle(line) else { continue }
        try? FileHandle.standardOutput.write(contentsOf: Data((reply + "\n").utf8))
    }
    embedder?.close()
    return 0
}

/// The JSON an agent's config takes as it is, with this executable and index: Claude Desktop's and Claude Code's
/// `mcpServers` object, and Cursor's (the same shape in `~/.cursor/mcp.json`).
func mcpConfig(_ args: Arguments, target: String) throws -> String {
    let executable = Bundle.main.executableURL?.path ?? CommandLine.arguments[0]
    var command = ["mcp", "--index", args.indexFolder.path]
    for root in args.lists["--root"] ?? [] {
        command += ["--root", URL(fileURLWithPath: (root as NSString).expandingTildeInPath).path]
    }
    let config: [String: Any] = ["mcpServers": ["digup": ["command": executable, "args": command]]]
    guard let data = try? JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { throw CLIError("the config couldn't be written") }
    let where_ = target == "cursor" ? "~/.cursor/mcp.json"
        : target == "claude-code" ? ".mcp.json in your project (or `claude mcp add`)" : "claude_desktop_config.json"
    FileHandle.standardError.write(Data("add this to \(where_); DigUp Plus only reads the index, never writes it\n".utf8))
    return text
}
