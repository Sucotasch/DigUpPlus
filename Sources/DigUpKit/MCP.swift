// The read-only MCP surface `digup mcp` offers an agent: three tools over one index, spoken as newline-delimited
// JSON-RPC 2.0 (the stdio loop that reads and writes it is Sources/digup/MCPService.swift). Requests are handled one at
// a time on one thread, so the searchers and their vectors need no locking.
//
// v1 is read-only on purpose: no tool writes, moves or deletes, and a path can only be read when the index holds it.
// The numbers are kensaku's (MIT), which were checked against real agent sessions: a page of 10 results (50 at most),
// a 100-character snippet, a 1500-token (≈6000-character) budget for a whole answer, and 32–1024 tokens (≈4 characters
// a token) for a read, always a window and never a whole file.

import Foundation

public final class MCPServer {
    /// A tool asked for something it can't have: `invalidParams` is JSON-RPC -32602, anything else `isError`.
    struct Problem: Error {
        let message: String
        let invalidParams: Bool
        init(_ message: String, invalidParams: Bool = false) {
            self.message = message
            self.invalidParams = invalidParams
        }
    }

    static let protocolVersion = "2024-11-05"
    static let snippetCharacters = 100
    static let answerCharacters = 6000
    static let pageLimit = 50
    static let pageDefault = 10
    static let maxOffset = 10_000
    static let readTokens = 32...1024

    let index: URL
    /// Folders every path must be under (`--root`): none means anything the index holds.
    let roots: [String]
    /// A query vector for a meaning search: nil when there's no model, and the search is by words alone.
    let vectors: (String, Bool) throws -> [Float]?
    /// The model the vectors would come from (`LlamaEmbedder.modelInfo.vectorSource`), to refuse to mix models.
    let vectorSource: () -> String?
    /// What `index_state` says about the model (the CLI's own view).
    let model: () -> [String: Any]
    private var searchers: [Bool: Searcher] = [:]

