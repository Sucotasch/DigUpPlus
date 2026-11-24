// Audio and video without AVFoundation (Linux, Windows): ffmpeg decodes, ffprobe measures. They're looked for beside
// the helper, in $DIGUP_FFMPEG, then on PATH.
#if !canImport(AVFoundation)
import Foundation

enum FFmpeg {
    static let ffmpeg = find("ffmpeg")
    static let ffprobe = find("ffprobe")

    static func find(_ name: String) -> String? {
        let environment = ProcessInfo.processInfo.environment
        var folders: [String] = []
        if let chosen = environment["DIGUP_FFMPEG"], !chosen.isEmpty { folders.append(chosen) }
        if let executable = Bundle.main.executableURL { folders.append(executable.deletingLastPathComponent().path) }
        for folder in folders {
            let candidate = folder + "/" + FileSystem.program(name)
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return FileSystem.executable(name)
    }

    /// Runs a tool and hands its standard output to `read` as it comes (a long decode never sits in memory whole).
    /// Throws when the tool is missing or fails.
    static func run(_ tool: String?, _ arguments: [String], read: (Data) throws -> Void) throws {
        guard let tool else { throw ExtractError.unreadable("ffmpeg isn't installed (audio and video need it)") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        let errors = Pipe()
        process.standardError = errors
        process.standardInput = FileHandle.nullDevice
        try process.run()
        let reader = output.fileHandleForReading
        while true {
            let data = reader.readData(ofLength: 1 << 16)
            if data.isEmpty { break }
            try read(data)
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            // What the tool said about it: a dialog can only show a reason if there is one to show.
            let text = errors.fileHandleForReading.readDataToEndOfFile()
            let note = String(decoding: text, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            let flat = note.replacingOccurrences(of: "\n", with: " | ")
            let reason = flat.isEmpty ? "" : ": \(flat.suffix(1500))"
            throw ExtractError.unreadable("\((tool as NSString).lastPathComponent) failed (\(process.terminationStatus))\(reason)")
        }
    }

    /// The whole standard output, as text.
    static func output(_ tool: String?, _ arguments: [String]) throws -> String {
        var data = Data()
        try run(tool, arguments) { data.append($0) }
        return String(decoding: data, as: UTF8.self)
    }
}

extension MediaInfo {
    static func duration(of url: URL) -> Double? {
        guard let text = try? FFmpeg.output(FFmpeg.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of",
                                                             "default=noprint_wrappers=1:nokey=1", url.path])
        else { return nil }
        let seconds = Double(text.trimmingCharacters(in: .whitespacesAndNewlines))
        return seconds.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
    }

    /// Which kinds of streams the file has.
    static func streams(of url: URL) -> (audio: Bool, video: Bool) {
        guard let text = try? FFmpeg.output(FFmpeg.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of",
                                                             "default=noprint_wrappers=1:nokey=1", url.path])
        else { return (false, false) }
        return (text.contains("audio"), text.contains("video"))
    }

    /// What a recording says about itself (`RootRule.audioTags`: read by tags alone): title, artist, album, genre, year,
    /// track and composer from the container, keyed as ffprobe names them. No sound is decoded. Empty: no tags.
    static func tags(of url: URL) -> [String: String] {
        guard let text = try? FFmpeg.output(FFmpeg.ffprobe, ["-v", "error", "-show_entries", "format_tags", "-of", "json",
                                                             url.path]),
              let data = text.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tags = (root["format"] as? [String: Any])?["tags"] as? [String: Any]
        else { return [:] }
        // ffprobe's keys are lowercased; a few containers use their own spelling.
        let keys = ["title", "artist", "album", "album_artist", "genre", "date", "track", "composer"]
        var found: [String: String] = [:]
        for key in keys {
            let value = (tags[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let value, !value.isEmpty { found[key] = value }
        }
        return found
    }
}

extension Estimator {
    static func duration(of path: String) -> Double {
        MediaInfo.duration(of: URL(fileURLWithPath: path)) ?? 0
    }
}

extension AudioExtractor {
    /// Decodes audio (a file, or a video's soundtrack) to 16 kHz mono through ffmpeg and writes `window`-second WAV
    /// pieces `hop` seconds apart, skipping silent ones; one model input ignores anything past 30 s, so windows stay
    /// ≤ 30 s. Streams: memory stays at one window, even for a 3-hour podcast.
    static func windows(of url: URL, window: Double, hop: Double, minimum: Double = 2, to folder: URL) async throws
        -> (pieces: [MediaPiece], duration: Double) {
        guard MediaInfo.streams(of: url).audio else { return ([], 0) }
        let duration = MediaInfo.duration(of: url) ?? 0
        let windowSamples = Int(window * sampleRate), hopSamples = Int(hop * sampleRate)
        var buffer: [Int16] = []
        var offset = 0   // sample index of buffer[0] in the file
        var pieces: [MediaPiece] = []
        func emit(_ count: Int) throws {
            let slice = buffer[0..<count]
            guard rms(slice) > 0.003 else { return }   // ≈ −50 dBFS: silence isn't worth a vector
            let out = folder.appendingPathComponent(UUID().uuidString + ".wav")
            try writeWAV(slice, to: out)
            pieces.append(MediaPiece(path: out.path, start: Double(offset) / sampleRate,
                                     end: Double(offset + count) / sampleRate))
        }
        var odd: UInt8?   // a byte left over when a read ends mid-sample
        try FFmpeg.run(FFmpeg.ffmpeg, ["-v", "error", "-nostdin", "-i", url.path, "-vn", "-ac", "1", "-ar",
                                       "\(Int(sampleRate))", "-f", "s16le", "-"]) { data in
            var bytes: [UInt8] = []
            bytes.reserveCapacity(data.count + 1)
            if let first = odd { bytes.append(first); odd = nil }
            bytes.append(contentsOf: data)
            if bytes.count % 2 == 1 { odd = bytes.removeLast() }
            buffer.reserveCapacity(buffer.count + bytes.count / 2)
            var i = 0
            while i + 1 < bytes.count {
                buffer.append(Int16(bitPattern: UInt16(bytes[i]) | UInt16(bytes[i + 1]) << 8))
                i += 2
            }
            while buffer.count >= windowSamples {
                try emit(windowSamples)
                buffer.removeFirst(hopSamples)
                offset += hopSamples
            }
        }
        // The tail: new audio beyond the previous window's overlap, or the whole file if it was shorter than a window.
        let alreadyCovered = offset == 0 ? 0 : windowSamples - hopSamples
        if buffer.count - alreadyCovered >= Int(minimum * sampleRate) { try emit(buffer.count) }
        return (pieces, duration > 0 ? duration : Double(offset + buffer.count) / sampleRate)
    }
}

extension VideoExtractor {
    /// Samples a frame every `interval` seconds through ffmpeg and keeps one per shot: a frame that looks like the
    /// previous kept one (8×8 average hash within 4 bits) only extends it.
    static func keyframes(of url: URL, every interval: Double, maxPixel: Int, maxFrames: Int = 1200, to folder: URL)
        async throws -> (frames: [MediaPiece], duration: Double, hasAudio: Bool) {
        let streams = MediaInfo.streams(of: url)
        let duration = MediaInfo.duration(of: url) ?? 0
        guard duration > 0, streams.video else { return ([], duration, streams.audio) }
        let step = max(interval, duration / Double(maxFrames))
        let first = min(0.5, duration / 2)
        let prefix = "frame-\(UUID().uuidString)-"
        // Frame n is the one shown at first + n * step: fps's slots start at `first`, and round=up gives each slot the
        // last frame at or before it (its default gives the last before the slot's middle, half a step later). Every
        // frame is decoded anyway, so reading from the start costs nothing over seeking to `first`, and an MPEG-TS has
        // no index: a seek there lands past the keyframe, and nothing decodes until the next one.
        try FFmpeg.run(FFmpeg.ffmpeg, ["-v", "error", "-nostdin", "-i", url.path, "-an", "-vf",
                                       "fps=fps=\(1 / step):start_time=\(first):round=up,"
                                       + "scale=\(maxPixel):\(maxPixel):force_original_aspect_ratio=decrease",
                                       "-q:v", "3", "-f", "image2", folder.appendingPathComponent(prefix + "%06d.jpg").path]) { _ in }
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path).filter { $0.hasPrefix(prefix) }.sorted()
        var frames: [MediaPiece] = []
        var lastHash: UInt64?
        for (index, name) in names.enumerated() {
            let path = folder.appendingPathComponent(name).path
            let start = first + Double(index) * step
            guard start < duration else {   // fps can fill a slot past the end
                try? FileManager.default.removeItem(atPath: path)
                continue
            }
            if let image = RGBImage.load(path) {
                let hash = image.averageHash()
                if let lastHash, (hash ^ lastHash).nonzeroBitCount <= 4 {
                    try? FileManager.default.removeItem(atPath: path)
                    continue
                }
                lastHash = hash
            }
            frames.append(MediaPiece(path: path, start: start, end: duration))
        }
        // Each kept frame stands for the stretch until the next kept frame.
        for index in frames.indices.dropLast() { frames[index].end = frames[index + 1].start }
        return (frames, duration, streams.audio)
    }

    /// The frame shown at `seconds`, its long side at most `pixels` (0: the source's own size, never upscaled), as a
    /// JPEG.
    static func frame(at seconds: Double, of url: URL, pixels: Int, to out: URL) async throws {
        let at = max(0, seconds)
        // 0 asks for the file's own size: `min(iw, 0)` would be invalid, so the filter is left out entirely.
        let scale = pixels > 0
            ? ["-vf", "scale='min(iw,\(pixels))':'min(ih,\(pixels))':force_original_aspect_ratio=decrease"]
            : []
        let rest = ["-frames:v", "1"] + scale + ["-q:v", "3", "-y", out.path]
        // Seeking before reading starts at the keyframe before the moment and decodes on to it: quick at any length. An
        // MPEG-TS has no index, so its seek lands on the moment itself, and nothing decodes until the next keyframe (a
        // later frame is written, or none): seek to a while before and read on. ffmpeg may then exit with an error for
        // the frames it couldn't decode on the way, though the frame it wrote is the right one.
        let lead = Rules.isMPEGTransportStream(url) ? min(at, 12) : 0   // x264 keeps up to 250 frames between keyframes
        try? FFmpeg.run(FFmpeg.ffmpeg, ["-v", "error", "-nostdin", "-ss", String(at - lead), "-i", url.path]
                                       + (lead > 0 ? ["-ss", String(lead)] : []) + rest) { _ in }
        if !FileManager.default.fileExists(atPath: out.path) {
            // Nothing written: read from the start to the moment.
            try FFmpeg.run(FFmpeg.ffmpeg, ["-v", "error", "-nostdin", "-i", url.path, "-ss", String(at)] + rest) { _ in }
        }
        guard FileManager.default.fileExists(atPath: out.path) else {
            throw ExtractError.unreadable("no frame at \(seconds) s")
        }
    }

    /// Stills for a person, not for the model: `count` frames from `start`, one every `step` seconds, each at most
    /// `pixels` on its long side (0: the source's own size, never upscaled), as `0001.jpg…` in `folder` - with the
    /// moment each one shows. One ffmpeg pass, and `-frames:v` stops it after the count: "every second" does not decode
    /// a whole film, while a step that reaches across the clip does (no way to ask for a frame ten minutes in without
    /// reading to it). An MPEG-TS has no index, so the same lead-in as `frame(at:)` is used. A format the web view
    /// can't play is no obstacle: ffmpeg does the reading.
    static func sequence(of url: URL, start: Double, count: Int, step: Double, pixels: Int,
                         to folder: URL) async throws -> [(url: URL, at: Double)] {
        guard count > 0 else { throw ExtractError.unreadable("no frames asked for") }
        guard step > 0, step.isFinite else { throw ExtractError.unreadable("no frame step") }
        let first = max(0, start)
        let lead = Rules.isMPEGTransportStream(url) ? min(first, 12) : 0
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var filters = ["fps=fps=\(1 / step):start_time=0:round=up"]
        if pixels > 0 {
            filters.append("scale='min(iw,\(pixels))':'min(ih,\(pixels))':force_original_aspect_ratio=decrease")
        }
        var arguments = ["-v", "error", "-nostdin", "-ss", String(first - lead), "-i", url.path]
        if lead > 0 { arguments += ["-ss", String(lead)] }
        arguments += ["-an", "-vf", filters.joined(separator: ","), "-frames:v", String(count), "-q:v", "3",
                      "-y", "\(folder.path)/%04d.jpg"]
        // The frames on disk are the answer, even when ffmpeg exits crossly about the ones it skipped on the way.
        _ = try? FFmpeg.run(FFmpeg.ffmpeg, arguments) { _ in }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path))?
            .filter { $0.hasSuffix(".jpg") }.sorted() ?? []
        guard !names.isEmpty else { throw ExtractError.unreadable("ffmpeg made no frames") }
        return names.enumerated().map { index, name in
            (folder.appendingPathComponent(name), first + Double(index) * step)
        }
    }

