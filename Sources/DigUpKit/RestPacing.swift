/// How the rest of long files paces itself when it may only run while the computer is idle (`IndexService`): when it may
/// start, and how long it pauses after a step. In the engine rather than the helper so the rule can be tested without a
/// keyboard.
public enum RestPacing {
    /// The pause is this many times the step it follows: the pass runs at about a third of its speed, which still
    /// finishes a book in minutes and leaves the machine usable if someone comes back mid-step.
    public static let slowFor = 2.0
    /// The longest pause after one step (a scanned PDF page can take a while).
    public static let slowCap = 5.0

    /// `idle`: seconds since the last keyboard or mouse input, nil where the system can't say — then there is nothing
    /// to wait for and the pass runs as it always has. `threshold` 0 turns the gate off.
    public static func mayStart(idle: Double?, after threshold: Double) -> Bool {
        guard threshold > 0 else { return true }
        guard let idle else { return true }
        return idle >= threshold
    }

    public static func pause(after seconds: Double, enabled: Bool) -> Double {
        guard enabled else { return 0 }
        return min(max(0, seconds) * slowFor, slowCap)
    }
}
