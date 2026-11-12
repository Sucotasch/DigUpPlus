import Foundation

/// A file as the index knows it.
public struct FileRecord: Sendable {
    public let id: Int64
    public let path: String
    public let kind: FileKind
    public let size: Int64
    public let mtime: Double
    public let inode: UInt64
    public let device: UInt64
    public let state: String
    /// Why it was skipped or failed, or how far a long file has been read.
    public let detail: String?
    /// A recording read by its tags alone (`Candidate.tagsOnly`): the way it's read, kept so a restart reads it the
    /// same and a rule change can tell what changed.
    public let tagsOnly: Bool
}

/// The on-disk index: one SQLite file with files, their segments (with fp16 vectors), and an FTS5 table.
///
/// Vectors live in the same database as everything else, so a crash can never leave them out of step with the
/// rows that describe them. At this scale (~20k vectors, ~30 MB) brute-force search over an in-memory copy is a
/// few milliseconds; no vector database needed.
public final class IndexStore {
    public let directory: URL
    public let db: Database
    static let schemaVersion: Int64 = 7

    /// Keyword search's tokenizer. Marks (M*) count as letters, so Bengali vowel signs and Arabic harakat stay inside
    /// their words: by default SQLite splits on them ("কলকাতায়" became "কলক", "ত", "য").
    static let tokenizer = "porter unicode61 remove_diacritics 2 categories 'L* N* Co M*'"
    /// Keyword search's table: words are matched in `body`, normalized (`SearchText`); `original` keeps the text as it's
    /// written when normalizing changed it (Arabic with hamza or harakat, Bengali with joiners), for showing it.
    static let ftsColumns = "name, body, original UNINDEXED, tokenize = \"\(tokenizer)\""

    /// When set, `pending`, `pendingCount` and `counts` see only files under these folders: the app's helper sets the
    /// folders that are connected right now, so files on an unplugged drive neither fail nor count as waiting.
    public var scope: [String]? {
        didSet { scopeReady = false }
    }
    private var scopeReady = false
    /// The ranges live in a temporary table: one chosen folder is two ranges, and SQLite refuses an expression of about
    /// a thousand terms ("Expression tree is too large", upstream #166), so a few hundred folders stopped every query.
    /// Joining the small table lets each range scan the UNIQUE path index instead.
    private static let scopeJoinSQL = " JOIN digup_scope ON files.path >= digup_scope.lo AND files.path < digup_scope.hi"

    /// The `JOIN` that narrows a query on `files` to the scope's ranges (empty without a scope).
    private func scopeJoin() throws -> String {
        guard let scope else { return "" }
        if scopeReady { return Self.scopeJoinSQL }
        try db.execute("CREATE TEMP TABLE IF NOT EXISTS digup_scope(lo TEXT NOT NULL, hi TEXT NOT NULL)")
        try db.run("DELETE FROM digup_scope")
        let ranges = Self.mergedRanges(scope.flatMap(Self.pathRanges(under:)))
        try db.transaction {
            for range in ranges {
                try db.run("INSERT INTO digup_scope(lo, hi) VALUES(?, ?)", [.text(range.from), .text(range.to)])
            }
        }
        scopeReady = true
        return Self.scopeJoinSQL
    }

    /// Ranges that overlap or touch, as one: a nested chosen folder and the two spellings of one folder would otherwise
    /// match a path twice through the join.
    static func mergedRanges(_ ranges: [(from: String, to: String)]) -> [(from: String, to: String)] {
        var out: [(from: String, to: String)] = []
        for range in ranges.sorted(by: { $0.from < $1.from }) {
            if let last = out.last, range.from <= last.to {
                out[out.count - 1].to = max(last.to, range.to)
            } else {
                out.append(range)
            }
        }
        return out
    }

    /// The ranges of the UNIQUE path index that hold the files under `folder`. Paths are stored as a walk reports them,
    /// which isn't always how the folder is spelled here: `standardizedFileURL` says /var where the walk says
    /// /private/var, and decomposes a name with accents or Hangul that the disk keeps precomposed ("Café", Google
    /// Drive's "내 드라이브"). Swift's `==` takes those for the same folder; SQLite compares bytes. So: a range for the
    /// folder as given, and one for its real path when that's spelled differently.
    static func pathRanges(under folder: String) -> [(from: String, to: String)] {
        var spellings = [folder, FolderSelection.capitalisedDrive(folder)]
        let real = FolderSelection.realPath(folder)
        if !real.utf8.elementsEqual(folder.utf8) { spellings.append(real) }
        var seen = Set<String>()
        return spellings.filter { seen.insert($0).inserted }.map { path in
            let prefix = path.hasSuffix("/") ? path : path + "/"
            return (prefix, prefix + "\u{10FFFF}")
        }
    }