    public init(index: URL, roots: [String] = [], vectors: @escaping (String, Bool) throws -> [Float]? = { _, _ in nil },
                vectorSource: @escaping () -> String? = { nil },
                model: @escaping () -> [String: Any] = { [:] }) {
        self.index = index
        self.roots = roots.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).path }
        self.vectors = vectors
        self.vectorSource = vectorSource
        self.model = model
    }

    /// One request in, one answer out; nil for a notification (the protocol says those get none).
    public func handle(_ line: String) -> String? {
        guard let data = line.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return message(id: NSNull(), error: -32700, "the request isn't JSON")
        }
        let method = request["method"] as? String ?? ""
        let id = request["id"]   // a request without one is a notification; the protocol says to keep quiet
        guard let id else { return nil }
        let params = request["params"] as? [String: Any] ?? [:]
        switch method {
        case "initialize":
            return message(id: id, result: ["protocolVersion": Self.protocolVersion,
                                            "capabilities": ["tools": [:]],
                                            "serverInfo": ["name": "digup", "version": Self.version]])
        case "ping":
            return message(id: id, result: [:])
        case "tools/list":
            return message(id: id, result: ["tools": Self.tools])
        case "tools/call":
            return call(id: id, params: params)
        default:
            return message(id: id, error: -32601, "no method \(method)")
        }
    }

    /// The version an agent sees. The helper has no bundle of its own to read it from: keep this in step with
    /// `shell/src-tauri/tauri.conf.json` (a test in `MCPTests` checks the two match).
    static let version = "0.1.10"

    // MARK: Tools

    static var tools: [[String: Any]] {
        return [
        ["name": "search",
         "description": "Search the files DigUp Plus has indexed: names, text, OCR and meaning. Returns ranked files "
             + "with a short snippet, the place that matched (PDF page, seconds into a recording) and a segment_id for "
             + "read_snippet. Read-only.",
         "inputSchema": [
            "type": "object",
            "properties": [
                "query": ["type": "string", "description": "What to look for, in words."],
                "kinds": ["type": "array", "items": ["type": "string", "enum": FileKind.allCases.map(\.rawValue)],
                          "description": "Only these kinds: screenshots, pictures, PDFs, documents, recordings, videos."],
                "limit": ["type": "integer", "minimum": 1, "maximum": 50, "default": 10],
                "offset": ["type": "integer", "minimum": 0, "maximum": 10000, "default": 0],
                "meaning": ["type": "boolean", "default": true,
                            "description": "Search by meaning too (needs the model); false is words only."],
                "code": ["type": "boolean", "default": false, "description": "Search the code index instead."],
            ],
            "required": ["query"],
         ]],
        ["name": "read_snippet",
         "description": "Read a window of the text of one indexed file: the page, passage or code stretch that matched, "
             + "never the whole file. Pass the segment_id search returned, or a query to pick the passage.",
         "inputSchema": [
            "type": "object",
            "properties": [
                "path": ["type": "string", "description": "A file search returned."],
                "segment_id": ["type": "integer", "description": "The segment search returned (or read before)."],
                "query": ["type": "string", "description": "Which passage matters, when no segment_id is given."],
                "max_tokens": ["type": "integer", "minimum": 32, "maximum": 1024, "default": 200],
                "code": ["type": "boolean", "default": false, "description": "The file is in the code index."],
            ],
            "required": ["path"],
         ]],
        ["name": "index_state",
         "description": "What the index holds: files by kind and state, what's still waiting, the model, and how old "
             + "the index is (as_of, seconds since 1970).",
         "inputSchema": ["type": "object", "properties": [:]]],
    ]
    }

    private func call(id: Any, params: [String: Any]) -> String {
        let name = params["name"] as? String ?? ""
        let arguments = params["arguments"] as? [String: Any] ?? [:]
        do {
            let answer: [String: Any]
            switch name {
            case "search": answer = try search(arguments)
            case "read_snippet": answer = try readSnippet(arguments)
            case "index_state": answer = try indexState()
            default: throw Problem("no tool \(name)", invalidParams: true)
            }
            return message(id: id, result: ["content": [["type": "text", "text": Self.json(answer)]], "isError": false])
        } catch let problem as Problem {
            if problem.invalidParams { return message(id: id, error: -32602, problem.message) }
            return message(id: id, result: ["content": [["type": "text", "text": problem.message]], "isError": true])
        } catch {
            return message(id: id, result: ["content": [["type": "text", "text": "\(error)"]], "isError": true])
        }
    }

    /// `search`: a page of the ranking, its snippets within the answer's character budget.
    private func search(_ arguments: [String: Any]) throws -> [String: Any] {
        var query = try text(arguments["query"], "query").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { throw Problem("query is empty", invalidParams: true) }
        var code = arguments["code"] as? Bool ?? false
        if let words = CodeQuery.text(of: query) {   // the CLI's "code: …" prefix works here too
            query = words
            code = true
            guard !query.isEmpty else { throw Problem("search the code for what?", invalidParams: true) }
        }
        guard let kindsValue = arguments["kinds"] else { return try searchPage(query, kinds: nil, code: code, arguments) }
        guard let names = kindsValue as? [String] else { throw Problem("kinds must be a list of kinds", invalidParams: true) }
        var kinds = Set<FileKind>()
        for name in names {
            guard let kind = FileKind(rawValue: name) else {
                throw Problem("no kind \(name): \(FileKind.allCases.map(\.rawValue).joined(separator: ", "))",
                              invalidParams: true)
            }
            kinds.insert(kind)
        }
        return try searchPage(query, kinds: kinds.isEmpty ? nil : kinds, code: code, arguments)
    }

    private func searchPage(_ query: String, kinds: Set<FileKind>?, code: Bool, _ arguments: [String: Any]) throws -> [String: Any] {
        let limit = try number(arguments["limit"], "limit", in: 1...Self.pageLimit) ?? Self.pageDefault
        let offset = try number(arguments["offset"], "offset", in: 0...Self.maxOffset) ?? 0
        let meaning = arguments["meaning"] as? Bool ?? true
        let searcher = try searcher(code: code)
        // Vectors from another model would match everything a little and nothing well: words only, and say why.
        var note: String?
        var vector: [Float]?
        if meaning, searcher.vectorCount > 0, let source = vectorSource() {
            if let indexed = searcher.vectorSource, indexed != source {
                note = "the index's vectors come from \(indexed), not \(source): searching words only until it is indexed again"
            } else {
                vector = try vectors(query, code)
            }
        }
        let page = try searcher.page(query, queryVector: vector, kinds: kinds, limit: limit, offset: offset)
        var rows: [[String: Any]] = []
        for hit in page.hits {
            var row: [String: Any] = ["path": hit.path, "kind": hit.kind.rawValue, "segment_id": hit.segmentID,
                                      "score": (hit.score * 1000).rounded() / 1000,
                                      "size": hit.size, "modified": hit.modified]
            if let loc = hit.loc { row["loc"] = loc }
            if let end = hit.locEnd { row["loc_end"] = end }
            if let excerpt = hit.excerpt, !excerpt.isEmpty {
                row["snippet"] = String(excerpt.prefix(Self.snippetCharacters))
            }
            rows.append(row)
            // The whole answer stays within a model's comfort: beyond it, the page ends early and says so.
            if Self.json(["results": rows]).utf8.count > Self.answerCharacters {
                rows.removeLast()
                break
            }
        }
        let next = min(page.offset + page.consumed, page.total)
        // A page cut short by the budget continues where it stopped, not where the whole page would have.
        let continues = page.offset + (rows.count < page.hits.count ? rows.count : page.consumed)
        var answer: [String: Any] = ["query": query, "results": rows, "total": page.total, "offset": page.offset,
                                     "next_offset": continues > page.offset ? min(continues, page.total) : NSNull(),
                                     "truncated": rows.count < page.hits.count, "meaning": vector != nil, "code": code,
                                     "as_of": asOf() ?? NSNull()]
        if next > page.offset, next > Self.maxOffset {
            answer["next_offset"] = NSNull()
            answer["cursor_limit_reached"] = true
        }
        if let note { answer["note"] = note }
        return answer
    }

    /// `read_snippet`: one segment's text, trimmed to the asked window, centred on the query where it appears.
    private func readSnippet(_ arguments: [String: Any]) throws -> [String: Any] {
        let path = try scoped(try text(arguments["path"], "path"))
        let code = arguments["code"] as? Bool ?? false
        let tokens = try number(arguments["max_tokens"], "max_tokens", in: Self.readTokens) ?? 200
        let searcher = try searcher(code: code)
        guard let file = try searcher.store.file(at: path) else {
            throw Problem("\(path) isn't in the index")
        }
        var segment: Int64?
        if let given = try number(arguments["segment_id"], "segment_id", in: 0...Int.max).map(Int64.init) {
            var owner: Int64?
            try searcher.store.db.query("SELECT file FROM segments WHERE id = ?", [.int(given)]) { owner = $0.int(0) }
            guard owner == file.id else {
                throw Problem("segment \(given) isn't in \(path)", invalidParams: true)
            }
            segment = given
        } else {
            segment = try passage(of: file, query: arguments["query"] as? String, searcher: searcher)
        }
        guard let id = segment, let full = try searcher.text(ofSegment: id), !full.isEmpty else {
            throw Problem("\(path) has no text in the index (a picture or a recording's sound): search it instead")
        }
        var loc: Double?
        var locEnd: Double?
        try searcher.store.db.query("SELECT loc, loc_end FROM segments WHERE id = ?", [.int(id)]) {
            loc = $0.double(0)
            locEnd = $0.double(1)
        }
        let window = Self.window(full, around: arguments["query"] as? String, characters: tokens * 4)
        var answer: [String: Any] = ["path": path, "segment_id": id, "text": window.text,
                                     "truncated": window.truncated, "max_tokens": tokens]
        if let loc { answer["loc"] = loc }
        if let locEnd { answer["loc_end"] = locEnd }
        return answer
    }

    /// `index_state`: counts, the model, and when the index last changed.
    private func indexState() throws -> [String: Any] {
        let searcher = try searcher(code: false)
        let counts = try searcher.store.counts()
        var kinds: [String: Int] = [:]
        var states: [String: Int] = [:]
        for (kind, byState) in counts.byKindAndState {
            for (state, count) in byState {
                kinds[kind, default: 0] += count
                states[state, default: 0] += count
            }
        }
        return ["files": kinds.values.reduce(0, +), "kinds": kinds, "states": states,
                "searchable": (states["done"] ?? 0) + (states["partial"] ?? 0),
                "pending": try searcher.store.pendingCount(),
                "unfinished": try searcher.store.unfinishedCount().files,
                "roots": roots.isEmpty ? NSNull() : roots,
                "as_of": asOf() ?? NSNull(),
                "model": model(),
                "code": FileManager.default.fileExists(atPath: index.appendingPathComponent(IndexStore.codeFile).path)]
    }

    // MARK: Pieces

    private func searcher(code: Bool) throws -> Searcher {
        if let open = searchers[code] { return open }
        let file = index.appendingPathComponent(code ? IndexStore.codeFile : IndexStore.mainFile)
        guard FileManager.default.fileExists(atPath: file.path) else {
            throw Problem("no index at \(index.path) yet: open DigUp Plus once, or index a folder")
        }
        let searcher = try Searcher(store: try IndexStore(directory: index, file: file.lastPathComponent))
        searchers[code] = searcher
        return searcher
    }

    /// The file has to be one the index holds and, when `--root` gave folders, under one of them.
    private func scoped(_ path: String) throws -> String {
        let normalized = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL.path
        let real = FolderSelection.realPath(normalized)
        guard roots.isEmpty || roots.contains(where: { FolderSelection.isInside(real, $0) }) else {
            throw Problem("path is outside the configured agent scope: \(path)", invalidParams: true)
        }
        return real
    }

    /// The segment of `file` that matches the query best (by words), else its first with text: the name entry only
    /// carries its folder's path, which answers nothing.
    private func passage(of file: FileRecord, query: String?, searcher: Searcher) throws -> Int64? {
        if let query, !query.isEmpty {
            let terms = Searcher.terms(query)
            if let pattern = Searcher.patterns(terms, prefixLast: false).first {
                var id: Int64?
                try searcher.store.db.query("""
                    SELECT s.id FROM fts JOIN segments s ON s.id = fts.rowid
                    WHERE s.file = ? AND s.kind != 'name' AND fts MATCH ? ORDER BY rank LIMIT 1
                    """, [.int(file.id), .text(pattern)]) { id = $0.int(0) }
                if let id { return id }
            }
        }
        var id: Int64?
        try searcher.store.db.query("""
            SELECT s.id FROM segments s JOIN fts ON fts.rowid = s.id
            WHERE s.file = ? AND s.kind != 'name' AND length(coalesce(fts.original, fts.body)) > 0
            ORDER BY s.id LIMIT 1
            """, [.int(file.id)]) { id = $0.int(0) }
        return id
    }

    /// A window of `characters` around the query's first word, or from the start when it isn't there.
    static func window(_ text: String, around query: String?, characters: Int) -> (text: String, truncated: Bool) {
        guard text.count > characters else { return (text, false) }
        var start = 0
        if let query, let term = Searcher.terms(query).first,
           let found = text.range(of: term, options: .caseInsensitive) {
            let at = text.distance(from: text.startIndex, to: found.lowerBound)
            start = max(0, min(at - characters / 3, text.count - characters))
        }
        let end = min(text.count, start + characters)
        return (String(text.dropFirst(start).prefix(characters)), end < text.count || start > 0)
    }

    /// When the index was last written: the newer of the database and its write-ahead log.
    func asOf() -> Double? {
        let file = index.appendingPathComponent(IndexStore.mainFile)
        let dates = [file.path, file.path + "-wal"].compactMap { path -> Date? in
            let attributes = try? FileManager.default.attributesOfItem(atPath: path)
            return attributes?[.modificationDate] as? Date
        }
        return dates.map(\.timeIntervalSince1970).max()
    }

    private func number(_ value: Any?, _ name: String, in range: ClosedRange<Int>) throws -> Int? {
        guard let value else { return nil }
        guard let number = value as? Int, range.contains(number) else {
            throw Problem("\(name) must be an integer in \(range.lowerBound)…\(range.upperBound)", invalidParams: true)
        }
        return number
    }

    private func text(_ value: Any?, _ name: String) throws -> String {
        guard let text = value as? String else { throw Problem("\(name) must be a string", invalidParams: true) }
        return text
    }

    static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    private func message(id: Any, result: [String: Any]) -> String {
        Self.json(["jsonrpc": "2.0", "id": id, "result": result])
    }

    private func message(id: Any, error code: Int, _ text: String) -> String {
        Self.json(["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": text]])
    }
}
