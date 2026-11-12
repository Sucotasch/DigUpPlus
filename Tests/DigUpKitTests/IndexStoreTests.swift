#if canImport(CryptoKit)
import CryptoKit
#endif
import Foundation
import Testing
@testable import DigUpKit
#if os(Windows)
import WinSDK
#endif

@Suite final class IndexStoreTests {
    let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DigUpTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    deinit { try? FileManager.default.removeItem(at: folder) }

    func file(_ path: String, inode: UInt64) -> Candidate {
        Candidate(path: path, kind: .image, size: 10, mtime: 1, inode: inode, device: 1)
    }

    @Test func anInnerTransactionsFailureLeavesTheOuterOne() throws {
        struct Oops: Error {}
        let store = try IndexStore(directory: folder)
        try store.db.transaction {
            try store.insert(file(folder.appendingPathComponent("a.txt").path, inode: 1))
            #expect(throws: Oops.self) {
                try store.db.transaction {
                    try store.insert(file(folder.appendingPathComponent("b.txt").path, inode: 2))
                    throw Oops()
                }
            }
            try store.insert(file(folder.appendingPathComponent("c.txt").path, inode: 3))
        }
        let names = try store.files(under: [folder.path]).map { ($0.path as NSString).lastPathComponent }.sorted()
        #expect(names == ["a.txt", "c.txt"])
    }

    @Test func pruneKeepsOnlyChosenFolders() throws {
        let store = try IndexStore(directory: folder)
        try store.insert(file("/a/x.png", inode: 1))
        try store.insert(file("/a/sub/y.png", inode: 2))
        try store.insert(file("/ab/z.png", inode: 3))   // a sibling whose name starts like "/a", not inside it
        try store.insert(file("/b/w.png", inode: 4))
        #expect(try store.prune(keepingUnder: ["/a"]) == 2)
        #expect(try store.files(under: ["/a"]).count == 2)
        #expect(try store.files(under: ["/ab", "/b"]).isEmpty)
        var keywordRows = 0
        try store.db.query("SELECT COUNT(*) FROM fts") { keywordRows = Int($0.int(0)) }
        #expect(keywordRows == 2)   // the pruned files' names left keyword search too
        #expect(try store.prune(keepingUnder: []) == 2)
    }

    @Test func scopeLimitsWhatIsWaiting() throws {
        let store = try IndexStore(directory: folder)
        try store.insert(file("/a/x.png", inode: 1))
        try store.insert(file("/drive/y.png", inode: 2))   // on a drive that's unplugged
        store.scope = ["/a"]
        #expect(try store.pendingCount() == 1)
        #expect(try store.pending(limit: nil).map(\.path) == ["/a/x.png"])
        #expect(try store.counts().byKindAndState["image"]?["pending"] == 1)
        store.scope = []
        #expect(try store.pendingCount() == 0)
        store.scope = nil
        #expect(try store.pendingCount() == 2)
    }

    /// One chosen folder is two path ranges; an expression of about a thousand terms makes SQLite refuse every query
    /// ("Expression tree is too large", upstream #166), so a few hundred folders used to stop indexing. The ranges
    /// live in a temporary table now.
    @Test func hundredsOfFoldersDoNotBreakTheScope() throws {
        let store = try IndexStore(directory: folder)
        try store.insert(file("/a/x.png", inode: 1))
        try store.insert(file("/b/y.png", inode: 2))
        var roots = (0..<1200).map { "/chosen/folder-\($0)" }
        roots.append("/a")
        store.scope = roots
        #expect(try store.pendingCount() == 1)
        #expect(try store.pending(limit: nil).map(\.path) == ["/a/x.png"])
        #expect(try store.counts().byKindAndState["image"]?["pending"] == 1)
        store.scope = ["/b"]
        #expect(try store.pending(limit: nil).map(\.path) == ["/b/y.png"])
        #expect(try store.counts().vectors == 0)
    }

    #if os(Windows)
    /// A folder typed with another case for its drive letter still finds the rows the crawl stored ("c:/" vs "C:/"):
    /// SQLite compares path ranges byte by byte.
    @Test func aScopeWithAnotherDriveLetterCaseStillMatches() throws {
        let store = try IndexStore(directory: folder)
        try store.insert(file("C:/a/x.png", inode: 1))
        store.scope = ["c:/a"]
        #expect(try store.pendingCount() == 1)
        #expect(try store.pending(limit: nil).map(\.path) == ["C:/a/x.png"])
    }
    #endif

    /// Nested folders and the two spellings of one folder match one path once.
    @Test func overlappingRangesAreMerged() {
        let ranges = IndexStore.mergedRanges([("/a/", "/a/\u{10FFFF}"), ("/a/b/", "/a/b/\u{10FFFF}"),
                                              ("/c/", "/c/\u{10FFFF}")])
        #expect(ranges.count == 2)
        #expect(ranges[0].from == "/a/")
        #expect(ranges[0].to == "/a/\u{10FFFF}")
    }

    /// A folder that moved: the rows follow it, the file's own facts come from the new place, the name row's folder
    /// text is rewritten, and the preview says what is there before anything changes.
    @Test func aMovedFolderKeepsItsRows() throws {
        let store = try IndexStore(directory: folder.appendingPathComponent("index"))
        let old = folder.appendingPathComponent("old"), new = folder.appendingPathComponent("new")
        try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: new, withIntermediateDirectories: true)
        let oldFile = old.appendingPathComponent("a.txt")
        try Data("hello".utf8).write(to: oldFile)
        let info = try #require(FileSystem.info(of: oldFile.path))
        let id = try store.insert(Candidate(path: oldFile.path, kind: .doc, size: info.size, mtime: info.mtime,
                                            inode: info.inode, device: info.device))
        try store.addSegment(file: id, kind: .chunk, modality: .text, text: "hello")
        try FileManager.default.copyItem(at: oldFile, to: new.appendingPathComponent("a.txt"))
        let preview = try store.repointPreview(from: old.path, to: new.path)
        #expect(preview.rows == 1 && preview.matched == 1 && preview.changed == 0 && preview.missing == 0)
        #expect(try store.file(at: oldFile.path)?.id == id)   // the preview changes nothing
        let counts = try store.repoint(from: old.path, to: new.path)
        #expect(counts.matched == 1)
        let moved = new.appendingPathComponent("a.txt").path
        #expect(try store.file(at: moved)?.id == id)
        #expect(try store.file(at: oldFile.path) == nil)
        var body = ""
        try store.db.query("""
            SELECT body FROM fts WHERE rowid = (SELECT id FROM segments WHERE file = ? AND kind = 'name')
            """, [.int(id)]) { body = $0.text(0) ?? "" }
        #expect(body.lowercased().contains("new"))
    }

    /// A file that changed or is gone at the new place is counted, not silently kept as the same one.
    @Test func aMoveCountsChangedAndMissingFiles() throws {
        let store = try IndexStore(directory: folder.appendingPathComponent("index"))
        let old = folder.appendingPathComponent("old"), new = folder.appendingPathComponent("new")
        try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: new, withIntermediateDirectories: true)
        for (name, text) in [("same.txt", "same"), ("changed.txt", "long enough"), ("gone.txt", "gone")] {
            let url = old.appendingPathComponent(name)
            try Data(text.utf8).write(to: url)
            let info = try #require(FileSystem.info(of: url.path))
            _ = try store.insert(Candidate(path: url.path, kind: .doc, size: info.size, mtime: info.mtime,
                                           inode: info.inode, device: info.device))
        }
        try FileManager.default.copyItem(at: old.appendingPathComponent("same.txt"),
                                         to: new.appendingPathComponent("same.txt"))
        try FileManager.default.copyItem(at: old.appendingPathComponent("changed.txt"),
                                         to: new.appendingPathComponent("changed.txt"))
        try Data("x".utf8).write(to: new.appendingPathComponent("changed.txt"))
        let preview = try store.repointPreview(from: old.path, to: new.path)
        #expect(preview.rows == 3 && preview.matched == 1 && preview.changed == 1 && preview.missing == 1)
        _ = try store.repoint(from: old.path, to: new.path)
        #expect(try store.files(under: [new.path]).count == 3)   // the next sync removes the gone one
    }

    /// A target that already holds rows, and folders that overlap, are refused: a re-point is a move, not a merge.
    @Test func aRepointRefusesAnOccupiedOrOverlappingTarget() throws {
        let store = try IndexStore(directory: folder.appendingPathComponent("index"))
        let old = folder.appendingPathComponent("old"), new = folder.appendingPathComponent("new")
        try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: new.appendingPathComponent("sub"), withIntermediateDirectories: true)
        let oldFile = old.appendingPathComponent("a.txt")
        try "a".write(to: oldFile, atomically: false, encoding: .utf8)
        let info = try #require(FileSystem.info(of: oldFile.path))
        _ = try store.insert(Candidate(path: oldFile.path, kind: .doc, size: info.size, mtime: info.mtime,
                                       inode: info.inode, device: info.device))
        #expect(throws: (any Error).self) { try store.repoint(from: old.path, to: old.appendingPathComponent("sub").path) }
        _ = try store.insert(Candidate(path: new.appendingPathComponent("b.txt").path, kind: .doc, size: 1, mtime: 1,
                                       inode: 2, device: 1))
        #expect(throws: (any Error).self) { try store.repoint(from: old.path, to: new.path) }
    }

    /// “Files deleted”: the rows go, the folder can stay chosen.
    @Test func forgettingAFolderRemovesOnlyItsRows() throws {
        let store = try IndexStore(directory: folder.appendingPathComponent("index"))
        try store.insert(file("/a/x.png", inode: 1))
        try store.insert(file("/a/y.png", inode: 2))
        try store.insert(file("/b/z.png", inode: 3))
        #expect(try store.delete(under: ["/a"]) == 2)
        #expect(try store.files(under: ["/a"]).isEmpty)
        #expect(try store.files(under: ["/b"]).count == 1)
    }

    @Test func aFileTheHelperStoppedOnIsNotReadAgain() throws {
        let store = try IndexStore(directory: folder)
        try store.insert(file("/a/stuck.pdf", inode: 1))
        let book = try store.insert(file("/a/book.pdf", inode: 2))
        try store.finish(book, state: "partial", info: ["read_to": "30", "read_end": "463"])
        #expect(try store.markStopped("/a/stuck.pdf", why: "took more than 15 minutes to read"))
        #expect(try store.markStopped("/a/book.pdf", why: "took more than 15 minutes to read"))
        #expect(try !store.markStopped("/a/gone.pdf", why: "took more than 15 minutes to read"))
        #expect(try store.pendingCount() == 0)
        #expect(try store.unfinishedCount().files == 0)   // the book keeps its first pages and isn't finished again
        let states = Dictionary(uniqueKeysWithValues: try store.files(under: ["/a"]).map { ($0.path, $0.state) })
        #expect(states == ["/a/stuck.pdf": "failed", "/a/book.pdf": "done"])
    }

    #if canImport(AppKit)
    @Test func picturesThatCouldntBeReadAreReadOnceMore() throws {
        // An SVG skipped by an older DigUp as "small image 0×0" (ImageIO couldn't open it): AppKit draws it now.
        let store = try IndexStore(directory: folder)
        let svg = try store.insert(file("/a/chart.svg", inode: 1))
        try store.finish(svg, state: "skipped", detail: "small image 0×0")
        let icon = try store.insert(file("/a/icon.png", inode: 2))
        try store.finish(icon, state: "skipped", detail: "small image 160×160")   // small, and rightly skipped
        #expect(try store.readAgainOnce() == 1)
        #expect(try store.pending(limit: nil).map(\.path) == ["/a/chart.svg"])
        #expect(try store.readAgainOnce() == 0)
    }
    #endif

    #if canImport(CWIC)
    @Test func picturesEmbeddedByTheTornDecoderAreReadOnceMore() throws {
        // 0.1.12 on Windows read WIC's row padding as packed pixels, so a picture's vector described a torn copy.
        // Its segments go and the picture is queued again — once; a document keeps its own.
        let store = try IndexStore(directory: folder)
        try store.setMeta("scans_ocr", "1")
        try store.setMeta("pictures_drawn", "1")
        let picture = try store.insert(file("/a/photo.jpg", inode: 1))
        try store.addSegment(file: picture, kind: .image, modality: .image, vector: [1, 0, 0])
        try store.finish(picture, state: "done", info: ["width": "10"])
        let notes = try store.insert(Candidate(path: "/a/notes.txt", kind: .doc, size: 10, mtime: 1, inode: 2,
                                               device: 1))
        try store.addSegment(file: notes, kind: .chunk, modality: .text, text: "zorblat")
        try store.finish(notes, state: "done")
        #expect(try store.readAgainOnce() == 1)
        #expect(try store.pending(limit: nil).map(\.path) == ["/a/photo.jpg"])
        #expect(try store.file(notes)?.state == "done")
        #expect(try store.readAgainOnce() == 0)
    }
    #endif

    @Test func modelFileHashesStreamInPieces() throws {
        let small = folder.appendingPathComponent("abc")
        try Data("abc".utf8).write(to: small)
        #expect(try ModelFiles.sha256(of: small) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        // Bigger than one 8 MB piece.
        let bytes = Data((0..<(9 << 20)).map { UInt8(truncatingIfNeeded: $0 &* 31) })
        let big = folder.appendingPathComponent("big")
        try bytes.write(to: big)
        let expected = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        #expect(try ModelFiles.sha256(of: big) == expected)
    }

    @Test func missingModelFilesInDownloadOrder() throws {
        #expect(ModelFiles.missing(in: folder) == [ModelFiles.text, ModelFiles.media])
        let text = folder.appendingPathComponent(ModelFiles.text.name)
        _ = FileManager.default.createFile(atPath: text.path, contents: nil)
        try FileHandle(forWritingTo: text).truncate(atOffset: UInt64(ModelFiles.text.bytes))
        #expect(ModelFiles.missing(in: folder) == [ModelFiles.media])
        #expect(ModelFiles.totalBytes == 864_676_480)
    }

    @Test func modelFilesComeFromTheHuggingFaceCacheWhenThere() throws {
        // As `hf download` leaves them: snapshots/<revision>/<name> → a blob. Sparse, so no disk is used.
        let hub = folder.appendingPathComponent("hub")
        let snapshot = hub.appendingPathComponent("models--ggml-org--embeddinggemma-2-GGUF/snapshots/\(ModelFiles.revision)")
        let blobs = hub.appendingPathComponent("models--ggml-org--embeddinggemma-2-GGUF/blobs")
        try FileManager.default.createDirectory(at: snapshot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: blobs, withIntermediateDirectories: true)
        let blob = blobs.appendingPathComponent("2188ac1d")
        _ = FileManager.default.createFile(atPath: blob.path, contents: nil)
        try FileHandle(forWritingTo: blob).truncate(atOffset: UInt64(ModelFiles.text.bytes))
        try FileManager.default.createSymbolicLink(at: snapshot.appendingPathComponent(ModelFiles.text.name),
                                                   withDestinationURL: blob)
        setEnvironment("HF_HUB_CACHE", hub.path)
        defer { setEnvironment("HF_HUB_CACHE", nil) }
        #expect(ModelFiles.cachedCopy(of: ModelFiles.text)?.lastPathComponent == "2188ac1d")
        #expect(ModelFiles.cachedCopy(of: ModelFiles.media) == nil)   // not there
        try FileHandle(forWritingTo: blob).truncate(atOffset: 10)
        #expect(ModelFiles.cachedCopy(of: ModelFiles.text) == nil)    // not whole
    }

    @Test func syncKeepsTheRowsOfAFolderThatWentAway() throws {
        // The real path (/private/var/…), as the crawler reports it; resolvingSymlinksInPath() would drop "/private".
        let base = URL(fileURLWithPath: FolderSelection.realPath(folder.path))
        let drive = base.appendingPathComponent("drive")
        try FileManager.default.createDirectory(at: drive, withIntermediateDirectories: true)
        try Data("notes from the trip".utf8).write(to: drive.appendingPathComponent("notes.txt"))
        let store = try IndexStore(directory: base.appendingPathComponent("index"))
        let indexer = try Indexer(store: store, options: IndexOptions(),
                                  makeEmbedder: { throw WorkerError.notFound("no model needed to sync") })
        #expect(try indexer.sync([drive]).added == 1)
        try FileManager.default.moveItem(at: drive, to: base.appendingPathComponent("ejected"))
        #expect(try indexer.sync([drive]).removed == 0)   // an ejected drive is not "everything deleted"
        #expect(try store.files(under: [drive.path]).count == 1)
    }

    @Test func syncFindsTheRowsOfAFolderSpelledAnotherWay() throws {
        // The walk stores paths as the disk spells them, and on a Mac these folders are chosen spelled otherwise twice
        // over: under /var where the disk says /private/var (the temporary folder), and with a name the disk keeps
        // precomposed that `standardizedFileURL` decomposes (Google Drive's "내 드라이브", "Café"). Looking their rows up
        // by that spelling found none, so the second sync took every file for new: "UNIQUE constraint failed".
        let store = try IndexStore(directory: folder.appendingPathComponent("index"))
        let indexer = try Indexer(store: store, options: IndexOptions(),
                                  makeEmbedder: { throw WorkerError.notFound("no model needed to sync") })
        var chosen: [URL] = []
        for name in ["내 드라이브", "Café"] {
            let onDisk = folder.path + "/" + name.precomposedStringWithCanonicalMapping
            #if os(Windows)
            try FileManager.default.createDirectory(atPath: onDisk, withIntermediateDirectories: false)
            #else
            #expect(mkdir(onDisk, 0o755) == 0)   // FileManager would decompose the name
            #endif
            try Data("notes from the trip".utf8).write(to: URL(fileURLWithPath: onDisk + "/notes.txt"))
            chosen.append(URL(fileURLWithPath: onDisk).standardizedFileURL)
        }
        #expect(try indexer.sync(chosen).added == 2)
        let again = try indexer.sync(chosen)
        #expect(again.added == 0 && again.unchanged == 2)
        #expect(try store.files(under: chosen.map(\.path)).count == 2)
        store.scope = chosen.map(\.path)
        #expect(try store.pendingCount() == 2)
        #expect(try store.prune(keepingUnder: chosen.map(\.path)) == 0)
    }

    @Test func aMoveKeepsTheVectorsAndTakesTheNewPlacesIdentity() throws {
        let store = try IndexStore(directory: folder)
        let id = try store.insert(file("/a/photo.png", inode: 1))
        try store.addSegment(file: id, kind: .image, modality: .image, vector: [1, 0, 0])
        try store.finish(id, state: "done", info: ["width": "10"])
        try store.move(id, to: "/b/photo.png", inode: 99, device: 7, size: 12, mtime: 2)
        let moved = try #require(try store.file(id))
        #expect(moved.path == "/b/photo.png")
        #expect(moved.inode == 99 && moved.device == 7 && moved.size == 12 && moved.mtime == 2)
        #expect(moved.state == "done")   // the move didn't queue it to be read again
        #expect(try store.file(at: "/a/photo.png") == nil)
        var vectors = 0
        try store.db.query("SELECT COUNT(vec) FROM segments WHERE file = ?", [.int(id)]) { vectors = Int($0.int(0)) }
        #expect(vectors == 1)   // nothing was embedded again
        var name = ""
        try store.db.query("""
            SELECT name FROM fts WHERE rowid IN (SELECT id FROM segments WHERE file = ? AND kind = 'name')
            """, [.int(id)]) { name = $0.text(0) ?? "" }
        #expect(name.contains("photo"))   // keyword search follows the file's name
    }

    @Test func aFileMovedOrDeletedWhileItWasReadIsntWrittenAgain() throws {
        let store = try IndexStore(directory: folder)
        let id = try store.insert(file("/a/x.png", inode: 1))
        let read = try #require(try store.file(id))
        let indexer = try Indexer(store: store, options: IndexOptions(), makeEmbedder: { FakeEmbedder() })
        #expect(try indexer.stillIndexed(read))
        try store.move(id, to: "/b/x.png")
        #expect(try !indexer.stillIndexed(read))
        try store.delete(id)
        #expect(try !indexer.stillIndexed(read))
    }

    @Test func deleteTakesTheKeywordTextAndSegmentsWithIt() throws {
        let store = try IndexStore(directory: folder)
        let id = try store.insert(file("/a/notes.txt", inode: 1))
        try store.addSegment(file: id, kind: .chunk, modality: .text, loc: 1, text: "zorblat", vector: [1])
        try store.delete(id)
        #expect(try store.file(id) == nil)
        #expect(try store.file(at: "/a/notes.txt") == nil)
        var rows = 0
        try store.db.query("SELECT COUNT(*) FROM fts") { rows = Int($0.int(0)) }
        #expect(rows == 0)   // the name entry and the chunk's text went with the file
        try store.db.query("SELECT COUNT(*) FROM segments") { rows = Int($0.int(0)) }
        #expect(rows == 0)
    }

    /// A picture's fingerprint is kept with its row and read back by path: what Find similar groups by.
    @Test func aPictureFingerprintIsKeptAndReadByPath() throws {
        let store = try IndexStore(directory: folder.appendingPathComponent("index"))
        let picture = folder.appendingPathComponent("a.jpg")
        try Data("x".utf8).write(to: picture)
        let id = try store.insert(file(picture.path, inode: 1))
        let hash = Phash256(w0: 1, w1: 2, w2: 3, w3: 4)
        try store.setPhash(hash, file: id)
        #expect(try store.phashes(for: [picture.path]) == [picture.path: hash])
        #expect(try store.phashes(for: [folder.appendingPathComponent("gone.jpg").path]).isEmpty)
    }

    /// An index made before schema 7 opens as it was (its rows and vectors keep working) and gets the fingerprint
    /// column; its pictures simply have no fingerprint until `digup phash` fills them in.
    @Test func anIndexFromSchemaSixGetsTheFingerprintColumn() throws {
        let index = folder.appendingPathComponent("index")
        let picture = folder.appendingPathComponent("a.jpg")
        try Data("x".utf8).write(to: picture)
        do {
            let store = try IndexStore(directory: index)
            _ = try store.insert(file(picture.path, inode: 1))
            // The shape a 0.1.11 index has: no fingerprint column, schema 6.
            try store.db.execute("ALTER TABLE files DROP COLUMN phash; PRAGMA user_version = 6")
        }
        let reopened = try IndexStore(directory: index)
        let row = try #require(try reopened.file(at: picture.path))
        #expect(try reopened.phashes(for: [picture.path]).isEmpty)
        try reopened.setPhash(Phash256(w0: 9), file: row.id)
        #expect(try reopened.phashes(for: [picture.path]) == [picture.path: Phash256(w0: 9)])
    }

    /// A changed fingerprint recipe drops the stored ones (a mix of two would group nothing); the pictures and their
    /// vectors stay.
    @Test func aNewRecipeDropsOldFingerprints() throws {
        let index = folder.appendingPathComponent("index")
        let picture = folder.appendingPathComponent("a.jpg")
        try Data("x".utf8).write(to: picture)
        do {
            let store = try IndexStore(directory: index)
            let id = try store.insert(file(picture.path, inode: 1))
            try store.setPhash(Phash256(w0: 7), file: id)
            try store.db.run("UPDATE meta SET value = 'phash256-dct16-v0' WHERE key = 'phash_recipe'")
        }
        let reopened = try IndexStore(directory: index)
        #expect(try reopened.phashes(for: [picture.path]).isEmpty)
        #expect(try reopened.meta("phash_recipe") == Phash256.recipe)
    }
}

/// Sets an environment variable of this process, or removes it (nil).
private func setEnvironment(_ name: String, _ value: String?) {
    #if os(Windows)
    _ = name.withCString(encodedAs: UTF16.self) { name in
        guard let value else { return SetEnvironmentVariableW(name, nil) }
        return value.withCString(encodedAs: UTF16.self) { SetEnvironmentVariableW(name, $0) }
    }
    #else
    if let value { setenv(name, value, 1) } else { unsetenv(name) }
    #endif
}
