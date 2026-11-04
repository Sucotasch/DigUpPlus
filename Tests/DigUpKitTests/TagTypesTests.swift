import Foundation
import Testing
@testable import DigUpKit

/// Settings → Folders → Recordings: a type read by its tags alone (`IndexOptions.tagTypes`), and what changing that rule
/// does to the index.
@Suite final class TagTypesTests {
    let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DigUpTagsTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return URL(fileURLWithPath: FolderSelection.realPath(url.path), isDirectory: true)
    }()

    deinit { try? FileManager.default.removeItem(at: folder) }

    /// A 0.1 s WAV with a LIST/INFO chunk: the tags ffprobe reads, without needing a real recording or a tool to make
    /// one. `INAM`/`IART`/`IPRD` are title, artist and album.
    static func writeTaggedWAV(_ url: URL) throws {
        func le16(_ value: UInt16) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
        func le32(_ value: UInt32) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
        func chunk(_ name: String, _ data: Data) -> Data {
            Data(name.utf8) + le32(UInt32(data.count)) + data + (data.count % 2 == 1 ? Data([0]) : Data())
        }
        let format = le16(1) + le16(1) + le32(8000) + le32(8000) + le16(1) + le16(8)
        let info = Data("INFO".utf8) + chunk("INAM", Data("Night Drive\0".utf8))
            + chunk("IART", Data("The Testers\0".utf8)) + chunk("IPRD", Data("Album One\0".utf8))
        let body = Data("WAVE".utf8) + chunk("fmt ", format) + chunk("LIST", info)
            + chunk("data", Data(repeating: 0x80, count: 800))
        try (Data("RIFF".utf8) + le32(UInt32(body.count)) + body).write(to: url)
    }

    func options(_ tags: Set<String>) -> IndexOptions {
        var options = IndexOptions()
        options.tagTypes = tags
        options.includeDatasets = true
        return options
    }

    // The tags come from ffprobe, which only the portable platforms have; on the Mac the rule has no reader.
    #if !canImport(AVFoundation)
    @Test func aRecordingReadByItsTagsHasTheirWordsAndNoVector() throws {
        guard FFmpeg.ffprobe != nil else { return }   // no ffprobe here: nothing to read the tags with
        let file = folder.appendingPathComponent("Night Drive.wav")
        try Self.writeTaggedWAV(file)
        let store = try IndexStore(directory: folder.appendingPathComponent("index"))
        // No model at all: a tags read decodes nothing, so nothing asks for the embedder.
        let indexer = try Indexer(store: store, options: options(["wav"]),
                                  makeEmbedder: { throw WorkerError.notFound("a tags read needs no model") })
        #expect(try indexer.sync([folder]).added == 1)
        #expect(try indexer.run()["done"] == 1)
        let row = try #require(try store.files(under: [folder.path]).first)
        #expect(row.kind == .audio)
        // The row is a finished audio file with no vectors, found by the words of its tags.
        let counts = try store.counts()
        #expect(counts.vectors == 0)
        let searcher = try Searcher(store: store, loadVectors: false)
        #expect(try searcher.search("Testers", queryVector: nil).map(\.path) == [row.path])
        #expect(try searcher.search("Night", queryVector: nil).map(\.path) == [row.path])
    }

    @Test func droppingTheRuleQueuesTheRecordingsAgainAndKeepsNoTagText() throws {
        let file = folder.appendingPathComponent("Night Drive.wav")
        try Self.writeTaggedWAV(file)
        let store = try IndexStore(directory: folder.appendingPathComponent("index"))
        func indexer(_ tags: Set<String>) throws -> Indexer {
            try Indexer(store: store, options: options(tags),
                        makeEmbedder: { throw WorkerError.notFound("a tags read needs no model") })
        }
        #expect(try indexer(["wav"]).sync([folder]).added == 1)
        let id = try #require(try store.files(under: [folder.path]).first?.id)
        #expect(try indexer(["wav"]).run()["done"] == 1)
        #expect(try store.counts().vectors == 0)
        // Read in full from now on: the row is queued again, its tag text gone, and its state says it's waiting.
        #expect(try indexer([]).sync([folder]).unchanged == 1)
        let row = try #require(try store.file(id))
        #expect(row.state == "pending")
        let searcher = try Searcher(store: store, loadVectors: false)
        #expect(try searcher.search("Testers", queryVector: nil).isEmpty)   // only the name is left
        // The rule is kept in the index, so a sync without a change queues nothing.
        #expect(try store.meta("tag_types") == "[]")
    }
    #endif

    @Test func theEstimateCountsNoListeningForARecordingReadByItsTags() {
        let candidate = Candidate(path: "/music/song.mp3", kind: .audio, size: 1_000_000, mtime: 1, inode: 1, device: 1)
        let full = Estimator.estimates(bySubfolder: [candidate], of: "/music", options: options([]),
                                       costs: Costs())
        let tagged = Estimator.estimates(bySubfolder: [candidate], of: "/music", options: options(["mp3"]),
                                         costs: Costs())
        #expect(tagged["/music"]?.files[.audio] == 1)          // still counted as a recording
        #expect(tagged["/music"]?.seconds == 0)                // but with no listening time, and no duration asked for
        #expect(full["/music"]?.files[.audio] == 1)
    }
}
