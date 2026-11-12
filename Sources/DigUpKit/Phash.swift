// A picture's 256-bit look-alike fingerprint: 64x64 grayscale → DCT-II → the 16x16 low-frequency block → one bit per
// coefficient against the block's median. The recipe is AntiDuplPlus's (MIT; measured there on a duplicate corpus),
// and "difference" means the same thing here: `100 * hamming / 256`. It survives resizing, re-compression, a monochrome
// copy and a change of brightness; a crop or a rotation it does not (measured 2026-11-12: under 1.6% and 25-40%).
//
// The window's Find similar groups a result list by it: a fingerprint says "same look", never "same file" — nothing is
// deleted, renamed or hidden from file operations by it.
import Foundation

public struct Phash256: Hashable, Sendable {
    /// Kept with the index: a changed recipe invalidates the stored hashes (they are cheap to recompute, and a mix of
    /// two recipes would group nothing).
    public static let recipe = "phash256-dct16-v1"
    /// The grayscale square the DCT runs on.
    public static let side = 64
    /// The low-frequency block: 16x16 coefficients, one bit each.
    static let block = 16
    public static let bits = block * block

    public let w0: UInt64, w1: UInt64, w2: UInt64, w3: UInt64

    public init(w0: UInt64, w1: UInt64 = 0, w2: UInt64 = 0, w3: UInt64 = 0) {
        (self.w0, self.w1, self.w2, self.w3) = (w0, w1, w2, w3)
    }

    /// The fingerprint of a `side * side` grayscale picture, row by row.
    public static func of(gray: [UInt8]) -> Phash256? {
        guard gray.count == side * side else { return nil }
        // DCT-II of the low block only: F[u][v] = sum f[x][y] * cos(u, x) * cos(v, y). The shared factor scipy applies
        // (and the 2^k scaling) doesn't matter: every bit is a comparison against the median.
        var rows = [Double](repeating: 0, count: block * side)
        for u in 0..<block {
            let cosinesU = cosines[u]
            for y in 0..<side {
                var sum = 0.0
                let base = y * side
                for x in 0..<side { sum += Double(gray[base + x]) * cosinesU[x] }
                rows[u * side + y] = sum
            }
        }
        var values = [Double](repeating: 0, count: bits)
        for u in 0..<block {
            for v in 0..<block {
                let cosinesV = cosines[v]
                var sum = 0.0
                for y in 0..<side { sum += rows[u * side + y] * cosinesV[y] }
                values[u * block + v] = sum
            }
        }
        let sorted = values.sorted()
        let median = 0.5 * (sorted[bits / 2 - 1] + sorted[bits / 2])
        var words = [UInt64](repeating: 0, count: 4)
        for (index, value) in values.enumerated() where value > median {
            words[index / 64] |= 1 << UInt64(index % 64)
        }
        return Phash256(w0: words[0], w1: words[1], w2: words[2], w3: words[3])
    }

    /// From a picture file, through the platform's own reader (`ImageExtractor.graySquare`); nil for a format it can't
    /// read (a RAW, say), which leaves that picture ungrouped rather than wrong.
    public static func ofFile(_ path: String) -> Phash256? {
        guard let gray = ImageExtractor.graySquare(path, side: side) else { return nil }
        return of(gray: gray)
    }

    public func hamming(_ other: Phash256) -> Int {
        (w0 ^ other.w0).nonzeroBitCount + (w1 ^ other.w1).nonzeroBitCount
            + (w2 ^ other.w2).nonzeroBitCount + (w3 ^ other.w3).nonzeroBitCount
    }

    /// How different two pictures are, in AntiDuplPlus's units: 0 is identical, 100 is every bit apart.
    public func difference(from other: Phash256) -> Double {
        100 * Double(hamming(other)) / Double(Self.bits)
    }

    /// The 32 bytes the index keeps (little-endian words).
    public var data: Data {
        var bytes = Data(capacity: 32)
        for word in [w0, w1, w2, w3] {
            withUnsafeBytes(of: word.littleEndian) { bytes.append(contentsOf: $0) }
        }
        return bytes
    }

    public init?(data: Data) {
        guard data.count == 32 else { return nil }
        let words = data.withUnsafeBytes { buffer in
            (0..<4).map { offset in
                UInt64(littleEndian: buffer.loadUnaligned(fromByteOffset: offset * 8, as: UInt64.self))
            }
        }
        self.init(w0: words[0], w1: words[1], w2: words[2], w3: words[3])
    }

    private static let cosines: [[Double]] = (0..<block).map { u in
        (0..<side).map { x in
            cos(Double.pi * Double(u) * (2 * Double(x) + 1) / (2 * Double(side)))
        }
    }
}

/// The groups of a result list: which of its pictures look alike, in the list's order.
public enum LookalikeGroups {
    /// The groups among `paths` (in the order given, which is the ranking), each starting with the member to show —
    /// the best-ranked. `difference` is a percentage of the 256 bits, 0...50. A path with no fingerprint is skipped.
    public static func group(paths: [String], hashes: [String: Phash256], difference: Double) -> [[String]] {
        let limit = Int((max(0, min(50, difference)) / 100 * Double(Phash256.bits)).rounded())
        let items = paths.compactMap { path in hashes[path].map { (path, $0) } }
        guard items.count > 1 else { return [] }
        var parent = Array(0..<items.count)
        func find(_ index: Int) -> Int {
            var index = index
            while parent[index] != index {
                parent[index] = parent[parent[index]]
                index = parent[index]
            }
            return index
        }
        for i in 0..<items.count {
            for j in (i + 1)..<items.count where items[i].1.hamming(items[j].1) <= limit {
                let (a, b) = (find(i), find(j))
                if a != b { parent[b] = a }
            }
        }
        var members: [Int: [Int]] = [:]
        for index in items.indices { members[find(index), default: []].append(index) }
        return members.values
            .filter { $0.count > 1 }
            .map { indices in indices.sorted().map { items[$0].0 } }
            .sorted { first, second in
                let one = paths.firstIndex(of: first[0]) ?? 0
                let two = paths.firstIndex(of: second[0]) ?? 0
                return one < two
            }
    }
}
