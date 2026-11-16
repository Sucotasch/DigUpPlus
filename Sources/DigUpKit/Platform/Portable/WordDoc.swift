// Legacy Word files (.doc) without Word or any converter on the machine: the OLE container (Compound File Binary),
// the Word 97 information block and its piece table, which is where the text and its code page live. The method is
// antiword's and wvWare's; none of their code is here. Word 6/95 (no piece table) reads as one run of bytes.

import Foundation

enum WordDoc {
    static func text(of url: URL) throws -> String {
        let file = try CompoundFile(try Data(contentsOf: url))
        guard let document = file.stream("WordDocument") else {
            throw ExtractError.unreadable("not a Word document")
        }
        // FibBase.fWhichTblStm: bit 9 of the flags at 10 says which table stream holds the piece table.
        let flags = number(document, 10, 2)
        let table = file.stream(flags & 0x0200 != 0 ? "1Table" : "0Table")
        return try text(document: document, table: table)
    }

    /// The text from a WordDocument stream and its table; no container, so a test can hand it two arrays of bytes.
    static func text(document: [UInt8], table: [UInt8]?) throws -> String {
        guard document.count >= 0x01AA, number(document, 0, 2) == 0xA5EC else {
            throw ExtractError.unreadable("not a Word 97 document")
        }
        let fcClx = number(document, 0x01A2, 4), lcbClx = number(document, 0x01A6, 4)
        // One byte a character is the document's ANSI code page, which the language and character-set fields name.
        let lid = number(document, 6, 2), chs = number(document, 20, 2)
        let cyrillic = chs == 204 || [0x0402, 0x0403, 0x0419, 0x0422, 0x0423, 0x042F, 0x043F, 0x0440, 0x0444, 0x0450,
                                      0x082C, 0x0843].contains(lid)
        let encoding: String.Encoding = cyrillic ? .windowsCP1251 : .windowsCP1252
        guard let table, lcbClx > 0, fcClx + lcbClx <= table.count else {
            // Word 6 and 95 keep the text in one run between fcMin and fcMac, with no piece table.
            let start = number(document, 24, 4), end = number(document, 28, 4)
            guard start < end, end <= document.count else { throw ExtractError.unreadable("no text in the document") }
            let piece = Data(document[start..<end])
            return clean(String(data: piece, encoding: encoding) ?? String(decoding: piece, as: UTF8.self))
        }
        let clx = Array(table[fcClx..<(fcClx + lcbClx)])
        var at = 0
        while at < clx.count, clx[at] == 0x01 {   // Prc: property runs that readers skip
            at += 3 + number(clx, at + 1, 2)
        }
        guard at + 5 <= clx.count, clx[at] == 0x02 else { throw ExtractError.unreadable("no piece table") }
        let length = number(clx, at + 1, 4), plc = at + 5
        guard length >= 4, plc + length <= clx.count, (length - 4) % 12 == 0 else {
            throw ExtractError.unreadable("damaged piece table")
        }
        let pieces = (length - 4) / 12
        var text = ""
        for piece in 0..<pieces {
            let from = number(clx, plc + 4 * piece, 4), to = number(clx, plc + 4 * (piece + 1), 4)
            let count = to - from
            guard count > 0 else { continue }
            let fc = number(clx, plc + 4 * (pieces + 1) + 8 * piece + 2, 4)
            if fc & 0x4000_0000 != 0 {
                let start = Int(fc & 0x3FFF_FFFF) / 2
                guard start + count <= document.count else { continue }
                let piece = Data(document[start..<(start + count)])
                text += String(data: piece, encoding: encoding) ?? String(decoding: piece, as: UTF8.self)
            } else {
                let start = fc & 0x3FFF_FFFF
                guard start + count * 2 <= document.count else { continue }
                var units: [UInt16] = []
                units.reserveCapacity(count)
                for index in 0..<count {
                    units.append(UInt16(document[start + index * 2]) | UInt16(document[start + index * 2 + 1]) << 8)
                }
                text += String(decoding: units, as: UTF16.self)
            }
        }
        return clean(text)
    }

    /// Word's control characters as text: paragraph, line and page ends, cells, and a field's result but not its
    /// instruction (the text between 0x13 and 0x14 is "HYPERLINK …" and the like).
    private static func clean(_ raw: String) -> String {
        var out = String.UnicodeScalarView()
        var inField = 0
        for scalar in raw.unicodeScalars {
            switch scalar {
            case "\u{13}": inField += 1
            case "\u{14}": inField = max(0, inField - 1)
            case "\u{15}", "\u{1F}": break
            default:
                guard inField == 0 else { continue }
                switch scalar {
                case "\r", "\u{0B}", "\u{0C}": out.append("\n")
                case "\u{07}": out.append("\t")
                default: if scalar.value >= 0x20 { out.append(scalar) }
                }
            }
        }
        return String(out)
    }
}

