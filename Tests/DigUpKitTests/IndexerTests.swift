import Foundation
import Testing
@testable import DigUpKit

/// What the indexer says about the file it is reading: a crash leaves no note, so the read has to be named while it
/// happens, from the preparing threads.
@Suite final class IndexerTests {
    let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DigUpIndexerTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return URL(fileURLWithPath: FolderSelection.realPath(url.path), isDirectory: true)
    }()

    deinit { try? FileManager.default.removeItem(at: folder) }

    /// The paths a read was announced on, from whichever preparing thread said them.
    final class Reads: @unchecked Sendable {
        private let lock = NSLock()
        private var paths: [String] = []
        func add(_ path: String) { lock.withLock { paths.append(path) } }
        var all: [String] { lock.withLock { paths } }
    }

    @Test func aReadIsNamedBeforeItStarts() throws {
        let files = folder.appendingPathComponent("files")
        try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        let note = files.appendingPathComponent("note.txt")
        try Data("budgetword".utf8).write(to: note)
        let store = try IndexStore(directory: folder.appendingPathComponent("index"))
        let indexer = try Indexer(store: store, options: IndexOptions(), makeEmbedder: { FakeEmbedder() })
        _ = try indexer.sync([files])
        let reads = Reads()
        indexer.onReadStart = { reads.add($0) }
        #expect(try indexer.run() == ["done": 1])
        #expect(reads.all == [note.path])
    }
}