    /// The main index's file in the index folder.
    public static let mainFile = "index.sqlite"
    /// The code index (`IndexOptions.code`) is a file of its own beside it: code search never moves the rest (its
    /// meaning scale, its keyword results, the vectors search keeps in memory), and turning it off deletes one file.
    public static let codeFile = "code.sqlite"

    public let file: URL

    public init(directory: URL, file name: String = IndexStore.mainFile) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.directory = directory
        file = directory.appendingPathComponent(name)
        db = try Database(path: file.path)
        try migrate()
    }

    /// Bytes on disk: the database and its write-ahead log.
    public static func size(of file: URL) -> Int64 {
        [file.path, file.path + "-wal"].reduce(0) { total, path in
            total + ((try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int64) ?? 0)
        }
    }

    /// Schema changes ship as one migration each, and the layout below was designed to need as few as possible
    /// (every forced migration is paid for by every user).
    private func migrate() throws {
        var version: Int64 = 0
        try db.query("PRAGMA user_version") { version = $0.int(0) }
        guard version <= Self.schemaVersion else {
            throw Database.Failure(message: "this index was made by a newer DigUp (schema \(version))")
        }
        guard version < Self.schemaVersion else {
            try checkPhashRecipe()
            return
        }
        // The app and its helper can open the index at the same moment: one migrates while the other waits for it (up
        // to a minute, not the usual 5 s), then sees it done.
        try db.execute("PRAGMA busy_timeout = 60000")
        defer { try? db.execute("PRAGMA busy_timeout = 5000") }
        try db.transaction {
            try db.query("PRAGMA user_version") { version = $0.int(0) }
            if version == 0 { try create() }
            if version == 1 { try migrateKeywordSearch() }
            if (1...2).contains(version) { try migrateScreenshotText() }
            if (1...3).contains(version) { try migrateVectorNames() }
            if (1...4).contains(version) { try migrateLongFiles() }
            if (1...5).contains(version) { try migrateTagsOnly() }
            if (1...6).contains(version) { try migratePhash() }
        }
        try checkPhashRecipe()
    }

    private func create() throws {
        try db.execute("""
            CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE files(
                id INTEGER PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime REAL NOT NULL,
                inode INTEGER NOT NULL,
                device INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending',   -- pending | done | partial | skipped | failed
                detail TEXT,                              -- why skipped/failed, or how far a long file has been read
                info TEXT,                                -- JSON: pixels, pages, duration, date taken; read_to/read_end
                indexed_at REAL,
                tags_only INTEGER NOT NULL DEFAULT 0,     -- a recording read by its tags alone
                phash BLOB                                -- Phash256 of a picture: Find similar's groups
            );
            CREATE INDEX files_inode ON files(device, inode);
            CREATE INDEX files_state ON files(state, kind);
            CREATE TABLE segments(
                id INTEGER PRIMARY KEY,
                file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,       -- SegmentKind
                modality TEXT NOT NULL,   -- Modality of the vector ('none' when there is no vector)
                loc REAL,                 -- PDF page number, or start second for audio/video
                loc_end REAL,
                excerpt TEXT,
                vec BLOB                  -- 768 × float16, L2-normalized
            );
            CREATE INDEX segments_file ON segments(file);
            CREATE VIRTUAL TABLE fts USING fts5(\(Self.ftsColumns));
            INSERT INTO meta(key, value) VALUES('phash_recipe', '\(Phash256.recipe)');
            PRAGMA user_version = \(Self.schemaVersion);
            """)
    }

    /// Schema 1 → 2: keyword search with whole Bengali and Arabic words (`tokenizer`) over normalized text
    /// (`SearchText`). The words are rebuilt from what's stored, without reading any file. PDFs whose text layer came
    /// out garbled (`PageTextProblem`) are queued again, to be read as pictures or by OCR.
    private func migrateKeywordSearch() throws {
        try db.execute("CREATE VIRTUAL TABLE fts_new USING fts5(\(Self.ftsColumns))")
        // Row by row: an index can hold tens of megabytes of text, and the app may be the one migrating.
        try db.query("SELECT rowid, name, body FROM fts") { row in
            let body = row.text(2) ?? ""
            try db.run("INSERT INTO fts_new(rowid, name, body, original) VALUES(?, ?, ?, ?)",
                       [.int(row.int(0)), .text(SearchText.normalized(row.text(1) ?? ""))] + Self.keywordText(body))
        }
        var garbled = Set<Int64>()
        try db.query("""
            SELECT s.file, fts.body FROM fts JOIN segments s ON s.id = fts.rowid JOIN files f ON f.id = s.file
            WHERE f.kind = 'pdf' AND s.kind IN ('page', 'page_image')
            """) { row in
            if PageTextProblem.check(row.text(1) ?? "") != nil { garbled.insert(row.int(0)) }
        }
        try db.execute("DROP TABLE fts; ALTER TABLE fts_new RENAME TO fts; PRAGMA user_version = 2;")
        for file in garbled { try requeue(file) }
    }

    /// Schema 2 → 3: a screenshot's OCR text is for keyword search only, and its meaning comes from the picture. The
    /// text vectors made screenshots outrank better matches in the evals; they go, nothing is read again.
    private func migrateScreenshotText() throws {
        try db.execute("UPDATE segments SET vec = NULL, modality = 'none' WHERE kind = 'ocr'; PRAGMA user_version = 3;")
    }

    /// Schema 3 → 4: indexes name their vectors by a vector version, not by the llama.cpp build that made them, so a
    /// llama.cpp update that leaves the vectors alone keeps the index (`LlamaEmbedder.vectorVersion`). Every index so
    /// far comes from b11461, which made version 1. Nothing is embedded again.
    private func migrateVectorNames() throws {
        try db.execute("""
            UPDATE meta SET value = replace(value, ' llama.cpp-b11461-metal ', ' llama.cpp-vectors1 ')
            WHERE key IN ('fingerprint', 'vector_source');
            PRAGMA user_version = 4;
            """)
    }

    /// Schema 4 → 5: long files are finished after the first pass (`Indexer.finishLongFiles`), from where they stopped,
    /// which until now was always page 30 of a PDF over 50 pages (already `partial`) and chunk 40 of a document (`done`,
    /// with 40 chunks). Those documents become `partial`; how many chunks they have is guessed from their length until
    /// the later pass counts them. And text that's mostly digits loses its vectors (`SearchText.hasWords`), as it
    /// would if it were indexed now. Nothing is read or embedded here.
    private func migrateLongFiles() throws {
        var digits: [Int64] = []
        try db.query("""
            SELECT s.id, coalesce(fts.original, fts.body) FROM segments s JOIN fts ON fts.rowid = s.id
            WHERE s.kind IN ('page', 'chunk') AND s.vec IS NOT NULL
            """) { row in
            if !SearchText.hasWords(row.text(1) ?? "") { digits.append(row.int(0)) }
        }
        for id in digits { try db.run("UPDATE segments SET vec = NULL, modality = 'none' WHERE id = ?", [.int(id)]) }
        let limits = IndexOptions()
        try db.execute("""
            UPDATE files SET detail = 'read to page 30', info = json_set(info, '$.read_to', '30', '$.read_end',
                CAST(MIN(CAST(json_extract(info, '$.pages') AS INTEGER), \(limits.maxPages)) AS TEXT))
            WHERE kind = 'pdf' AND state = 'partial' AND info IS NOT NULL;
            UPDATE files SET state = 'partial', detail = 'read to chunk 40', info = json_set(info, '$.read_to', '40',
                '$.read_end', CAST(MIN(MAX(41, (CAST(json_extract(info, '$.chars') AS INTEGER) + 1599) / 1600),
                                       \(limits.maxChunks)) AS TEXT))
            WHERE kind = 'doc' AND state = 'done' AND json_extract(info, '$.chunks') = '40';
            PRAGMA user_version = 5;
            """)
    }

    /// Schema 5 → 6: a recording's way of being read is kept with its row (`tags_only`), so the indexer knows after a
    /// restart and a rule change can re-read exactly what changed. Rows that were already read by their tags (`info`
    /// says so, what 0.1.6 wrote) start as such; nothing is read again for them. A test index can be a current schema
    /// with an older version stamped on it, so the column is added only when it isn't there.
    private func migrateTagsOnly() throws {
        var hasColumn = false
        try db.query("PRAGMA table_info(files)") { row in
            if row.text(1) == "tags_only" { hasColumn = true }
        }
        try db.transaction {
            if !hasColumn {
                try db.run("ALTER TABLE files ADD COLUMN tags_only INTEGER NOT NULL DEFAULT 0")
            }
            try db.run("UPDATE files SET tags_only = 1 WHERE json_extract(info, '$.tags') = '1'")
            try db.execute("PRAGMA user_version = 6")
        }
    }

    /// Schema 6 → 7: a picture's look-alike fingerprint, for Find similar's groups. Pictures indexed from now on get
    /// one as they are read; older rows are filled by `digup phash`, and a picture without one simply doesn't group
    /// (nothing is read or re-embedded here).
    private func migratePhash() throws {
        var hasColumn = false
        try db.query("PRAGMA table_info(files)") { row in
            if row.text(1) == "phash" { hasColumn = true }
        }
        try db.transaction {
            if !hasColumn { try db.execute("ALTER TABLE files ADD COLUMN phash BLOB") }
            try db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('phash_recipe', ?)",
                       [.text(Phash256.recipe)])
            try db.execute("PRAGMA user_version = 7")
        }
    }

    /// The fingerprint recipe changed: every stored hash was made the old way, and two recipes together would group
    /// nothing. They go, to be computed again; the pictures and their vectors are untouched.
    private func checkPhashRecipe() throws {
        guard try meta("phash_recipe") != Phash256.recipe else { return }
        try db.transaction {
            try db.execute("UPDATE files SET phash = NULL")
            try db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('phash_recipe', ?)",
                       [.text(Phash256.recipe)])
        }
    }

    // MARK: Meta

    public func meta(_ key: String) throws -> String? {
        var value: String?
        try db.query("SELECT value FROM meta WHERE key = ?", [.text(key)]) { value = $0.text(0) }
        return value
    }

    public func setMeta(_ key: String, _ value: String?) throws {
        if let value {
            try db.run("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                       [.text(key), .text(value)])
        } else {
            try db.run("DELETE FROM meta WHERE key = ?", [.text(key)])
        }
    }

    // MARK: Files

    static let fileColumns = "id, path, kind, size, mtime, inode, device, state, detail, tags_only"

    static func record(_ row: Statement) -> FileRecord {
        FileRecord(id: row.int(0), path: row.text(1) ?? "", kind: FileKind(rawValue: row.text(2) ?? "") ?? .doc,
                   size: row.int(3), mtime: row.double(4), inode: UInt64(bitPattern: row.int(5)),
                   device: UInt64(bitPattern: row.int(6)), state: row.text(7) ?? "pending", detail: row.text(8),
                   tagsOnly: row.int(9) != 0)
    }

    /// Every file under one of `roots`.
    public func files(under roots: [String]) throws -> [FileRecord] {
        var out: [FileRecord] = []
        var seen = Set<Int64>()   // each file once, also where two spellings of a folder meet
        // A folder inside another one listed is already covered.
        for root in roots where !roots.contains(where: { FolderSelection.isInside(root, $0) }) {
            for range in Self.pathRanges(under: root) {
                try db.query("SELECT \(Self.fileColumns) FROM files WHERE path >= ? AND path < ?",
                             [.text(range.from), .text(range.to)]) { row in
                    let record = Self.record(row)
                    if seen.insert(record.id).inserted { out.append(record) }
                }
            }
        }
        return out
    }

    /// The file at a path, as the index has it. A search returns paths from here, so they match exactly; a file moved or
    /// deleted since then isn't found.
    public func file(at path: String) throws -> FileRecord? {
        var found: FileRecord?
        try db.query("SELECT \(Self.fileColumns) FROM files WHERE path = ?", [.text(path)]) { found = Self.record($0) }
        return found
    }

    /// The file with this id, if the index still has it.
    public func file(_ id: Int64) throws -> FileRecord? {
        var found: FileRecord?
        try db.query("SELECT \(Self.fileColumns) FROM files WHERE id = ?", [.int(id)]) { found = Self.record($0) }
        return found
    }

    /// The fingerprints of these pictures, by path: what Find similar's groups are made from. A path without one (a
    /// picture indexed before schema 7, or a format with no reader) is left out.
    public func phashes(for paths: [String]) throws -> [String: Phash256] {
        var hashes: [String: Phash256] = [:]
        var start = 0
        while start < paths.count {
            let chunk = Array(paths[start..<min(paths.count, start + 400)])
            start += chunk.count
            let marks = Array(repeating: "?", count: chunk.count).joined(separator: ",")
            try db.query("SELECT path, phash FROM files WHERE path IN (\(marks))", chunk.map { .text($0) }) { row in
                guard let data = row.blob(1), let hash = Phash256(data: data) else { return }
                hashes[row.text(0) ?? ""] = hash
            }
        }
        return hashes
    }

    /// Keeps a picture's fingerprint; nothing else about the file changes.
    public func setPhash(_ hash: Phash256, file: Int64) throws {
        try db.run("UPDATE files SET phash = ? WHERE id = ?", [.blob(hash.data), .int(file)])
    }

    /// Pictures still without a fingerprint, newest first, for `digup phash`.
    public func filesMissingPhash(limit: Int) throws -> [(id: Int64, path: String)] {
        var files: [(id: Int64, path: String)] = []
        try db.query("SELECT id, path FROM files WHERE phash IS NULL AND kind IN ('image', 'screenshot') "
                     + "ORDER BY mtime DESC LIMIT ?", [.int(Int64(limit))]) { row in
            files.append((row.int(0), row.text(1) ?? ""))
        }
        return files
    }

    /// Adds a file (pending) and returns its id.
    @discardableResult
    public func insert(_ file: Candidate) throws -> Int64 {
        try db.transaction {   // the row and its name entry together
            try db.run("INSERT INTO files(path, kind, size, mtime, inode, device, tags_only) VALUES(?, ?, ?, ?, ?, ?, ?)",
                       [.text(file.path), .text(file.kind.rawValue), .int(file.size), .double(file.mtime),
                        .int(Int64(bitPattern: file.inode)), .int(Int64(bitPattern: file.device)),
                        .int(file.tagsOnly ? 1 : 0)])
            let id = db.lastInsertID
            try addNameRow(file: id, path: file.path)
            return id
        }
    }

    /// The file changed on disk: drop what was extracted from it and queue it again.
    public func requeue(_ id: Int64, as file: Candidate) throws {
        try db.transaction {
            try deleteSegments(of: id, keepingName: true)
            try db.run("""
                UPDATE files SET kind = ?, size = ?, mtime = ?, inode = ?, device = ?, tags_only = ?, state = 'pending',
                    detail = NULL, info = NULL, indexed_at = NULL WHERE id = ?
                """, [.text(file.kind.rawValue), .int(file.size), .double(file.mtime),
                      .int(Int64(bitPattern: file.inode)), .int(Int64(bitPattern: file.device)),
                      .int(file.tagsOnly ? 1 : 0), .int(id)])
        }
    }

    /// Extract and embed the file again, as it is (after a better way to read it arrived).
    func requeue(_ id: Int64) throws {
        try db.transaction {
            try deleteSegments(of: id, keepingName: true)
            try db.run("UPDATE files SET state = 'pending', detail = NULL, info = NULL, indexed_at = NULL WHERE id = ?",
                       [.int(id)])
        }
    }

    /// Recordings read by tags whose rows carry only the old `"tags": 1` marker (0.1.6 kept no fields): they are read
    /// again once, so the window and the panel can show title, artist and album. Returns how many.
    @discardableResult
    public func requeueTagsWithoutFields() throws -> Int {
        var ids: [Int64] = []
        try db.query("""
            SELECT id FROM files WHERE tags_only = 1 AND json_extract(info, '$.tags') = '1'
                AND json_extract(info, '$.title') IS NULL AND json_extract(info, '$.artist') IS NULL
                AND json_extract(info, '$.album') IS NULL
            """) { ids.append($0.int(0)) }
        for id in ids { try requeue(id) }
        return ids.count
    }

    /// Every row under these folders is read again (its segments dropped, the row pending): Settings → Folders →
    /// Re-read, where a person asks for a folder to be read from scratch. Returns how many.
    @discardableResult
    public func requeue(under roots: [String]) throws -> Int {
        let files = try files(under: roots)
        for file in files { try requeue(file.id) }
        return files.count
    }

    /// What re-pointing a folder looks like: the rows under it, and what is at the new place for each — the same file
    /// (size and time, so its vectors stay), a changed one, or nothing.
    public struct RepointCounts: Sendable {
        public var rows = 0, matched = 0, changed = 0, missing = 0
    }

    /// What `repoint(from:to:)` would do, changing nothing.
    public func repointPreview(from: String, to: String) throws -> RepointCounts {
        try repointRows(from: from, to: to, apply: false)
    }

    /// A folder moved: the rows under `from` take their paths at `to` (and the file's own identity there), their name
    /// rows are rewritten, and their vectors stay for the files that didn't change. A file that is gone at the new
    /// place keeps its row until the next sync removes it. Settings → Folders asks first, with `repointPreview`'s
    /// counts. Refuses a target that holds indexed rows already, and folders that overlap.
    @discardableResult
    public func repoint(from: String, to: String) throws -> RepointCounts {
        try repointRows(from: from, to: to, apply: true)
    }

    private func repointRows(from: String, to: String, apply: Bool) throws -> RepointCounts {
        let fromFolder = FolderSelection.crawlPath(from)
        let toFolder = FolderSelection.crawlPath(to)
        guard fromFolder != toFolder, !FolderSelection.isInside(toFolder, fromFolder),
              !FolderSelection.isInside(fromFolder, toFolder) else {
            throw Database.Failure(message: "that's the same folder, or one is inside the other")
        }
        guard FileManager.default.fileExists(atPath: toFolder) else {
            throw Database.Failure(message: "there's no folder at \(to)")
        }
        guard try files(under: [toFolder]).isEmpty else {
            throw Database.Failure(message: "that folder is already searched: stop searching it first, then re-pick")
        }
        let rows = try files(under: [fromFolder])
        let fromPrefix = fromFolder.hasSuffix("/") ? fromFolder : fromFolder + "/"
        let toPrefix = toFolder.hasSuffix("/") ? toFolder : toFolder + "/"
        var counts = RepointCounts(rows: rows.count)
        try db.transaction {
            for row in rows {
                let newPath = toPrefix + String(row.path.dropFirst(fromPrefix.count))
                guard let info = FileSystem.info(of: newPath), info.isRegular else {
                    counts.missing += 1
                    if apply { try move(row.id, to: newPath) }
                    continue
                }
                if info.size == row.size && abs(info.mtime - row.mtime) <= 0.001 {
                    counts.matched += 1
                } else {
                    counts.changed += 1
                }
                if apply {
                    try move(row.id, to: newPath, inode: info.inode, device: info.device, size: info.size,
                             mtime: info.mtime)
                }
            }
        }
        return counts
    }

    /// Removes every row under these folders while the folders stay searched: Settings → Folders → “files deleted”.
    /// Returns how many rows left.
    @discardableResult
    public func delete(under roots: [String]) throws -> Int {
        let rows = try files(under: roots)
        try batch { for row in rows { try delete(row.id) } }
        return rows.count
    }

    /// Same inode, size and date at a new path: a move or rename. Nothing is re-embedded (screenshot tools move
    /// screenshots into project folders all the time). Where the new place gives the file another identity — another
    /// volume has its own device and inode — those and its size and date go with the path, so the next sync knows the
    /// row is this file and doesn't read it again.
    public func move(_ id: Int64, to path: String, inode: UInt64? = nil, device: UInt64? = nil, size: Int64? = nil,
                     mtime: Double? = nil) throws {
        try db.transaction {   // the path and its name entry together
            try db.run("""
                UPDATE files SET path = ?, inode = coalesce(?, inode), device = coalesce(?, device),
                    size = coalesce(?, size), mtime = coalesce(?, mtime) WHERE id = ?
                """, [.text(path), inode.map { .int(Int64(bitPattern: $0)) } ?? .null,
                      device.map { .int(Int64(bitPattern: $0)) } ?? .null, size.map { .int($0) } ?? .null,
                      mtime.map { .double($0) } ?? .null, .int(id)])
            try db.run("""
                UPDATE fts SET name = ?, body = ? WHERE rowid IN (SELECT id FROM segments WHERE file = ? AND kind = 'name')
                """, [.text(SearchText.normalized(Self.nameText(path))), .text(SearchText.normalized(Self.folderText(path))),
                      .int(id)])
        }
    }

    /// Several changes as one commit: the work inside keeps its own savepoints (`move`, `delete`), so one that fails
    /// undoes only itself. For a batch of thousands, one fsync instead of one per file.
    public func batch<T>(_ body: () throws -> T) throws -> T { try db.transaction(body) }

    /// Removes a file, its keyword text and its segments (a savepoint where `prune` or a sync is already writing).
    public func delete(_ id: Int64) throws {
        try db.transaction {
            try db.run("DELETE FROM fts WHERE rowid IN (SELECT id FROM segments WHERE file = ?)", [.int(id)])
            try db.run("DELETE FROM files WHERE id = ?", [.int(id)])
        }
    }

    /// Removes every file that isn't under one of `roots` (folders taken out of the app). Returns how many went.
    @discardableResult
    public func prune(keepingUnder roots: [String]) throws -> Int {
        let prefixes = roots.flatMap { Self.pathRanges(under: $0).map(\.from) }   // a folder under /var: /private/var too
        var gone: [Int64] = []
        try db.query("SELECT id, path FROM files") { row in
            let path = row.text(1) ?? ""
            if !prefixes.contains(where: { path.hasPrefix($0) }) { gone.append(row.int(0)) }
        }
        guard !gone.isEmpty else { return 0 }
        try db.transaction {
            for id in gone { try delete(id) }
        }
        return gone.count
    }

    /// Queues every file again and forgets the fingerprint (after the model or settings changed).
    public func resetAll() throws {
        try db.transaction {
            try db.run("DELETE FROM fts WHERE rowid IN (SELECT id FROM segments WHERE kind != 'name')")
            try db.run("DELETE FROM segments WHERE kind != 'name'")
            try db.run("UPDATE files SET state = 'pending', detail = NULL, info = NULL, indexed_at = NULL")
            try setMeta("fingerprint", nil)
        }
    }

    /// Files waiting to be embedded, in indexing order; `only` narrows it to some files (just-added ones).
    public func pending(limit: Int?, only ids: Set<Int64>? = nil) throws -> [FileRecord] {
        var out: [FileRecord] = []
        if let ids, ids.isEmpty { return out }
        let join = try scopeJoin()
        let filter = ids.map { " AND id IN (\($0.map(String.init).joined(separator: ",")))" } ?? ""
        try db.query("""
            SELECT \(Self.fileColumns) FROM files\(join) WHERE state = 'pending'\(filter)
            ORDER BY \(FileKind.indexingOrderSQL), mtime DESC LIMIT ?
            """, [.int(Int64(limit ?? -1))]) { out.append(Self.record($0)) }
        return out
    }

    public func pendingCount() throws -> Int {
        var count = 0
        let join = try scopeJoin()
        try db.query("SELECT COUNT(*) FROM files\(join) WHERE state = 'pending'") {
            count = Int($0.int(0))
        }
        return count
    }

    /// Long files with pages or chunks still to read after their first step, in indexing order (`pending`'s).
    public func unfinished() throws -> [FileRecord] {
        var out: [FileRecord] = []
        let join = try scopeJoin()
        try db.query("""
            SELECT \(Self.fileColumns) FROM files\(join) WHERE state = 'partial'
            ORDER BY \(FileKind.indexingOrderSQL), mtime DESC
            """) { out.append(Self.record($0)) }
        return out
    }

    /// How many long files are unfinished, and how many of their pages and chunks are left to read.
    public func unfinishedCount() throws -> (files: Int, left: Int) {
        var count = (files: 0, left: 0)
        let join = try scopeJoin()
        try db.query("""
            SELECT COUNT(*), SUM(MAX(0, CAST(json_extract(info, '$.read_end') AS INTEGER)
                                      - CAST(json_extract(info, '$.read_to') AS INTEGER)))
            FROM files\(join) WHERE state = 'partial'
            """) { count = (Int($0.int(0)), Int($0.int(1))) }
        return count
    }

    /// What indexing learned about a file (`finish`'s `info`).
    public func info(of id: Int64) throws -> [String: String] {
        var info: [String: String] = [:]
        try db.query("SELECT info FROM files WHERE id = ?", [.int(id)]) { row in
            if let json = row.text(0)?.data(using: .utf8) {
                info = (try? JSONSerialization.jsonObject(with: json) as? [String: String]) ?? [:]
            }
        }
        return info
    }

    /// The last page or chunk stored for a file (where a long file's reading got to, when its info doesn't say).
    func lastPlace(of id: Int64) throws -> Int? {
        var last: Int?
        try db.query("SELECT MAX(loc) FROM segments WHERE file = ? AND kind IN ('page', 'page_image', 'chunk')",
                     [.int(id)]) { last = $0.isNull(0) ? nil : Int($0.double(0)) }
        return last
    }

    public func finish(_ id: Int64, state: String, detail: String? = nil, info: [String: String] = [:]) throws {
        let json = info.isEmpty ? nil : (try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys]))
            .flatMap { String(data: $0, encoding: .utf8) }
        try db.run("UPDATE files SET state = ?, detail = ?, info = ?, indexed_at = ? WHERE id = ?",
                   [.text(state), .optional(detail), .optional(json), .double(Date().timeIntervalSince1970), .int(id)])
    }

    /// Files read once more because DigUp reads them better now, each kind once per index (the schema stays as it was,
    /// so an older DigUp still opens the index): PDFs with pages read as pictures, whose words come from OCR now
    /// (`meta` "scans_ocr"), pictures that couldn't be read at all, like SVGs, which AppKit draws now
    /// ("pictures_drawn"), and pictures embedded by 0.1.12's Windows decoder, which read WIC's four-byte row padding
    /// as packed pixels and so vectorized a torn copy ("pictures_repacked"). Only where this machine does any of it.
    /// Returns how many files.
    @discardableResult
    public func readAgainOnce() throws -> Int {
        var files = Set<Int64>(), flags: [String] = []
        if OCR.isAvailable, try meta("scans_ocr") == nil {
            try db.query("SELECT DISTINCT file FROM segments WHERE kind = 'page_image'") { files.insert($0.int(0)) }
            flags.append("scans_ocr")
        }
        if ImageExtractor.drawsVectorPictures, try meta("pictures_drawn") == nil {
            try db.query("SELECT id FROM files WHERE kind = 'image' AND state = 'skipped' AND detail = ?",
                         [.text(ExtractError.tooSmall(0, 0).description)]) { files.insert($0.int(0)) }
            flags.append("pictures_drawn")
        }
        #if canImport(CWIC)
        if try meta("pictures_repacked") == nil {
            try db.query("SELECT id FROM files WHERE kind IN ('image', 'screenshot') AND state IN ('done', 'partial')")
            { files.insert($0.int(0)) }
            flags.append("pictures_repacked")
        }
        #endif
        guard !flags.isEmpty else { return 0 }
        try db.transaction {
            for file in files { try requeue(file) }
            for flag in flags { try setMeta(flag, "1") }
        }
        return files.count
    }

    /// A file the indexing helper had to stop on (reading it ran away): it isn't read again until it changes. A long
    /// file that was being finished keeps what was read of it. False when no file has that path.
    @discardableResult
    public func markStopped(_ path: String, why: String) throws -> Bool {
        var found: (id: Int64, state: String)?
        try db.query("SELECT id, state FROM files WHERE path = ?", [.text(path)]) { found = ($0.int(0), $0.text(1) ?? "") }
        guard let found else { return false }
        if found.state == "partial" {
            try finish(found.id, state: "done", detail: "The rest couldn't be read: it \(why)")
        } else {
            try finish(found.id, state: "failed", detail: "It \(why)")
        }
        return true
    }

    // MARK: Segments

    /// Adds a segment; `text` goes into keyword search (normalized, see `SearchText`), `vector` into meaning search.
    public func addSegment(file: Int64, kind: SegmentKind, modality: Modality, loc: Double? = nil, locEnd: Double? = nil,
                           excerpt: String? = nil, text: String? = nil, vector: [Float]? = nil) throws {
        try db.transaction {   // the segment and its keyword text together
            try db.run("INSERT INTO segments(file, kind, modality, loc, loc_end, excerpt, vec) VALUES(?, ?, ?, ?, ?, ?, ?)",
                       [.int(file), .text(kind.rawValue), .text(vector == nil ? Modality.none.rawValue : modality.rawValue),
                        .optional(loc), .optional(locEnd), .optional(excerpt),
                        vector.map { .blob(Vectors.half($0)) } ?? .null])
            if let text, !text.isEmpty {
                try db.run("INSERT INTO fts(rowid, name, body, original) VALUES(?, '', ?, ?)",
                           [.int(db.lastInsertID)] + Self.keywordText(text))
            }
        }
    }

    /// `body` and `original` for keyword search: the normalized text, and the text as written if that differs.
    static func keywordText(_ text: String) -> [SQLValue] {
        let normalized = SearchText.normalized(text)
        return [.text(normalized), normalized == text ? .null : .text(text)]
    }

    private func addNameRow(file: Int64, path: String) throws {
        try db.run("INSERT INTO segments(file, kind, modality) VALUES(?, 'name', 'none')", [.int(file)])
        try db.run("INSERT INTO fts(rowid, name, body) VALUES(?, ?, ?)",
                   [.int(db.lastInsertID), .text(SearchText.normalized(Self.nameText(path))),
                    .text(SearchText.normalized(Self.folderText(path)))])
    }

    private func deleteSegments(of file: Int64, keepingName: Bool) throws {
        let filter = keepingName ? "AND kind != 'name'" : ""
        try db.run("DELETE FROM fts WHERE rowid IN (SELECT id FROM segments WHERE file = ? \(filter))", [.int(file)])
        try db.run("DELETE FROM segments WHERE file = ? \(filter)", [.int(file)])
    }

    /// "Screenshot 2026-10-01 at 9.41.07 PM.png" → searchable words.
    static func nameText(_ path: String) -> String {
        (path as NSString).lastPathComponent
    }

    /// The folders a file sits in, relative to the home folder ("Downloads Invoices"), as low-weight keywords.
    static func folderText(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var folder = (path as NSString).deletingLastPathComponent
        if folder.hasPrefix(home) { folder = String(folder.dropFirst(home.count)) }
        return folder.split(separator: "/").joined(separator: " ")
    }

    // MARK: Stats

    public struct Counts: Sendable {
        public var byKindAndState: [String: [String: Int]] = [:]
        public var vectors = 0
        public var segments = 0
        /// Long files still being read (`unfinishedCount`), and their pages and chunks left.
        public var unfinished = 0
        public var left = 0
    }

    public func counts() throws -> Counts {
        var counts = Counts()
        let join = try scopeJoin()
        try db.query("SELECT kind, state, COUNT(*) FROM files\(join) WHERE 1 GROUP BY kind, state") {
            counts.byKindAndState[$0.text(0) ?? "?", default: [:]][$0.text(1) ?? "?"] = Int($0.int(2))
        }
        (counts.unfinished, counts.left) = try unfinishedCount()
        let inScope = scope == nil ? "" : " AND file IN (SELECT id FROM files\(join))"
        try db.query("SELECT COUNT(*), COUNT(vec) FROM segments WHERE kind != 'name'\(inScope)") {
            counts.segments = Int($0.int(0))
            counts.vectors = Int($0.int(1))
        }
        return counts
    }
}