/// A little-endian number of `size` bytes at `offset`; past the end is zero, never a trap.
private func number(_ bytes: [UInt8], _ offset: Int, _ size: Int) -> Int {
    guard offset >= 0, offset + size <= bytes.count else { return 0 }
    var value = 0
    for index in (offset..<(offset + size)).reversed() { value = value << 8 | Int(bytes[index]) }
    return value
}

private func utf16(_ bytes: [UInt8], _ offset: Int, _ units: Int) -> String {
    var scalars: [UInt16] = []
    scalars.reserveCapacity(units)
    for index in 0..<units {
        let at = offset + index * 2
        guard at + 1 < bytes.count else { break }
        scalars.append(UInt16(bytes[at]) | UInt16(bytes[at + 1]) << 8)
    }
    return String(decoding: scalars, as: UTF16.self)
}

/// The Compound File Binary container Word saves into: a FAT of sectors, a directory of streams, and streams under
/// the cutoff kept in a mini stream of their own.
private struct CompoundFile {
    private struct Entry {
        let start: UInt32
        let size: Int
    }

    private let bytes: [UInt8]
    private var sector = 512
    private var miniSector = 64
    private var cutoff = 4096
    private var fat: [UInt32] = []
    private var miniFat: [UInt32] = []
    private var miniStream: [UInt8] = []
    private var entries: [String: Entry] = [:]

    init(_ data: Data) throws {
        bytes = [UInt8](data)
        guard bytes.count >= 512, Array(bytes[0..<8]) == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] else {
            throw ExtractError.unreadable("not an OLE file")
        }
        sector = 1 << number(bytes, 30, 2)
        miniSector = 1 << number(bytes, 32, 2)
        cutoff = number(bytes, 56, 4)
        var fatSectors = (0..<109).map { number(bytes, 76 + 4 * $0, 4) }
        var difat = number(bytes, 68, 4)
        for _ in 0..<number(bytes, 72, 4) where difat < 0xFFFF_FFFE {
            let at = 512 + difat * sector
            guard at + sector <= bytes.count else { break }
            fatSectors += (0..<(sector / 4 - 1)).map { number(bytes, at + 4 * $0, 4) }
            difat = number(bytes, at + sector - 4, 4)
        }
        for index in fatSectors where index < 0xFFFF_FFFE {
            let at = 512 + index * sector
            guard at + sector <= bytes.count else { continue }
            fat += (0..<(sector / 4)).map { UInt32(number(bytes, at + 4 * $0, 4)) }
        }
        for index in chain(UInt32(number(bytes, 48, 4)), in: fat, base: 512, unit: sector) {
            let at = 512 + index * sector
            guard at + sector <= bytes.count else { break }
            for offset in stride(from: 0, to: sector, by: 128) {
                let entryAt = at + offset
                guard entryAt + 128 <= bytes.count, bytes[entryAt + 66] != 0 else { continue }
                let name = utf16(bytes, entryAt, 32).split(separator: "\0").first.map(String.init) ?? ""
                entries[name] = Entry(start: UInt32(number(bytes, entryAt + 116, 4)),
                                      size: number(bytes, entryAt + 120, 4))
            }
        }
        for index in chain(UInt32(number(bytes, 60, 4)), in: fat, base: 512, unit: sector) {
            let at = 512 + index * sector
            guard at + sector <= bytes.count else { break }
            miniFat += (0..<(sector / 4)).map { UInt32(number(bytes, at + 4 * $0, 4)) }
        }
        if let root = entries["Root Entry"], root.size > 0 {
            miniStream = read(root.start, root.size, in: fat, base: 512, unit: sector, from: bytes)
        }
    }

    /// The stream's bytes, whether the container keeps them in the file or in the mini stream.
    func stream(_ name: String) -> [UInt8]? {
        guard let entry = entries[name] else { return nil }
        if entry.size < cutoff {
            return read(entry.start, entry.size, in: miniFat, base: 0, unit: miniSector, from: miniStream)
        }
        return read(entry.start, entry.size, in: fat, base: 512, unit: sector, from: bytes)
    }

    /// The sector indices of a chain; a damaged chain ends rather than loops.
    private func chain(_ start: UInt32, in table: [UInt32], base: Int, unit: Int) -> [Int] {
        var indices: [Int] = []
        var index = start
        while index < 0xFFFF_FFFE, Int(index) < table.count, indices.count <= table.count {
            guard base + Int(index) * unit + unit <= bytes.count else { break }
            indices.append(Int(index))
            index = table[Int(index)]
        }
        return indices
    }

    private func read(_ start: UInt32, _ size: Int, in table: [UInt32], base: Int, unit: Int,
                      from source: [UInt8]) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(size)
        var index = start
        var steps = 0
        while index < 0xFFFF_FFFE, out.count < size, Int(index) < table.count, steps <= table.count {
            let at = base + Int(index) * unit
            guard at + unit <= source.count else { break }
            out.append(contentsOf: source[at..<(at + unit)])
            index = table[Int(index)]
            steps += 1
        }
        return Array(out.prefix(size))
    }
}
