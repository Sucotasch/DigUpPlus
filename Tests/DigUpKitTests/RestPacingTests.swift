import Testing
@testable import DigUpKit

@Suite final class RestPacingTests {
    @Test func theRestOfLongFilesWaitsForTheComputerToBeIdle() {
        // Someone typing or reading results recently: nothing starts.
        #expect(!RestPacing.mayStart(idle: 12, after: 300))
        #expect(!RestPacing.mayStart(idle: 299.9, after: 300))
        #expect(RestPacing.mayStart(idle: 300, after: 300))
        // No way to tell (Linux): no gate rather than a guess.
        #expect(RestPacing.mayStart(idle: nil, after: 300))
        // Off.
        #expect(RestPacing.mayStart(idle: 0, after: 0))
    }

    @Test func aStepIsFollowedByAPauseOfTwiceItsOwnTime() {
        #expect(RestPacing.pause(after: 0.5, enabled: true) == 1.0)
        #expect(RestPacing.pause(after: 2, enabled: true) == 4.0)
        #expect(RestPacing.pause(after: 10, enabled: true) == RestPacing.slowCap)   // a long scanned page
        #expect(RestPacing.pause(after: 10, enabled: false) == 0)                   // a script's own pass
    }
}
