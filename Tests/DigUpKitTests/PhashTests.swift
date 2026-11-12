// The fingerprint Find similar groups a result list by (Phash256): copies stay close through a resize and a
// re-compression, different pictures don't, and a group starts with the best-ranked member.

import Foundation
import Testing
@testable import DigUpKit

@Suite final class PhashTests {
    static let pictures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Pictures")
    let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DigUpTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    deinit { try? FileManager.default.removeItem(at: folder) }

    /// A 64x64 grayscale picture from a value per pixel.
    func gray(_ value: (Int, Int) -> Int) -> [UInt8] {
        (0..<(Phash256.side * Phash256.side)).map { index in
            UInt8(max(0, min(255, value(index / Phash256.side, index % Phash256.side))))
        }
    }

    @Test func aPictureAndItsCopyAreTheSameFingerprint() throws {
        let picture = gray { x, y in (x * 7 + y * 13) % 256 }
        let hash = try #require(Phash256.of(gray: picture))
        #expect(hash.hamming(hash) == 0)
        #expect(hash.difference(from: hash) == 0)
    }

    @Test func anInvertedPictureIsNotALookAlike() throws {
        let ramp = gray { _, y in y * 4 }
        let inverted = gray { _, y in 255 - y * 4 }
        let one = try #require(Phash256.of(gray: ramp))
        let two = try #require(Phash256.of(gray: inverted))
        #expect(one.difference(from: two) > 20)
        #expect(LookalikeGroups.group(paths: ["a", "b"], hashes: ["a": one, "b": two],
                                      difference: 6).isEmpty)
    }

    @Test func aTurnedPictureIsNotALookAlike() throws {
        let vertical = gray { _, y in y * 4 }
        let horizontal = gray { x, _ in x * 4 }
        let one = try #require(Phash256.of(gray: vertical))
        let two = try #require(Phash256.of(gray: horizontal))
        #expect(one.difference(from: two) > 12)
    }

    @Test func theThirtyTwoBytesCarryEveryBit() throws {
        let hash = try #require(Phash256.of(gray: gray { x, y in (x * 31 + y * 17) % 256 }))
        let bytes = hash.data
        #expect(bytes.count == 32)
        #expect(Phash256(data: bytes) == hash)
        #expect(Phash256(data: bytes.dropLast()) == nil)
    }

    /// The same picture read twice — once at its own size, once through the copy the model gets (re-compressed, and
    /// turned the way the camera held it) — is still one look: under the 6% the window starts with. (This pattern has
    /// hard colour edges, the worst case for a re-encode; measured photos stay under 1.6%.)
    @Test func aRecompressedCopyKeepsItsFingerprint() throws {
        let picture = Self.pictures.appendingPathComponent("pattern-o6.jpg")
        let prepared = try ImageExtractor.prepare(picture, maxPixel: 1024, minSide: 1, to: folder, png: false)
        let original = try #require(Phash256.ofFile(picture.path))
        let copy = try #require(Phash256.ofFile(prepared.path))
        #expect(copy.difference(from: original) <= 6,
                "difference \(copy.difference(from: original)) for \(prepared.width)x\(prepared.height)")
    }

    @Test func aFileThatIsNotAPictureHasNoFingerprint() {
        let text = folder.appendingPathComponent("notes.txt")
        try? "just words".write(to: text, atomically: true, encoding: .utf8)
        #expect(Phash256.ofFile(text.path) == nil)
    }

    /// Groups start with the best-ranked member (the one to show) and are ordered by it; a picture with no fingerprint
    /// is left alone; the difference is a percentage of the 256 bits, as in AntiDuplPlus.
    @Test func groupsFollowTheRankingAndTheDifference() throws {
        let one = Phash256(w0: 0)
        let same = Phash256(w0: 0)
        let near = Phash256(w0: 0b1_1111_1111_1111)   // 13 bits apart: 5.1%
        let far = Phash256(w0: .max, w1: .max, w2: .max, w3: .max)
        let hashes = ["a": one, "b": near, "c": same, "d": far]
        #expect(LookalikeGroups.group(paths: ["d", "a", "b", "c"], hashes: hashes, difference: 4) == [["a", "c"]])
        #expect(LookalikeGroups.group(paths: ["d", "a", "b", "c"], hashes: hashes, difference: 6) == [["a", "b", "c"]])
        #expect(LookalikeGroups.group(paths: ["d", "m", "a"], hashes: hashes, difference: 50) == [])
        #expect(LookalikeGroups.group(paths: ["a"], hashes: hashes, difference: 6) == [])
    }

    /// Several pictures on several threads give the same fingerprints as one at a time, and a file that isn't a
    /// picture is left out.
    @Test func manyPicturesAreHashedLikeOneAtATime() throws {
        let picture = Self.pictures.appendingPathComponent("pattern-o6.jpg")
        let prepared = try ImageExtractor.prepare(picture, maxPixel: 1024, minSide: 1, to: folder, png: false)
        let notes = folder.appendingPathComponent("notes.txt")
        try "just words".write(to: notes, atomically: true, encoding: .utf8)
        let bulk = PhashBulk.compute([picture.path, prepared.path, notes.path], threads: 3)
        #expect(bulk.count == 2)
        #expect(bulk[picture.path] == Phash256.ofFile(picture.path))
        #expect(bulk[prepared.path] == Phash256.ofFile(prepared.path))
        #expect(bulk[notes.path] == nil)
    }

    @Test func theDifferenceIsAPercentageOfTheBits() throws {        let none = Phash256(w0: 0)
        let one = Phash256(w0: 1)
        let all = Phash256(w0: .max, w1: .max, w2: .max, w3: .max)
        #expect(abs(one.difference(from: none) - 100.0 / 256) < 0.001)
        #expect(all.difference(from: none) == 100)
    }
}
