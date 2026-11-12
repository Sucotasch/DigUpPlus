// `digup phash [--limit N]`: fills in the look-alike fingerprints of pictures already in the index (Find similar's
// groups compare them). Pictures indexed from schema 7 on get one while they are read; this is for an index made
// before that, or for one whose pictures weren't hashed yet. It reads the originals once — no embedding, no vectors,
// no file touched — and prints one JSON line.

import DigUpKit
import Foundation

func phash(_ args: Arguments) throws -> Int32 {
    let store = try IndexStore(directory: args.indexFolder)
    let limit = max(1, Int(args.values["--limit"] ?? "500") ?? 500)
    let started = Date()
    let files = try store.filesMissingPhash(limit: limit)
    // One decode a picture, spread over the cores (AntiDuplPlus's collector does its analysis on a worker pool too):
    // 4.3 thousand pictures went from about eleven minutes in one thread to a fraction of that.
    let hashes = PhashBulk.compute(files.map(\.path), threads: Int(args.values["--threads"] ?? ""))
    try store.db.transaction {
        for file in files {
            if let fingerprint = hashes[file.path] { try store.setPhash(fingerprint, file: file.id) }
        }
    }
    let unreadable = files.count - hashes.count
    let left = try store.filesMissingPhash(limit: 1).count
    emit(["event": "phash", "hashed": hashes.count, "unreadable": unreadable, "left": left,
          "ms": Int(Date().timeIntervalSince(started) * 1000)])
    return 0
}
