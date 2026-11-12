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
    var hashed = 0, unreadable = 0
    for file in try store.filesMissingPhash(limit: limit) {
        if let fingerprint = Phash256.ofFile(file.path) {
            try store.setPhash(fingerprint, file: file.id)
            hashed += 1
        } else {
            unreadable += 1
        }
    }
    let left = try store.filesMissingPhash(limit: 1).count
    emit(["event": "phash", "hashed": hashed, "unreadable": unreadable, "left": left,
          "ms": Int(Date().timeIntervalSince(started) * 1000)])
    return 0
}
