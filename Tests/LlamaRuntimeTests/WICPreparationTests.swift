// Does a picture prepared through WIC (Windows' scaled JPEG decode) give the model the same vector as the stb path it
// replaced? If it does within the reference's tolerance, an index doesn't need to be embedded again for this change.
#if !canImport(ImageIO)
import DigUpKit
import Foundation
import Testing
@testable import DigUpKit
@testable import LlamaRuntime

@Suite struct WICPreparationTests {
    static let modelsThere = (try? LlamaModels.locate())?.media != nil

    @Test(.enabled(if: modelsThere)) func wicAndStbPreparedPicturesAgree() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("digup-wic-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }

        // A 1600×1000 gradient: big enough that a prepared copy is scaled, and detailed enough that two resamplers
        // could disagree if they were going to.
        let (width, height) = (1600, 1000)
        var pixels = [UInt8](repeating: 0, count: width * height * 3)
        for y in 0..<height {
            for x in 0..<width {
                let index = (y * width + x) * 3
                pixels[index] = UInt8(x * 255 / (width - 1))
                pixels[index + 1] = UInt8(y * 255 / (height - 1))
                pixels[index + 2] = UInt8((x + y) * 255 / (width + height - 2))
            }
        }
        let source = folder.appendingPathComponent("big.jpg")
        try RGBImage(width: width, height: height, pixels: pixels).write(to: source, png: false)

        // What indexing does now (WIC on Windows).
        let now = try ImageExtractor.prepare(source, maxPixel: 1024, minSide: 1, to: folder, png: false)
        // What it did before: stb decodes in full, stbir shrinks, stb writes the JPEG.
        let loaded = try #require(RGBImage.load(source.path))
        let scale = 1024.0 / Double(max(loaded.width, loaded.height))
        var old = loaded
        if scale < 1 {
            old = try loaded.resized(width: Int((Double(loaded.width) * scale).rounded()),
                                     height: Int((Double(loaded.height) * scale).rounded()))
        }
        let before = folder.appendingPathComponent("before.jpg")
        try old.write(to: before, png: false)

        let embedder = try LlamaEmbedder(models: LlamaModels.locate(), textOnly: false)
        defer { embedder.close() }
        let fresh = try #require(embedder.embedImages([now.path], budget: 140).first?.vector)
        let previous = try #require(embedder.embedImages([before.path], budget: 140).first?.vector)
        let cosine = zip(fresh, previous).reduce(0.0) { $0 + Double($1.0) * Double($1.1) }
        #expect(cosine >= 0.999, "WIC's prepared picture moved the model's vector to cosine \(cosine)")
    }
}
#endif
