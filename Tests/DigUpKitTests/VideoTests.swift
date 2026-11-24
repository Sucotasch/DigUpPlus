import Foundation
import Testing
@testable import DigUpKit

/// Videos/shots.ts: an MPEG-TS of three 4-second shots on black, red on the left half, green on the top half, blue on
/// the top left quarter (flat colors would all have one average hash), with a keyframe only where each starts. A
/// transport stream has no index, so a seek into one lands between keyframes. Made with
/// `ffmpeg -f lavfi -i "color=black:s=320x192:r=5:d=4,drawbox=w=160:h=192:color=0xFF0000:t=fill"
/// -f lavfi -i "color=black:s=320x192:r=5:d=4,drawbox=w=320:h=96:color=0x00FF00:t=fill"
/// -f lavfi -i "color=black:s=320x192:r=5:d=4,drawbox=w=160:h=96:color=0x0000FF:t=fill"
/// -filter_complex "[0][1][2]concat=n=3:v=1:a=0,format=yuv420p" -c:v libx264 -preset veryslow
/// -x264-params keyint=20:min-keyint=20:scenecut=0:bframes=0 -f mpegts -pat_period 4 -sdt_period 4 shots.ts`.
@Suite final class VideoTests {
    static let shots = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Videos/shots.ts")
    let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DigUpTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    deinit {
        try? FileManager.default.removeItem(at: folder)
    }

    /// A frame's time is when it's shown: each shot once, in order, each at a time inside its shot.
    @Test func framesAreTimedWhenShown() async throws {
        let frames = try await VideoExtractor.keyframes(of: Self.shots, every: 3, maxPixel: 320, to: folder).frames
        let colors = try frames.map { try ImageTests.decode($0.path).quadrants[0] }
        #expect(colors == ["R", "G", "B"])
        for (frame, color) in zip(frames, colors) {
            guard let shot = ["R", "G", "B"].firstIndex(of: color) else { continue }
            #expect(Double(shot) * 4 <= frame.start && frame.start < Double(shot + 1) * 4, "\(color) at \(frame.start) s")
        }
    }

    @Test(arguments: [(1.0, "R"), (5.0, "G"), (6.5, "G"), (9.0, "B"), (11.5, "B")])
    func previewShowsTheMoment(_ seconds: Double, _ color: String) async throws {
        let out = folder.appendingPathComponent("\(seconds).jpg")
        try await VideoExtractor.frame(at: seconds, of: Self.shots, pixels: 320, to: out)
        #expect(try ImageTests.decode(out.path).quadrants[0] == color)
    }

    /// Saving a frame asks for the source's own size: 0 takes it as it is (this clip is 320×192), never upscales, and
    /// a positive size keeps the preview's scaling.
    @Test func aFrameCanBeTakenAtItsOwnSize() async throws {
        let full = folder.appendingPathComponent("full.jpg")
        try await VideoExtractor.frame(at: 5, of: Self.shots, pixels: 0, to: full)
        let shown = try ImageTests.decode(full.path)
        #expect(shown.width == 320 && shown.height == 192)
        let small = folder.appendingPathComponent("small.jpg")
        try await VideoExtractor.frame(at: 5, of: Self.shots, pixels: 200, to: small)
        #expect(try ImageTests.decode(small.path).width == 200)
    }

    /// A sequence for a person, not for the model: one file per step, in order, each with the moment it shows - and an
    /// MPEG-TS works because ffmpeg reads it, which is the point (formats the web view can't play still give stills).
    @Test func aSequenceTakesOneStillPerStep() async throws {
        let out = folder.appendingPathComponent("sequence")
        let frames = try await VideoExtractor.sequence(of: Self.shots, start: 0, count: 3, step: 4, pixels: 320,
                                                       to: out)
        #expect(frames.map(\.url.lastPathComponent) == ["0001.jpg", "0002.jpg", "0003.jpg"])
        #expect(try frames.map { try ImageTests.decode($0.url.path).quadrants[0] } == ["R", "G", "B"])
        #expect(frames.map(\.at) == [0, 4, 8])
    }

    /// The sheet is one JPEG of the same stills, three across for three, and the scratch folder is gone with it.
    @Test func aContactSheetIsOnePicture() async throws {
        let out = folder.appendingPathComponent("sheet.jpg")
        let scratch = folder.appendingPathComponent("sheet-frames")
        let used = try await VideoExtractor.contactSheet(of: Self.shots, start: 0, count: 3, step: 4, pixels: 160,
                                                         columns: 4, to: out, scratch: scratch)
        #expect(used == 3)
        let sheet = try ImageTests.decode(out.path)
        #expect(sheet.width == 480 && sheet.height == 96)   // three 160x96 tiles in one row
        #expect(!FileManager.default.fileExists(atPath: scratch.path))
    }

    /// A clip shorter than the grid leaves black tiles in the last row rather than failing: five 80x48 tiles make two
    /// rows of four.
    @Test func aShortClipPadsTheLastRow() async throws {
        let out = folder.appendingPathComponent("five.jpg")
        let used = try await VideoExtractor.contactSheet(of: Self.shots, start: 0, count: 5, step: 1.6, pixels: 80,
                                                         columns: 4, to: out,
                                                         scratch: folder.appendingPathComponent("five-frames"))
        #expect(used == 5)
        let sheet = try ImageTests.decode(out.path)
        #expect(sheet.width == 320 && sheet.height == 96)   // 4 x 80 wide, two rows of 48-high tiles
    }
}
