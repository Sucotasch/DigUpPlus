// Books that need a program outside the app: CHM through Windows' own help decompiler (hh.exe), DJVU through
// DjVuLibre's djvutxt when it is installed — DjVuLibre is GPL, so it is never bundled, only used when present.

#if !canImport(AppKit)
import Foundation

enum ConvertedBook {
    static func text(of url: URL, type ext: String) throws -> String {
        #if os(Windows)
        if ext == "chm" { return try CHM.text(of: url) }
        #endif
        if ext == "djvu" { return try DjVu.text(of: url) }
        throw ExtractError.unreadable(".\(ext) files aren't read on this system")
    }
}

#if os(Windows)
/// A compiled HTML help file: hh.exe unpacks it to a folder of pages, which are read as text.
enum CHM {
    static func text(of url: URL) throws -> String {
        guard let hh = FileSystem.executable("hh") else {
            throw ExtractError.unreadable("hh.exe isn't here (a CHM is unpacked with it)")
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("DigUp-chm-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try run(hh, ["-decompile", folder.path, url.lastPathComponent], seconds: 120,
                in: url.deletingLastPathComponent())
        // hh returns at once and unpacks in another process: wait for the pages to stop growing.
        let deadline = Date().addingTimeInterval(60)
        let started = Date()
        var lastSize = -1, stable = 0
        while Date() < deadline {
            let size = pages(in: folder).reduce(0) { $0 + $1.size }
            if size > 0, size == lastSize {
                stable += 1
                if stable >= 4 { break }   // a second without a byte of growth
            } else {
                stable = 0
            }
            if size == 0, Date().timeIntervalSince(started) > 10 { break }
            lastSize = size
            Thread.sleep(forTimeInterval: 0.25)
        }
        let files = pages(in: folder)
        guard !files.isEmpty else { throw ExtractError.empty("no pages in the CHM") }
        // shortcut: the folder walk's order, not the contents table inside; good enough for search.
        var parts: [String] = []
        var left = 2_000_000
        for file in files where left > 0 {
            guard let data = try? Data(contentsOf: file.url) else { continue }
            let piece = DocExtractor.plainText(fromHTML: FB2.decode(data))
            guard !piece.isEmpty else { continue }
            let kept = String(piece.prefix(left))
            parts.append(kept)
            left -= kept.count
        }
        guard !parts.isEmpty else { throw ExtractError.empty("no text in the CHM") }
        return parts.joined(separator: "\n\n")
    }

    /// The help file's pages; hh writes the images too, which aren't read.
    private static func pages(in folder: URL) -> [(url: URL, size: Int)] {
        var found: [(URL, Int)] = []
        let walk = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.fileSizeKey])
        while let file = walk?.nextObject() as? URL {
            guard ["htm", "html", "txt"].contains(file.pathExtension.lowercased()) else { continue }
            found.append((file, (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0))
        }
        return found
    }
}
#endif

/// A DjVu's text layer through DjVuLibre's djvutxt; scans without one have nothing to read.
enum DjVu {
    static func text(of url: URL) throws -> String {
        guard let tool = FileSystem.executable("djvutxt") else {
            throw ExtractError.leftOut("DjVu needs DjVuLibre (djvutxt) installed")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = [url.path]
        let output = Pipe()
        process.standardOutput = output
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw ExtractError.unreadable("djvutxt failed (\(process.terminationStatus))")
        }
        let text = String(decoding: data, as: UTF8.self)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ExtractError.empty("no text layer in the DjVu")
        }
        return text
    }
}

/// Runs a tool to completion, killing it after `seconds`: a damaged file must not hang the indexer. hh.exe only
/// accepts the help file's name relative to the folder it is run in.
private func run(_ tool: String, _ arguments: [String], seconds: Double, in folder: URL? = nil) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = arguments
    process.currentDirectoryURL = folder
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    let deadline = Date().addingTimeInterval(seconds)
    while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
    if process.isRunning { process.terminate() }
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw ExtractError.unreadable("\((tool as NSString).lastPathComponent) failed (\(process.terminationStatus))")
    }
}
#endif
