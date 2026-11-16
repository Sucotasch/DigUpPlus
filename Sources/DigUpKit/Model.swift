import Foundation

/// What a file is, for indexing and for grouping results.
public enum FileKind: String, CaseIterable, Sendable, Codable {
    case screenshot, image, pdf, doc, audio, video
    /// Source code, a repo's docs and notebooks: only in the code index (`IndexOptions.code`).
    case code

    /// The order of the first indexing pass: what people look for most comes first.
    static let indexingOrderSQL = """
        CASE kind WHEN 'screenshot' THEN 0 WHEN 'image' THEN 1 WHEN 'pdf' THEN 2 WHEN 'doc' THEN 3
        WHEN 'audio' THEN 4 WHEN 'video' THEN 5 ELSE 6 END
        """
}

/// One searchable piece of a file.
public enum SegmentKind: String, Sendable {
    case name             // file name + folder names (keyword search only)
    case image            // the image itself
    case ocr              // text Apple Vision read from a screenshot
    case page             // a PDF page's text
    case pageImage = "page_image"  // a PDF page rendered as an image (scans, slides)
    case chunk            // a piece of a document's text
    case audio            // a window of audio (a file or a video's soundtrack)
    case frame            // a video keyframe
    case lines            // a stretch of a code file: loc to loc_end are its first and last lines
    case cells            // a stretch of a notebook: loc to loc_end are its first and last cells, from 1
}

/// What produced a segment's vector. Scores are normalized per modality because text vectors score higher than
/// image or audio vectors for the same topic (measured: 0.75–0.86 vs 0.67–0.78).
public enum Modality: String, Sendable, CaseIterable {
    case none, text, image, audio
}

/// Indexing settings. Anything that changes vectors is part of `fingerprint`; an index never mixes settings.
public struct IndexOptions: Sendable {
    /// This index is the code index: the code folders' source files, their repos' docs and their notebooks, read as
    /// stretches of whole lines (`CodeExtractor`), and nothing else (`Rules.classifyCode`).
    public var code = false
    /// Characters a stretch of code holds at most (whole lines; a longer line is a stretch of its own). On the real-code
    /// eval (2026-10-09) 1,200 and 3,600 both lost to it: shorter cut functions apart, longer blurred them together.
    public var codeStretch = 1800
    /// A bigger source file was made by a program (an amalgamation, data written as code): left out. Hand-written
    /// files can pass 256 KB (llama.cpp's CPU ops are 426 KB), rarely 1 MB.
    public var maxCodeBytes = 1 << 20
    /// A notebook's file holds its outputs too (pictures, tables): bigger than this, it isn't read.
    public var maxNotebookBytes = 20 << 20
    public var includeCode = false
    public var includeDatasets = false
    /// Recording extensions (lowercase, no dot: "mp3") read by their tags alone — title, artist, album, genre, year into
    /// the keywords, no sound decoded and nothing embedded (Settings → Folders → Recordings). Absent: read in full.
    public var tagTypes: Set<String> = []
    public var minImageSide = 256
    /// Long files are read a step at a time: the first step in the first pass (every file gets searchable sooner), the
    /// rest after everything else (`Indexer.finishLongFiles`). PDFs up to `bigPDFPages` are read whole at once.
    public var bigPDFPages = 50
    public var pdfStep = 30                // pages
    public var docStep = 40                // chunks, ~64,000 characters
    /// Only machine-made giants get this far: a file's pages or chunks past these are left out.
    public var maxPages = 5_000
    public var maxChunks = 5_000           // ~8 million characters
    public var minPageText = 200           // fewer characters than this: embed the rendered page instead
    public var photoBudget = 140           // vision soft tokens: 70 / 140 / 280 / 560 / 1120
    public var screenshotBudget = 280
    public var pageBudget = 280
    public var frameBudget = 70
    public var frameInterval = 3.0         // seconds between sampled video frames (near-duplicates are dropped)
    public var audioWindow = 30.0          // the model silently ignores audio past 30 s of one input
    public var audioHop = 25.0
    public var excludedFolders: [String] = []
    public var excludedExtensions: Set<String> = []
    /// A rule for each chosen folder that doesn't take everything under it (Settings → Folders → Rules). Not in the
    /// fingerprint: a rule changes what a walk leaves out, never a vector.
    public var rootRules: [RootRule] = []

    public init() {}

    /// File extensions as people write them ("HEIC, .txt *.md") → ["heic", "txt", "md"].
    public static func extensions(_ text: String) -> Set<String> {
        Set(text.split(whereSeparator: { $0 == "," || $0.isWhitespace }).map { word in
            word.drop { $0 == "*" || $0 == "." }.lowercased()
        }.filter { !$0.isEmpty })
    }

    var fingerprint: String {
        // "code1": how code is read (stretches of lines, the path in its repo as the title). A change to it is a new
        // number, and every code index is read again.
        if code { return "code1 lines\(codeStretch)" }
        return "photo\(photoBudget) shot\(screenshotBudget) page\(pageBudget) frame\(frameBudget)/\(frameInterval)s audio\(audioWindow)/\(audioHop)s"
    }
}

