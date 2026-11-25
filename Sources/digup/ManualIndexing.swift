import Foundation
#if os(Windows)
import WinSDK
#endif

/// Index Now: the person asked for indexing at once, so for the rest of this helper's run nothing gives way — media
/// decodes with every thread, the rest of long files doesn't wait for an idle machine, and on Windows the helper goes
/// back to normal priority (the shell starts it below normal). The mode dies with the helper: the next one starts
/// automatic again, so an idle machine and the hours are as they were.
final class ManualIndexing: @unchecked Sendable {
    private let lock = NSLock()
    private var forced: Bool

    init(startingFullSpeed: Bool = false) {
        forced = startingFullSpeed
        if startingFullSpeed { Self.applyPriority(fullSpeed: true) }
    }

    /// Read per media read and per step of the rest of long files (`IndexService`, `IndexOptions.userIsActive`).
    var isForced: Bool { lock.withLock { forced } }

    func set(_ on: Bool) {
        lock.withLock { forced = on }
        Self.applyPriority(fullSpeed: on)
    }

    /// Windows lets a process raise its own class back; POSIX `nice` cannot be raised again without privileges, so there
    /// the threads and the idle gate are all that change.
    private static func applyPriority(fullSpeed: Bool) {
        #if os(Windows)
        SetPriorityClass(GetCurrentProcess(), DWORD(fullSpeed ? NORMAL_PRIORITY_CLASS : BELOW_NORMAL_PRIORITY_CLASS))
        #endif
    }
}
