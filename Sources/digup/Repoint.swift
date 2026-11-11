// `digup repick` and `digup forget`: the two maintenance commands Settings → Folders uses when a chosen folder moved
// or its files were deleted. They work on the index file directly (the shell stops the indexing helper first), print
// one JSON line, and exit 0; a failure goes to stderr and exits 1.

import DigUpKit
import Foundation

/// `digup repick --from OLD --to NEW [--apply]`: what the move would do (rows, matched, changed, missing), or with
/// `--apply` the rows rewritten to the new folder. The folder's files that didn't change keep their vectors.
func repick(_ args: Arguments) throws -> Int32 {
    guard let from = args.values["--from"], let to = args.values["--to"] else {
        throw CLIError("repick needs --from OLD --to NEW")
    }
    let store = try IndexStore(directory: args.indexFolder)
    let apply = args.flags.contains("--apply")
    let counts = apply ? try store.repoint(from: from, to: to) : try store.repointPreview(from: from, to: to)
    emit(["event": "repoint", "applied": apply, "rows": counts.rows, "matched": counts.matched,
          "changed": counts.changed, "missing": counts.missing])
    return 0
}

/// `digup forget <folder>...`: their rows leave the index; the folders stay chosen (Settings → Folders → “files
/// deleted”).
func forget(_ args: Arguments) throws -> Int32 {
    guard !args.positional.isEmpty else { throw CLIError("forget which folders?") }
    let store = try IndexStore(directory: args.indexFolder)
    let removed = try store.delete(under: args.positional.map { Arguments.folderURL($0).path })
    emit(["event": "forgot", "removed": removed])
    return 0
}
