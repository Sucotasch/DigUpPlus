import Foundation
import Testing
@testable import DigUpKit

/// A chosen folder's own rule: the kinds it holds, and whether its subfolders are walked (`RootRule`).
@Suite final class RootRulesTests {
    /// In Caches, not the temporary folder: the walk reports /private/var/… for /var/… (see LongFilesTests).
    let folder: URL = {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let url = caches.appendingPathComponent("DigUpRulesTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return URL(fileURLWithPath: FolderSelection.realPath(url.path), isDirectory: true)
    }()

    deinit { try? FileManager.default.removeItem(at: folder) }

    @discardableResult
    func write(_ path: String, _ text: String = "x") throws -> URL {
        let url = folder.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: false, encoding: .utf8)
        return url
    }

    func options(_ rules: [RootRule]) -> IndexOptions {
        var options = IndexOptions()
        options.rootRules = rules
        options.includeDatasets = true   // a dataset-shaped folder isn't the subject here
        return options
    }

    func names(_ report: CrawlReport) -> [String] {
        report.candidates.map { String($0.path.dropFirst(folder.path.count + 1)) }.sorted()
    }

    @Test func aFolderWithKindsIndexesOnlyThem() throws {
        try write("photo.jpg")
        try write("clip.mp4")
        try write("notes.txt", "notes")
        let report = Crawler.crawl([folder], options: options([RootRule(root: folder.path, kinds: [.image, .screenshot])]))
        #expect(names(report) == ["photo.jpg"])
        // The reason lands on the searched folder itself, where Settings looks for it.
        #expect(report.leftOut[folder.path]?["of a kind this folder doesn't index"] == 2)
    }

    @Test func aTopLevelOnlyFolderLeavesItsSubfoldersAlone() throws {
        try write("photo.jpg")
        try write("sub/clip.mp4")
        try write("sub/deep/photo.jpg")
        let report = Crawler.crawl([folder], options: options([RootRule(root: folder.path, shallow: true)]))
        #expect(names(report) == ["photo.jpg"])
        #expect(report.leftOut[folder.path]?["folders beyond the top level"] == 1)   // "sub"
    }

    @Test func noRuleLeavesTheCrawlAsItWas() throws {
        try write("photo.jpg")
        try write("sub/clip.mp4")
        let plain = Crawler.crawl([folder], options: options([]))
        let ruled = Crawler.crawl([folder], options: options([RootRule(root: folder.path)]))
        #expect(names(plain) == names(ruled))
        #expect(plain.leftOut == ruled.leftOut)
        #expect(plain.skippedFolders == ruled.skippedFolders)
    }

    @Test func aNestedChosenFolderKeepsItsOwnRule() throws {
        try write("photo.jpg")
        let inner = folder.appendingPathComponent("inner", isDirectory: true)
        try write("inner/photo.jpg")
        try write("inner/clip.mp4")
        // The outer root walks first, so its walk is the one that reaches the inner files: they must still take the
        // inner folder's rule, not the outer one's.
        let report = Crawler.crawl([folder, inner], options: options([
            RootRule(root: folder.path, kinds: [.image, .screenshot]),
            RootRule(root: inner.path, kinds: [.video]),
        ]), chosenRoots: [folder, inner])
        #expect(names(report) == ["inner/clip.mp4", "photo.jpg"])
        #expect(report.leftOut[inner.path]?["of a kind this folder doesn't index"] == 1)
    }

    @Test func aPartialWalkOfATopLevelOnlyFolderReadsNoneOfItsFiles() throws {
        try write("photo.jpg")
        let sub = try write("sub/clip.mp4").deletingLastPathComponent()
        let rule = [RootRule(root: folder.path, shallow: true)]
        let full = Crawler.crawl([folder], options: options(rule), chosenRoots: [folder])
        // A sync of a changed folder inside it walks that folder on its own, not the chosen folder: the rule still
        // holds, and the reason is still filed under the chosen folder.
        let partial = Crawler.crawl([sub], options: options(rule), chosenRoots: [folder])
        #expect(names(full) == ["photo.jpg"])
        #expect(partial.candidates.isEmpty)
        #expect(partial.leftOut[folder.path]?["beyond the top level"] == 1)
    }

    @Test func narrowingARuleRemovesItsRowsAndWideningBringsThemBack() throws {
        let photo = try write("photo.jpg")
        try write("clip.mp4")
        let store = try IndexStore(directory: folder.appendingPathComponent("index"))
        func sync(_ rules: [RootRule]) throws -> Indexer.SyncSummary {
            let indexer = try Indexer(store: store, options: options(rules),
                                      makeEmbedder: { throw WorkerError.notFound("sync doesn't need a model") })
            return try indexer.sync([folder])
        }
        #expect(try sync([]).added == 2)
        // Narrowing the rule is a resync: the rows it leaves out go, and nothing is re-embedded.
        let narrowed = try sync([RootRule(root: folder.path, kinds: [.image, .screenshot])])
        #expect(narrowed.removed == 1 && narrowed.added == 0)
        #expect(try store.files(under: [folder.path]).map(\.path) == [photo.path])
        // Taking the rule away brings the file back, and only it.
        let widened = try sync([])
        #expect(widened.added == 1 && widened.removed == 0)
        #expect(try store.files(under: [folder.path]).count == 2)
    }
}
