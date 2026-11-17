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

    func options(_ rules: [RootRule], tagTypes: Set<String> = []) -> IndexOptions {
        var options = IndexOptions()
        options.rootRules = rules
        options.tagTypes = tagTypes
        options.includeDatasets = true   // a dataset-shaped folder isn't the subject here
        return options
    }

    func names(_ report: CrawlReport) -> [String] {
        report.candidates.map { String($0.path.dropFirst(folder.path.count + 1)) }.sorted()
    }

    // MARK: How a folder's recordings are read (`audioTags`/`audioContent`)

    /// A folder skips its own types on top of the ones skipped everywhere: "html" matters here, not there.
    @Test func aFolderSkipsItsOwnTypesOnTopOfEveryones() throws {
        try write("A/page.html")
        try write("A/notes.txt")
        try write("B/page.html")
        try write("B/notes.txt")
        let a = folder.appendingPathComponent("A"), b = folder.appendingPathComponent("B")
        let report = Crawler.crawl([a, b], options: options([RootRule(root: a.path, skipTypes: ["html"])]))
        #expect(names(report) == ["A/notes.txt", "B/notes.txt", "B/page.html"])
        #expect(report.leftOut.values.compactMap { $0["excluded type"] }.reduce(0, +) == 1)
    }

    /// The same, with the type typed as people type it: ".HTML".
    @Test func aSkippedTypeIsForgivenItsDotAndCase() throws {
        try write("A/page.html")
        let a = folder.appendingPathComponent("A")
        let report = Crawler.crawl([a], options: options([RootRule(root: a.path, skipTypes: [".HTML"])]))
        #expect(names(report).isEmpty)
    }

    /// tags only: listed types by tags, everything else skipped (the music-library case).
    @Test func audioByTagsAloneSkipsTheRestOfTheRecordings() throws {
        try write("song.wav")
        try write("podcast.mp3")
        let rule = RootRule(root: folder.path, kinds: [.audio], audioTags: true, audioContent: false)
        let report = Crawler.crawl([folder], options: options([rule], tagTypes: ["wav"]))
        #expect(names(report) == ["song.wav"])
        #expect(report.candidates.first?.tagsOnly == true)
        #expect(report.leftOut[folder.path]?["audio not in the tag list here"] == 1)
    }

    /// content only: the tag list is ignored, every recording is read by its sound.
    @Test func audioByContentIgnoresTheTagList() throws {
        try write("song.wav")
        let rule = RootRule(root: folder.path, kinds: [.audio], audioTags: false, audioContent: true)
        let report = Crawler.crawl([folder], options: options([rule], tagTypes: ["wav"]))
        #expect(names(report) == ["song.wav"])
        #expect(report.candidates.first?.tagsOnly == false)
    }

    /// Neither bit: no recordings at all, with a reason of its own.
    @Test func audioCanBeLeftOutEntirely() throws {
        try write("song.wav")
        let rule = RootRule(root: folder.path, kinds: [.audio], audioTags: false, audioContent: false)
        let report = Crawler.crawl([folder], options: options([rule], tagTypes: ["wav"]))
        #expect(report.candidates.isEmpty)
        #expect(report.leftOut[folder.path]?["audio isn't read here"] == 1)
    }

    /// A rule saved before the bits existed (nil) reads listed types by tags and the rest by sound, as 0.1.6 did.
    @Test func aRuleWithoutTheAudioBitsKeepsTheOldBehaviour() throws {
        try write("song.wav")
        try write("podcast.mp3")
        let rule = RootRule(root: folder.path, kinds: [.audio])
        let report = Crawler.crawl([folder], options: options([rule], tagTypes: ["wav"]))
        #expect(names(report) == ["podcast.mp3", "song.wav"])
        #expect(report.candidates.first { $0.path.hasSuffix("song.wav") }?.tagsOnly == true)
        #expect(report.candidates.first { $0.path.hasSuffix("podcast.mp3") }?.tagsOnly == false)
    }

    @Test func aFolderWithKindsIndexesOnlyThem() throws {        try write("photo.jpg")
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

    // MARK: A rule on a folder inside a chosen one

    @Test func aSubfolderRuleAppliesWithoutBeingAChosenRoot() throws {
        try write("photo.jpg")
        try write("Screenshoot/one.jpg")
        try write("Screenshoot/two.png")
        try write("Screenshoot/clip.mp4")
        let screens = folder.appendingPathComponent("Screenshoot", isDirectory: true)
        let report = Crawler.crawl([folder], options: options([
            RootRule(root: folder.path, kinds: [.image, .screenshot]),
            RootRule(root: screens.path, kinds: [.video]),
        ]))
        #expect(names(report) == ["Screenshoot/clip.mp4", "photo.jpg"])
        // The pictures under the subfolder take its rule; the reason is filed under the chosen folder Settings shows.
        #expect(report.leftOut[folder.path]?["of a kind this folder doesn't index"] == 2)
    }

    @Test func aSubfolderRuleReadsItsRecordingsByTags() throws {
        try write("root.wav")
        try write("Records/song.wav")
        try write("Records/podcast.mp3")
        let records = folder.appendingPathComponent("Records", isDirectory: true)
        let report = Crawler.crawl([folder], options: options([
            RootRule(root: folder.path, kinds: [.audio], audioTags: false, audioContent: true),
            RootRule(root: records.path, kinds: [.audio], audioTags: true, audioContent: false),
        ], tagTypes: ["wav"]))
        #expect(names(report) == ["Records/song.wav", "root.wav"])
        #expect(report.candidates.first { $0.path.hasSuffix("root.wav") }?.tagsOnly == false)
        #expect(report.candidates.first { $0.path.hasSuffix("song.wav") }?.tagsOnly == true)
        #expect(report.leftOut[folder.path]?["audio not in the tag list here"] == 1)
    }

    @Test func aShallowSubfolderRuleStopsAtItsOwnFiles() throws {
        try write("photo.jpg")
        try write("Screens/one.jpg")
        try write("Screens/deep/two.jpg")
        let screens = folder.appendingPathComponent("Screens", isDirectory: true)
        let report = Crawler.crawl([folder], options: options([RootRule(root: screens.path, shallow: true)]))
        #expect(names(report) == ["Screens/one.jpg", "photo.jpg"])
        #expect(report.leftOut[folder.path]?["folders beyond the top level"] == 1)
    }

    @Test func aSubfolderRuleNarrowsAndWidensOnlyItsOwnRows() throws {
        let photo = try write("photo.jpg")
        let innerPhoto = try write("Screens/one.jpg")
        let clip = try write("Screens/clip.mp4")
        let screens = folder.appendingPathComponent("Screens", isDirectory: true)
        let store = try IndexStore(directory: folder.appendingPathComponent("index-subrules"))
        func sync(_ rules: [RootRule]) throws -> Indexer.SyncSummary {
            let indexer = try Indexer(store: store, options: options(rules),
                                      makeEmbedder: { throw WorkerError.notFound("sync doesn't need a model") })
            return try indexer.sync([folder])
        }
        #expect(try sync([]).added == 3)
        // The subfolder's rule leaves its own picture out and keeps its video; the root's picture is untouched.
        let narrowed = try sync([RootRule(root: screens.path, kinds: [.video])])
        #expect(narrowed.removed == 1 && narrowed.added == 0)
        #expect(try store.files(under: [folder.path]).map(\.path).sorted() == [photo.path, clip.path].sorted())
        // Taking it away brings the picture back.
        let widened = try sync([])
        #expect(widened.added == 1 && widened.removed == 0)
        #expect(try store.files(under: [folder.path]).map(\.path).sorted() == [photo.path, innerPhoto.path, clip.path].sorted())
    }

    // MARK: Text on pictures and scans

    @Test func aRuleReadsTheTextFieldsFromTheShellsJSON() throws {
        let json = #"{"root":"/x","kinds":["image"],"shallow":false,"audioTags":true,"audioContent":true,"ocrPictures":"all","ocrScans":true}"#
        let rule = try JSONDecoder().decode(RootRule.self, from: Data(json.utf8))
        #expect(rule.ocrPictures == .all)
        #expect(rule.ocrScans == true)
        #expect(rule.picturesText == .all && rule.readsScans)
    }

    @Test func aFolderSaysHowMuchTextToRead() throws {
        try write("photo.jpg")
        try write("Screenshots/shot.png")
        try write("book.pdf")
        let screens = folder.appendingPathComponent("Screenshots", isDirectory: true)
        let report = Crawler.crawl([folder], options: options([
            RootRule(root: folder.path, ocrPictures: .all, ocrScans: true),
            RootRule(root: screens.path, ocrPictures: .off),
        ]))
        func candidate(_ name: String) -> Candidate? { report.candidates.first { $0.path.hasSuffix(name) } }
        #expect(candidate("photo.jpg")?.ocrPictures == .all)
        #expect(candidate("shot.png")?.ocrPictures == .off)
        #expect(candidate("book.pdf")?.ocrScans == true)
        // Each choice stays with the kind it concerns: a document's picture bit, or a picture's scan bit, never changes
        // with the rule, so one folder setting doesn't requeue the rest of its files.
        #expect(candidate("book.pdf")?.ocrPictures == .off)
        #expect(candidate("photo.jpg")?.ocrScans == false)
    }

    @Test func noRuleReadsPicturesForTheirLookAndNoText() throws {
        try write("photo.jpg")
        try write("Screenshots/shot.png")
        try write("book.pdf")
        let report = Crawler.crawl([folder], options: options([]))
        // OCR is opt-in: the default reads pictures' look only, and no scans.
        let pictures = report.candidates.filter { $0.kind == .image || $0.kind == .screenshot }
        #expect(pictures.count == 2 && pictures.allSatisfy { $0.looksPictures && $0.ocrPictures == .off })
        #expect(report.candidates.first { $0.kind == .pdf }?.ocrScans == false)
    }

    @Test func aFolderCanReadPicturesOnlyForTheirWords() throws {
        try write("photo.jpg")
        try write("Screenshots/shot.png")
        let report = Crawler.crawl([folder], options: options([
            RootRule(root: folder.path, ocrPictures: .all, looksPictures: false),
        ]))
        #expect(names(report) == ["Screenshots/shot.png", "photo.jpg"])
        #expect(report.candidates.allSatisfy { !$0.looksPictures && $0.ocrPictures == .all })
    }

    @Test func theBetasScreenshotChoiceKeepsEveryPictureForItsWords() throws {
        try write("photo.jpg")
        try write("Screenshots/shot.png")
        // The betas' screenshots-only value now means every picture, so a photo with no look and that choice still
        // keeps its words — the old behaviour left it out entirely.
        let report = Crawler.crawl([folder], options: options([
            RootRule(root: folder.path, ocrPictures: .screenshots, looksPictures: false),
        ]))
        #expect(names(report) == ["Screenshots/shot.png", "photo.jpg"])
        #expect(report.candidates.allSatisfy { !$0.looksPictures && $0.ocrPictures == .all })
        #expect(report.leftOut[folder.path]?["pictures aren't read here"] == nil)
    }

    @Test func aLookChangeRequeuesOnlyThePictures() throws {
        let photo = try write("photo.jpg")
        try write("Screenshots/shot.png")
        let doc = try write("notes.txt")
        let store = try IndexStore(directory: folder.appendingPathComponent("index-look"))
        func sync(_ rules: [RootRule]) throws -> Indexer.SyncSummary {
            let indexer = try Indexer(store: store, options: options(rules),
                                      makeEmbedder: { throw WorkerError.notFound("sync doesn't need a model") })
            return try indexer.sync([folder])
        }
        func finishAll() throws {
            for file in try store.files(under: [folder.path]) { try store.finish(file.id, state: "done") }
        }
        #expect(try sync([]).added == 3)
        try finishAll()
        // Words only: the two pictures move (to no look), the document stays.
        let words = try sync([RootRule(root: folder.path, ocrPictures: .all, looksPictures: false)])
        #expect(words.changed == 2 && words.added == 0 && words.removed == 0)
        #expect(try store.file(at: photo.path)?.looksPictures == false)
        #expect(try store.file(at: doc.path)?.state == "done")
        try finishAll()
        // Back to looking: the same two.
        let back = try sync([])
        #expect(back.changed == 2 && back.added == 0 && back.removed == 0)
        #expect(try store.file(at: photo.path)?.looksPictures == true)
    }

    @Test func documentsOffKeepsOnlyScannedPDFText() throws {
        try write("book.pdf")
        try write("notes.txt")
        try write("film.mp4")
        // Documents off, OCR Documents on: the PDF is kept for its scans' text; text documents and videos aren't in
        // this rule's kinds.
        let report = Crawler.crawl([folder], options: options([
            RootRule(root: folder.path, kinds: [.pdf], looksDocuments: false, ocrScans: true),
        ]))
        #expect(names(report) == ["book.pdf"])
        let pdf = try #require(report.candidates.first)
        #expect(pdf.looksDocuments == false && pdf.ocrScans)
    }

    @Test func documentsOffWithoutScanTextReadsNoDocuments() throws {
        try write("book.pdf")
        try write("notes.txt")
        // Both document bits off, whatever the kinds say: neither a PDF nor its scans are opened.
        let report = Crawler.crawl([folder], options: options([
            RootRule(root: folder.path, looksDocuments: false, ocrScans: false),
        ]))
        #expect(report.candidates.isEmpty)
        #expect(report.leftOut[folder.path]?["documents aren't read here"] == 2)
    }

    @Test func aTextRuleRequeuesOnlyWhatItChanges() throws {
        let photo = try write("photo.jpg")
        let shot = try write("Screenshots/shot.png")
        let pdf = try write("book.pdf")
        try write("notes.txt")
        let store = try IndexStore(directory: folder.appendingPathComponent("index-ocr"))
        func sync(_ rules: [RootRule]) throws -> Indexer.SyncSummary {
            let indexer = try Indexer(store: store, options: options(rules),
                                      makeEmbedder: { throw WorkerError.notFound("sync doesn't need a model") })
            return try indexer.sync([folder])
        }
        func finishAll() throws {
            for file in try store.files(under: [folder.path]) { try store.finish(file.id, state: "done") }
        }
        #expect(try sync([]).added == 4)
        try finishAll()
        // Every picture: both pictures are read again, the document and the PDF aren't.
        let pictures = try sync([RootRule(root: folder.path, ocrPictures: .all)])
        #expect(pictures.changed == 2 && pictures.added == 0 && pictures.removed == 0)
        #expect(Set(try store.pending(limit: nil).map(\.path)) == [photo.path, shot.path])
        #expect(try store.file(at: pdf.path)?.state == "done")
        try finishAll()
        // Scans: the PDF alone.
        let scans = try sync([RootRule(root: folder.path, ocrPictures: .all, ocrScans: true)])
        #expect(scans.changed == 1 && scans.added == 0 && scans.removed == 0)
        #expect(try store.pending(limit: nil).map(\.path) == [pdf.path])
        #expect(try store.file(at: photo.path)?.state == "done")
    }

    /// The 0.1.16 betas wrote `screenshots` for "read the screenshots' words". After the Images/OCR split that choice
    /// means the words on every picture, which is what the UI has shown ever since.
    @Test func theBetasScreenshotChoiceReadsEveryPicture() throws {
        try write("photo.jpg")
        try write("Screenshots/shot.png")
        let report = Crawler.crawl([folder], options: options([RootRule(root: folder.path, ocrPictures: .screenshots)]))
        #expect(report.candidates.count == 2)
        #expect(report.candidates.allSatisfy { $0.ocrPictures == .all })
    }

    /// A picture's text choice is compared by what it reads, not by how it is written: a rule change re-reads only what
    /// really reads differently, and a choice that stops reading needs a re-read only when text is stored.
    @Test func aPictureRuleChangeReReadsOnlyWhatItChanges() throws {
        let photo = try write("photo.jpg")
        try write("notes.txt")
        let store = try IndexStore(directory: folder.appendingPathComponent("index-words"))
        func sync(_ rules: [RootRule]) throws -> Indexer.SyncSummary {
            let indexer = try Indexer(store: store, options: options(rules),
                                      makeEmbedder: { throw WorkerError.notFound("sync doesn't need a model") })
            return try indexer.sync([folder])
        }
        func finishAll() throws {
            for file in try store.files(under: [folder.path]) { try store.finish(file.id, state: "done") }
        }
        #expect(try sync([]).added == 2)
        try finishAll()
        // No words → every picture: read again.
        #expect(try sync([RootRule(root: folder.path, ocrPictures: .all)]).changed == 1)
        try finishAll()
        // The betas' value reads the same as `all`: no re-read, and the row is written as what was read.
        let picture = try #require(try store.file(at: photo.path))
        try store.setPictureText(picture.id, .screenshots)
        #expect(try sync([RootRule(root: folder.path, ocrPictures: .all)]).changed == 0)
        #expect(try store.file(at: photo.path)?.ocrPictures == .all)
        // Every picture → no words, nothing stored: nothing to remove, no re-read.
        #expect(try sync([]).changed == 0)
        // The same with words stored: read again to drop them.
        try store.setPictureText(picture.id, .all)
        try store.addSegment(file: picture.id, kind: .ocr, modality: .text, text: "words on the picture")
        #expect(try sync([]).changed == 1)
    }
}
