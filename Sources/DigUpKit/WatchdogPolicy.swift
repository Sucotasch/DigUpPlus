import Foundation

/// A file being read right now, as the watchdog sees it: when the read started, when it last said anything at all, and
/// when it last moved (a frame, a page). `lastSignal`/`lastMove` start at `started`.
public struct ActiveRead: Sendable {
    public let path: String
    public let kind: FileKind
    public let started: TimeInterval
    public var lastSignal: TimeInterval
    public var lastMove: TimeInterval
    public var hasSignal: Bool

    public init(path: String, kind: FileKind, started: TimeInterval,
                lastSignal: TimeInterval? = nil, lastMove: TimeInterval? = nil) {
        self.path = path
        self.kind = kind
        self.started = started
        self.lastSignal = lastSignal ?? started
        self.lastMove = lastMove ?? started
        self.hasSignal = lastSignal != nil
    }
}

/// When a read has gone on too long. Media (audio, video) is judged by liveness and movement: a long clip may decode for
/// an hour, and a fixed total would fail it while it is working. Every other kind keeps a total limit, because a page or
/// a chunk that takes a quarter of an hour is a runaway.
public struct WatchdogPolicy: Sendable {
    /// Before the first signal: process start, ffprobe, a sleeping disk, antivirus.
    public let startLimit: TimeInterval
    /// Between two signs of life: an ffmpeg `-progress` block comes every ~0.5 s (measured).
    public let silenceLimit: TimeInterval
    /// Between two real steps: a video's `out_time`, a frame, a page.
    public let moveLimit: TimeInterval
    /// For the kinds without progress signals.
    public let totalLimit: TimeInterval

    public static let `default` = WatchdogPolicy(startLimit: 30, silenceLimit: 20, moveLimit: 120,
                                                 totalLimit: 15 * 60)

    public init(startLimit: TimeInterval, silenceLimit: TimeInterval, moveLimit: TimeInterval,
                totalLimit: TimeInterval) {
        self.startLimit = startLimit
        self.silenceLimit = silenceLimit
        self.moveLimit = moveLimit
        self.totalLimit = totalLimit
    }

    /// Why the read should be stopped, or nil while it is fine. `now` comes from `Monotonic`, so a sleeping computer
    /// does not count as silence.
    public func verdict(for read: ActiveRead, at now: TimeInterval) -> String? {
        let elapsed = now - read.started
        if read.kind == .audio || read.kind == .video {
            if !read.hasSignal, elapsed > startLimit {
                return "gave no sign for \(Self.span(startLimit))"
            }
            if read.hasSignal, now - read.lastSignal > silenceLimit {
                return "made no progress for \(Self.span(silenceLimit))"
            }
            if now - read.lastMove > moveLimit {
                return "stopped moving for \(Self.span(moveLimit))"
            }
        } else if elapsed > totalLimit {
            return "took more than \(Self.span(totalLimit)) to read"
        }
        return nil
    }

    static func span(_ seconds: TimeInterval) -> String {
        seconds >= 120 ? "\(Int(seconds / 60)) minutes" : "\(Int(seconds)) seconds"
    }
}
