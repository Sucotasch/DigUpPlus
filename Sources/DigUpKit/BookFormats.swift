// Books the engine reads itself, on every platform: FB2 (FictionBook XML, UTF-8 or Windows-1251), EPUB (XHTML
// chapters in a zip) and a zip taken as one book — the text of every readable entry inside it, with the entry names.
// The formats that need a converter (legacy .doc, CHM, DJVU) live in Platform/.

import Foundation

/// The most characters one book adds to the index: the indexer keeps 5,000 chunks (about 9 M characters), so a longer
/// book would only cost time to read. Two million is past any novel and keeps a zip of dumps from flooding a search.
private let bookCharacterLimit = 2_000_000

/// FictionBook: the title, its authors and the body, without the base64 pictures. Russian books come in UTF-8 and
/// Windows-1251, so the file's own declaration decides.
enum FB2 {
    static func text(of url: URL) throws -> String {
        text(of: try Data(contentsOf: url))
    }

    static func text<Bytes: Collection>(of data: Bytes) -> String where Bytes.Element == UInt8 {
        let xml = decode(data)
        var pieces: [String] = []
        // The title and authors come first (genres and document ids don't), then every body, notes included.
        for tag in ["book-title", "first-name", "middle-name", "last-name", "nickname", "annotation", "body"] {
            pieces += inner(tag, of: xml)
        }
        // A fragment with neither still gives its words.
        return plain(pieces.isEmpty ? xml : pieces.joined(separator: "\n"))
    }

    /// The declared encoding, else UTF-8, else Windows-1251 (what an undeclared Russian text file turns out to be).
    static func decode<Bytes: Collection>(_ data: Bytes) -> String where Bytes.Element == UInt8 {
        let head = String(decoding: data.prefix(300), as: UTF8.self)
        if let range = head.range(of: #"(encoding|charset)\s*=\s*["']?[^"'>\s]+"#, options: .regularExpression),
           let name = head[range].split(separator: "=").last,
           let encoding = encoding(named: name.trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))),
           let text = String(data: Data(data), encoding: encoding) {
            return text
        }
        return String(data: Data(data), encoding: .utf8)
            ?? String(data: Data(data), encoding: .windowsCP1251)
            ?? String(decoding: data, as: UTF8.self)
    }

    /// The labels these books use. shortcut: KOI8-R and ISO-8859-5 aren't mapped; add them when a file turns up.
    private static func encoding(named label: String) -> String.Encoding? {
        switch label.lowercased() {
        case "utf-8", "utf8": .utf8
        case "windows-1251", "cp1251": .windowsCP1251
        case "windows-1252", "cp1252": .windowsCP1252
        case "iso-8859-1", "latin1": .isoLatin1
        case "utf-16", "utf-16le": .utf16LittleEndian
        case "utf-16be": .utf16BigEndian
        default: nil
        }
    }

    /// What's between every `<tag …>` and its closing tag (title-info and body can each appear more than once).
    private static func inner(_ tag: String, of xml: String) -> [String] {
        guard let pattern = try? NSRegularExpression(pattern: "(?is)<\(tag)\\b[^>]*>(.*?)</\(tag)\\s*>") else { return [] }
        return pattern.matches(in: xml, range: NSRange(xml.startIndex..., in: xml)).compactMap { match in
            Range(match.range(at: 1), in: xml).map { String(xml[$0]) }
        }
    }

    /// XML as the little HTML `plainText` reads: paragraphs and lines become breaks, the base64 pictures go.
    static func plain(_ xml: String) -> String {
        var text = xml
        text = text.replacingOccurrences(of: #"(?is)<binary\b.*?</binary\s*>"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?is)<(empty-line|br)\b[^>]*/?>"#, with: "<br>", options: .regularExpression)
        for tag in ["section", "title", "subtitle", "p", "v", "cite", "epigraph", "annotation", "stanza", "text-author"] {
            text = text.replacingOccurrences(of: "</\(tag)>", with: "<br>")
        }
        return DocExtractor.plainText(fromHTML: text)
    }
}

/// EPUB: the text of every XHTML page in the zip. shortcut: archive order, not the spine in content.opf — writers
/// store the chapters in reading order; read the spine if a book shows up shuffled.
enum EPUB {
    static func text(of url: URL) throws -> String {
        let archive = try ZipArchive(url)
        var parts: [String] = []
        var left = bookCharacterLimit
        for name in archive.names() where left > 0 {
            guard ["xhtml", "html", "htm"].contains((name as NSString).pathExtension.lowercased()),
                  let data = try archive.data(name) else { continue }
            let piece = DocExtractor.plainText(fromHTML: FB2.decode(data))
            guard !piece.isEmpty else { continue }
            let kept = String(piece.prefix(left))
            parts.append(kept)
            left -= kept.count
        }
        guard !parts.isEmpty else { throw ExtractError.leftOut("no text in the EPUB") }
        return parts.joined(separator: "\n\n")
    }
}

/// A zip as one book: the archive is the result (its own name and place in the folders), and its text is every
/// readable entry, each introduced by its name. Almost every archive here holds one book plus .url shortcuts.
enum ZipBook {
    static let readable: Set<String> = ["fb2", "txt", "text", "rtf", "html", "htm", "md"]

    static func text(of url: URL) throws -> String {
        let archive = try ZipArchive(url)
        var parts: [String] = []
        var left = bookCharacterLimit
        for name in archive.names() where left > 0 {
            let ext = (name as NSString).pathExtension.lowercased()
            // A needed size check first: one entry may declare 64 MB, and it is allocated whole.
            guard readable.contains(ext), !name.hasPrefix("__MACOSX/"),
                  let data = try archive.data(name) else { continue }
            let piece: String
            switch ext {
            case "fb2": piece = FB2.text(of: data)
            case "rtf": piece = RTF.text(String(decoding: data, as: UTF8.self))
            case "html", "htm": piece = DocExtractor.plainText(fromHTML: FB2.decode(data))
            default: piece = FB2.decode(data)
            }
            guard !piece.isEmpty else { continue }
            let kept = String(piece.prefix(left))
            parts.append("\(name)\n\(kept)")
            left -= kept.count
        }
        guard !parts.isEmpty else { throw ExtractError.leftOut("no readable text inside the zip") }
        return parts.joined(separator: "\n\n")
    }
}
