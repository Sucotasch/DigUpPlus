import Foundation
import Testing
@testable import DigUpKit

/// The read-only MCP surface: the protocol (initialize, tools, errors) and the three tools' answers and budgets.
@Suite final class MCPTests {
    let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DigUpMCPTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return URL(fileURLWithPath: FolderSelection.realPath(url.path), isDirectory: true)
    }()

    deinit { try? FileManager.default.removeItem(at: folder) }

    /// An index of `count` documents that all match "budgetword", with a 100-character excerpt each.
    func index(count: Int) throws -> IndexStore {
        let store = try IndexStore(directory: folder)
        for number in 0..<count {
            let path = folder.appendingPathComponent("note-\(number).txt").path
            let id = try store.insert(Candidate(path: path, kind: .doc, size: 100, mtime: 1, inode: UInt64(number + 1),
                                                device: 1))
            try store.addSegment(file: id, kind: .chunk, modality: .text, loc: 1,
                                 excerpt: String(repeating: "x", count: 100),
                                 text: "budgetword note number \(number) " + String(repeating: "words ", count: 30))
        }
        return store
    }

    func call(_ server: MCPServer, _ method: String, _ params: [String: Any]? = nil, id: Int = 1) -> [String: Any] {
        var request: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
        if let params { request["params"] = params }
        let line = String(decoding: try! JSONSerialization.data(withJSONObject: request), as: UTF8.self)
        let reply = server.handle(line)!
        return try! JSONSerialization.jsonObject(with: Data(reply.utf8)) as! [String: Any]
    }

    /// The JSON a tool answered with, and whether it said `isError`.
    func tool(_ server: MCPServer, _ name: String, _ arguments: [String: Any] = [:]) throws -> (answer: [String: Any], failed: Bool) {
        let reply = call(server, "tools/call", ["name": name, "arguments": arguments])
        let result = try #require(reply["result"] as? [String: Any])
        let content = try #require(result["content"] as? [[String: Any]]).first
        let text = try #require(content?["text"] as? String)
        guard result["isError"] as? Bool != true else { return (["message": text], true) }
        let answer = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        return (answer, false)
    }

    @Test func initializeAndToolsWorkWithoutAnIndex() throws {
        let server = MCPServer(index: folder.appendingPathComponent("no-index"))
        let ready = call(server, "initialize", ["protocolVersion": "2024-11-05"])
        let result = try #require(ready["result"] as? [String: Any])
        #expect(result["protocolVersion"] as? String == "2024-11-05")
        #expect((result["serverInfo"] as? [String: Any])?["name"] as? String == "digup")
        let tools = call(server, "tools/list")["result"] as? [String: Any]
        let listed = try #require(tools?["tools"] as? [[String: Any]])
        #expect(listed.compactMap { $0["name"] as? String } == ["search", "read_snippet", "index_state"])
        // Read-only by design: nothing that writes, moves or deletes.
        #expect(!listed.contains { ($0["name"] as? String)?.contains("write") == true })
        // A tool on an index that isn't there says so, and initialize still answered.
        let empty = try tool(server, "search", ["query": "anything"])
        #expect(empty.failed)
        #expect((empty.answer["message"] as? String ?? empty.answer["text"] as? String ?? "").contains("no index"))
    }

    @Test func notificationsUnknownMethodsAndBadJSON() throws {
        let server = MCPServer(index: folder)
        #expect(server.handle(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#) == nil)
        #expect(server.handle("not json")?.contains("-32700") == true)
        #expect(server.handle(#"{"jsonrpc":"2.0","id":1,"method":"nope"}"#)?.contains("-32601") == true)
        let unknownTool = call(server, "tools/call", ["name": "delete_everything", "arguments": [:]])
        #expect((unknownTool["error"] as? [String: Any])?["code"] as? Int == -32602)
        #expect(call(server, "ping")["result"] != nil)
    }

    @Test func invalidParametersAreRefused() throws {
        _ = try index(count: 3)
        let server = MCPServer(index: folder)
        func error(_ arguments: [String: Any]) -> Int? {
            (call(server, "tools/call", ["name": "search", "arguments": arguments])["error"] as? [String: Any])?["code"] as? Int
        }
        #expect(error(["query": "budgetword", "limit": 0]) == -32602)
        #expect(error(["query": "budgetword", "limit": 51]) == -32602)
        #expect(error(["query": "budgetword", "offset": -1]) == -32602)
        #expect(error(["query": "budgetword", "offset": 10_001]) == -32602)
        #expect(error(["query": "budgetword", "kinds": ["movie"]]) == -32602)
        #expect(error([:]) == -32602)   // no query
    }

    @Test func aSearchPageCarriesSnippetsAndWhereToGoNext() throws {
        _ = try index(count: 30)
        let server = MCPServer(index: folder)
        let page = try tool(server, "search", ["query": "budgetword", "limit": 50])
        #expect(!page.failed)
        let results = try #require(page.answer["results"] as? [[String: Any]])
        // The answer's budget ends the page before 30 long rows: it says so and where to continue.
        #expect(page.answer["truncated"] as? Bool == true)
        #expect(page.answer["total"] as? Int == 30)
        #expect(results.count < 30 && !results.isEmpty)
        #expect((results[0]["snippet"] as? String).map { (1...100).contains($0.count) } == true)
        #expect(results[0]["segment_id"] as? Int != nil)
        #expect((page.answer["next_offset"] as? Int) == results.count)
        #expect((page.answer["as_of"] as? Double ?? 0) > 0)

        let next = try tool(server, "search", ["query": "budgetword", "limit": 50, "offset": 20])
        let tail = try #require(next.answer["results"] as? [[String: Any]])
        #expect(tail.count == 10)
        #expect((next.answer["next_offset"] as? Int) == 30)
        #expect(next.answer["truncated"] as? Bool == false)

        let narrow = try tool(server, "search", ["query": "budgetword", "limit": 2, "offset": 0])
        #expect((narrow.answer["results"] as? [[String: Any]])?.count == 2)
        #expect((narrow.answer["next_offset"] as? Int) == 2)
    }

    @Test func readSnippetGivesAWindowAndStaysInTheIndex() throws {
        let store = try index(count: 2)
        let path = folder.appendingPathComponent("note-0.txt").path
        let file = try #require(try store.file(at: path))
        var segmentID: Int64?
        var otherFileSegment: Int64?
        try store.db.query("SELECT id FROM segments WHERE file = ? AND kind = 'chunk'", [.int(file.id)]) {
            segmentID = $0.int(0)
        }
        try store.db.query("""
            SELECT s.id FROM segments s JOIN files f ON f.id = s.file
            WHERE f.path != ? AND s.kind = 'chunk' LIMIT 1
            """, [.text(path)]) { otherFileSegment = $0.int(0) }
        let server = MCPServer(index: folder)
        let first = try #require(segmentID)
        let read = try tool(server, "read_snippet", ["path": path, "segment_id": first, "max_tokens": 32])
        #expect(!read.failed)
        #expect((read.answer["text"] as? String)?.count == 128)   // 32 tokens ≈ 4 characters each
        #expect(read.answer["truncated"] as? Bool == true)
        // A segment of another file, an unindexed path and a path outside the scope are refused.
        let otherSegment = try #require(otherFileSegment)
        let wrong = call(server, "tools/call", ["name": "read_snippet", "arguments": ["path": path, "segment_id": otherSegment]])
        #expect((wrong["error"] as? [String: Any])?["code"] as? Int == -32602)
        let missing = try tool(server, "read_snippet", ["path": folder.appendingPathComponent("nope.txt").path])
        #expect(missing.failed)
        let scoped = MCPServer(index: folder, roots: [folder.appendingPathComponent("photos").path])
        let outside = call(scoped, "tools/call", ["name": "read_snippet", "arguments": ["path": path]])
        #expect((outside["error"] as? [String: Any])?["code"] as? Int == -32602)
        #expect((outside["error"] as? [String: Any])?["message"] as? String == "path is outside the configured agent scope: \(path)")
    }

    @Test func vectorsFromAnotherModelAreNotUsed() throws {
        let store = try index(count: 2)
        let path = folder.appendingPathComponent("note-0.txt").path
        let file = try #require(try store.file(at: path))
        var vector = [Float](repeating: 0, count: Vectors.dimension)
        vector[0] = 1
        try store.addSegment(file: file.id, kind: .chunk, modality: .text, loc: 1, text: "budgetword", vector: vector)
        try store.setMeta("vector_source", "model A")
        var asked = false
        let server = MCPServer(index: folder, vectors: { _, _ in asked = true; return nil }, vectorSource: { "model B" })
        let page = try tool(server, "search", ["query": "budgetword"])
        #expect(page.answer["meaning"] as? Bool == false)
        #expect((page.answer["note"] as? String)?.contains("model A") == true)
        #expect(!asked)   // the model wasn't even loaded: its vectors can't be compared with these
    }

    @Test func indexStateCountsWhatIsThere() throws {
        _ = try index(count: 4)
        let server = MCPServer(index: folder, roots: [folder.path])
        let state = try tool(server, "index_state")
        #expect(!state.failed)
        #expect(state.answer["files"] as? Int == 4)
        #expect((state.answer["kinds"] as? [String: Int])?["doc"] == 4)
        #expect(state.answer["pending"] as? Int == 4)   // inserted, not read yet
        #expect((state.answer["as_of"] as? Double ?? 0) > 0)
        #expect(state.answer["roots"] as? [String] == [folder.path])
        // The code index is a file of its own, and there is none here.
        #expect(state.answer["code"] as? Bool == false)
        let code = try tool(server, "search", ["query": "budgetword", "code": true])
        #expect(code.failed)
    }
}
