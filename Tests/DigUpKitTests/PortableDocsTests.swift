// The readers Linux and Windows use for documents (a Mac reads them through Cocoa): what a crafted file does to them.
#if !canImport(AppKit)
import CMiniz
import Foundation
import Testing
@testable import DigUpKit

@Suite final class PortableDocsTests {
    let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DigUp-PortableDocs-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    deinit { try? FileManager.default.removeItem(at: folder) }

    /// A zip with one deflated entry, as Word and LibreOffice write theirs.
    private func zip(named file: String, entry: String, _ bytes: [UInt8]) throws -> URL {
        var archive = mz_zip_archive()
        guard mz_zip_writer_init_heap(&archive, 0, 0) != 0 else { throw ExtractError.unreadable("can't start a zip") }
        defer { mz_zip_writer_end(&archive) }
        let added = bytes.withUnsafeBytes { mz_zip_writer_add_mem(&archive, entry, $0.baseAddress, $0.count, 1) }
        guard added != 0 else { throw ExtractError.unreadable("can't add the entry") }
        var pointer: UnsafeMutableRawPointer?
        var size = 0
        guard mz_zip_writer_finalize_heap_archive(&archive, &pointer, &size) != 0, let pointer else {
            throw ExtractError.unreadable("can't finish the zip")
        }
        defer { mz_free(pointer) }
        let url = folder.appendingPathComponent(file)
        try Data(bytes: pointer, count: size).write(to: url)
        return url
    }

    /// A zip of a few KB can declare an entry of any size, and extracting allocates the declared size whole.
    @Test func zipEntriesOverTheCapAreRefusedBeforeAnythingIsAllocated() throws {
        let small = try zip(named: "notes.docx", entry: "word/document.xml",
                            Array("<w:document><w:p>hello there</w:p></w:document>".utf8))
        #expect(try Zip.entry("word/document.xml", in: small).contains("hello there"))
        let declared = Int(Zip.maxEntryBytes) + 1
        let huge = try zip(named: "bomb.docx", entry: "word/document.xml", [UInt8](repeating: 0x41, count: declared))
        #expect(try FileManager.default.attributesOfItem(atPath: huge.path)[.size] as? Int ?? 0 < 1 << 20)
        #expect(throws: ExtractError.self) { try Zip.entry("word/document.xml", in: huge) }
    }

    /// \\uN is a signed 16-bit value; anything past that used to trap the conversion and end the helper.
    @Test func rtfUnicodeValuesOutOfRangeAreDropped() {
        let text = RTF.text("{\\rtf1 a\\u99999999999?b\\u-99999?c\\u8364?d}")
        #expect(text.contains("€"))
        #expect(text.hasPrefix("a") && text.hasSuffix("d"))
        #expect(RTF.text("{\\rtf1 \\u4294967296?x}") == "x")
    }

    /// The books here are half UTF-8 and half Windows-1251: the declaration decides, and the base64 pictures must not
    /// become text.
    @Test func fb2ReadsTheBodyInEitherEncoding() throws {
        let utf8 = """
        <?xml version="1.0" encoding="utf-8"?>
        <FictionBook><description><title-info><book-title>Гонка за смертью</book-title>
        <author><first-name>Ричард</first-name><last-name>Морган</last-name></author></title-info></description>
        <body><section><title><p>Глава первая</p></title><p>Текст книги.</p>
        <binary content-type="image/jpeg">AAAA</binary></section></body></FictionBook>
        """
        let plain = folder.appendingPathComponent("utf8.fb2")
        try utf8.write(to: plain, atomically: true, encoding: .utf8)
        let text = try DocExtractor.text(of: plain)
        #expect(text.contains("Гонка за смертью"))
        #expect(text.contains("Текст книги."))
        #expect(!text.contains("AAAA"))

        let russian = """
        <?xml version="1.0" encoding="windows-1251"?>
        <FictionBook><body><section><p>Привет, мир.</p></section></body></FictionBook>
        """
        let cp1251 = folder.appendingPathComponent("cp1251.fb2")
        try #require(russian.data(using: .windowsCP1251)).write(to: cp1251)
        #expect(try DocExtractor.text(of: cp1251).contains("Привет, мир."))
    }

    /// One archive is one result: the text of the FB2 inside it, introduced by the entry's name.
    @Test func zipIsOneBookOfTheReadableEntriesInside() throws {
        let book = """
        <?xml version="1.0" encoding="utf-8"?><FictionBook><body><section><p>Внутри архива.</p></section></body></FictionBook>
        """
        let archive = try zip(named: "book.zip", entry: "Book.fb2", Array(book.utf8))
        let text = try DocExtractor.text(of: archive)
        #expect(text.contains("Book.fb2"))
        #expect(text.contains("Внутри архива."))
    }

    @Test func epubReadsTheXHTMLPagesInTheZip() throws {
        let page = "<html><head><title>t</title></head><body><h1>Глава</h1><p>Текст главы.</p></body></html>"
        let archive = try zip(named: "book.epub", entry: "OEBPS/ch1.xhtml", Array(page.utf8))
        #expect(try DocExtractor.text(of: archive).contains("Текст главы."))
    }

    /// A Word 97 document's text is a piece table: some pieces are one byte a character in the document's code page,
    /// others UTF-16. The container is not needed to test that.
    @Test func wordPiecesDecodeCompressedAndWideText() throws {
        func put(_ value: Int, at offset: Int, bytes: inout [UInt8], size: Int = 4) {
            for index in 0..<size { bytes[offset + index] = UInt8((value >> (8 * index)) & 0xFF) }
        }
        var document = [UInt8](repeating: 0, count: 800)
        put(0xA5EC, at: 0, bytes: &document, size: 2)
        put(0x0419, at: 6, bytes: &document, size: 2)   // Russian
        put(204, at: 20, bytes: &document, size: 2)     // Cyrillic character set
        let compressed = Array("Привет".data(using: .windowsCP1251)!)
        document.replaceSubrange(600..<(600 + compressed.count), with: compressed)
        let wide = Array(" мир".utf16).flatMap { [UInt8($0 & 0xFF), UInt8($0 >> 8)] }
        document.replaceSubrange(700..<(700 + wide.count), with: wide)
        put(0, at: 0x01A2, bytes: &document)             // the piece table is at the start of the table stream
        put(33, at: 0x01A6, bytes: &document)

        var table = [UInt8](repeating: 0, count: 33)
        table[0] = 0x02
        put(28, at: 1, bytes: &table)                    // 3 code points and 2 pieces
        put(0, at: 5, bytes: &table)
        put(6, at: 9, bytes: &table)
        put(10, at: 13, bytes: &table)
        put(0x4000_0000 | (600 * 2), at: 19, bytes: &table)   // compressed, at byte 600
        put(700, at: 27, bytes: &table)                  // UTF-16, at byte 700

        #expect(try WordDoc.text(document: document, table: table) == "Привет мир")
    }
}
#endif
