import Testing
@testable import DigUpKit

@Suite("Watchdog policy")
struct WatchdogPolicyTests {
    let policy = WatchdogPolicy.default

    @Test func otherKindsKeepATotalLimit() {
        let read = ActiveRead(path: "/a.pdf", kind: .pdf, started: 100)
        #expect(policy.verdict(for: read, at: 100 + 14 * 60) == nil)
        #expect(policy.verdict(for: read, at: 100 + 16 * 60) == "took more than 15 minutes to read")
    }

    @Test func mediaGetsAStartBudget() {
        let read = ActiveRead(path: "/a.mp4", kind: .video, started: 0)
        #expect(policy.verdict(for: read, at: 29) == nil)
        #expect(policy.verdict(for: read, at: 31) == "gave no sign for 30 seconds")
    }

    @Test func aSignResetsTheSilence() {
        let read = ActiveRead(path: "/a.mp4", kind: .video, started: 0, lastSignal: 50, lastMove: 50)
        #expect(policy.verdict(for: read, at: 65) == nil)
        #expect(policy.verdict(for: read, at: 75) == "made no progress for 20 seconds")
    }

    /// With someone at the computer the decoder runs below normal: its blocks stretched to ~3.3 s on average under load
    /// (measured), so the watchdog allows 40 s instead of 20 before calling it a hang.
    @Test func aLowPriorityDecoderGetsTwiceTheSilence() {
        let read = ActiveRead(path: "/a.mp4", kind: .video, started: 0, lastSignal: 100, lastMove: 100,
                              lowPriority: true)
        #expect(policy.verdict(for: read, at: 139) == nil)
        #expect(policy.verdict(for: read, at: 141) == "made no progress for 40 seconds")
    }

    @Test func movementIsSeparateFromLiveness() {        let read = ActiveRead(path: "/a.mp4", kind: .video, started: 0, lastSignal: 110, lastMove: 0)
        #expect(policy.verdict(for: read, at: 110) == nil)
        #expect(policy.verdict(for: read, at: 121) == "stopped moving for 2 minutes")
    }

    @Test func aLongFilmWithProgressIsNotStopped() {
        // Three hours in, still moving: the old fixed 15 minutes would have failed it.
        let read = ActiveRead(path: "/a.mp4", kind: .video, started: 0,
                              lastSignal: 3 * 3600 - 1, lastMove: 3 * 3600 - 30)
        #expect(policy.verdict(for: read, at: 3 * 3600) == nil)
    }
}