    /// A contact sheet: one JPEG of the same stills, `pixels` a tile, `columns` to a row, the last row padded black.
    /// The frames are read back from disk, so a clip shorter than `count` gives a sheet partial in its last row. No
    /// `tile` filter: the vendored ffmpeg is a small build (34 filters, see `scripts/build-ffmpeg.sh`) and has
    /// `hstack`/`vstack`/`pad` instead - which also keeps ffmpeg the writer, so a path outside ASCII is its problem.
    static func contactSheet(of url: URL, start: Double, count: Int, step: Double, pixels: Int, columns: Int,
                             to out: URL, scratch: URL) async throws -> Int {
        let frames = try await sequence(of: url, start: start, count: count, step: step, pixels: pixels, to: scratch)
        defer { try? FileManager.default.removeItem(at: scratch) }
        guard let first = frames.first else { throw ExtractError.unreadable("no frames for the sheet") }
        // The tiles are the frames as ffmpeg scaled them; ffprobe says their size without decoding them again.
        let text = try? FFmpeg.output(FFmpeg.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries",
                                                       "stream=width,height", "-of", "csv=p=0", first.url.path])
        let size = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ",").compactMap { Int($0) }
        guard size.count == 2, size[0] > 0, size[1] > 0 else {
            throw ExtractError.unreadable("the frames' size couldn't be read")
        }
        let (tileWidth, tileHeight) = (size[0], size[1])
        let cols = max(1, min(columns, frames.count))
        let rows = (frames.count + cols - 1) / cols
        var rowFiles: [URL] = []
        for row in 0..<rows {
            let slice = Array(frames[(row * cols)..<min(frames.count, (row + 1) * cols)])
            let file = scratch.appendingPathComponent(String(format: "row-%02d.jpg", row))
            if slice.count == 1, cols == 1 {
                try FileManager.default.copyItem(at: slice[0].url, to: file)
                rowFiles.append(file)
                continue
            }
            var arguments = ["-v", "error", "-nostdin"]
            for frame in slice { arguments += ["-i", frame.url.path] }
            var graph = (0..<slice.count).map { "[\($0):v]" }.joined()
            if slice.count > 1 { graph += "hstack=inputs=\(slice.count)" }
            if slice.count < cols {
                graph += (slice.count > 1 ? "," : "") + "pad=width=\(tileWidth * cols):height=\(tileHeight):x=0:y=0:color=black"
            }
            arguments += ["-filter_complex", graph, "-frames:v", "1", "-q:v", "3", "-y", file.path]
            try FFmpeg.run(FFmpeg.ffmpeg, arguments) { _ in }
            rowFiles.append(file)
        }
        if rows == 1 {
            try? FileManager.default.removeItem(at: out)
            try FileManager.default.moveItem(at: rowFiles[0], to: out)
            return frames.count
        }
        var arguments = ["-v", "error", "-nostdin"]
        for file in rowFiles { arguments += ["-i", file.path] }
        arguments += ["-filter_complex", (0..<rows).map { "[\($0):v]" }.joined() + "vstack=inputs=\(rows)",
                      "-frames:v", "1", "-q:v", "3", "-y", out.path]
        try FFmpeg.run(FFmpeg.ffmpeg, arguments) { _ in }
        guard FileManager.default.fileExists(atPath: out.path) else {
            throw ExtractError.unreadable("the contact sheet wasn't written")
        }
        return frames.count
    }
}
#endif