/// Text on pictures, as a folder asks for it: none, on screenshots alone (the default), or on every picture.
public enum PictureText: String, Codable, Sendable {
    case off, screenshots, all
}

/// What a chosen folder holds: the kinds to index (nil: every kind), whether its subfolders are walked, and how its
/// recordings are read. The crawler applies it to the nearest chosen folder of each path, so a folder chosen inside
/// another keeps its own rule.
public struct RootRule: Codable, Sendable, Equatable {
    public var root: String
    public var kinds: Set<FileKind>?
    public var shallow: Bool
    /// Recordings whose type is in `IndexOptions.tagTypes` are read by their tags. nil (a rule saved before this was a
    /// setting) means yes, which is what 0.1.6 did for every folder.
    public var audioTags: Bool?
    /// The rest of the recordings are read by their sound. nil means yes, as above.
    public var audioContent: Bool?
    /// File types this folder skips on top of the ones skipped everywhere (Settings → Folders → Skip these types), as
    /// extensions ("html"). nil for a rule saved before this was a setting.
    public var skipTypes: [String]?
    /// Text on pictures: screenshots alone (the default), every picture, or none. nil for a rule saved before this was
    /// a setting, which read screenshots alone.
    public var ocrPictures: PictureText?
    /// Index a picture's look (its image vector, the Images and Screenshots filters). nil for a rule saved before this
    /// was a setting: then the rule's kinds say it (a rule that left pictures out didn't look at them).
    public var looksPictures: Bool?
    /// Read the words on a PDF's scanned pages (a render and an OCR a page, so off unless the folder asks). nil for a
    /// rule saved before this was a setting.
    public var ocrScans: Bool?

    /// The two bits, with the "not stored yet" default of yes.
    public var readsAudioByTags: Bool { audioTags ?? true }
    public var readsAudioByContent: Bool { audioContent ?? true }
    /// A rule with an explicit look bit, or any picture text choice, is from the version that separates the two; an
    /// older rule's kinds say whether it looked at pictures.
    /// Index the pictures' look. A rule saved before the bit existed looked at the pictures its kinds included.
    public var readsPicturesByLook: Bool {
        if let looks = looksPictures { return looks }
        if ocrPictures != nil { return true }
        let kinds = self.kinds ?? []
        return kinds.isEmpty || kinds.contains(.image) || kinds.contains(.screenshot)
    }
    /// Text on pictures, with the "not stored yet" default: a rule that looked at pictures read screenshots' words; one
    /// that left them out read none.
    public var picturesText: PictureText {
        if let text = ocrPictures { return text }
        if looksPictures != nil { return .screenshots }
        let kinds = self.kinds ?? []
        return kinds.isEmpty || kinds.contains(.image) || kinds.contains(.screenshot) ? .screenshots : .off
    }
    /// Scanned pages are read by default? No.
    public var readsScans: Bool { ocrScans ?? false }

    /// `skipTypes` as the comparison wants them: lowercased, without a leading dot or spaces.
    public var skippedTypes: Set<String> {
        Set((skipTypes ?? []).map { value in
            var type = value.trimmingCharacters(in: .whitespaces).lowercased()
            while type.hasPrefix(".") { type.removeFirst() }
            return type
        }.filter { !$0.isEmpty })
    }

    public init(root: String, kinds: Set<FileKind>? = nil, shallow: Bool = false, audioTags: Bool? = nil,
                audioContent: Bool? = nil, skipTypes: [String]? = nil, ocrPictures: PictureText? = nil,
                looksPictures: Bool? = nil, ocrScans: Bool? = nil) {
        self.root = root
        self.kinds = kinds
        self.shallow = shallow
        self.audioTags = audioTags
        self.audioContent = audioContent
        self.skipTypes = skipTypes
        self.ocrPictures = ocrPictures
        self.looksPictures = looksPictures
        self.ocrScans = ocrScans
    }
}

/// EmbeddingGemma 2's task prompts (model card). Media inputs take no prompt.
public enum Prompts {
    public static func query(_ text: String) -> String { "task: search result | query: \(text)" }

    /// A search of the code index (`CodeQuery`): the model card's prompt for finding code by what it does. Code is
    /// embedded as any document is (`document`, its path in its repo as the title). Measured against the search prompt
    /// on the real-code eval (2026-10-09, 27 queries): 24 vs 22 in the top 5, MRR 0.79 vs 0.75.
    public static func codeQuery(_ text: String) -> String { "task: code retrieval | query: \(text)" }

    public static func document(title: String?, text: String) -> String {
        "title: \((title?.isEmpty ?? true) ? "none" : title!) | text: \(text)"
    }
}

/// "code: retry with backoff": a search of the code index, and nothing else. Without the prefix a search never sees
/// code (the code index is a file of its own: `IndexStore.codeFile`).
public enum CodeQuery {
    public static let prefix = "code:"

    /// What's typed after "code:" ("" for "code:" alone), or nil for a search that isn't one of code.
    public static func text(of query: String) -> String? {
        let trimmed = query.drop { $0.isWhitespace }
        guard trimmed.count >= prefix.count, trimmed.prefix(prefix.count).lowercased() == prefix else { return nil }
        return trimmed.dropFirst(prefix.count).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
