import Foundation
#if os(Windows)
import WinSDK
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// A clock that does not count the time the computer sleeps: the watchdog measures silence, and a suspended process is
/// not a hung one. `Date` jumps across a suspend; this does not.
public enum Monotonic {
    public static func now() -> TimeInterval {
        #if os(Windows)
        var ticks: ULONGLONG = 0
        if QueryUnbiasedInterruptTime(&ticks) { return Double(ticks) / 10_000_000 }
        return Date().timeIntervalSinceReferenceDate
        #elseif canImport(Glibc)
        var value = timespec()
        if clock_gettime(CLOCK_MONOTONIC, &value) == 0 {
            return Double(value.tv_sec) + Double(value.tv_nsec) / 1_000_000_000
        }
        return Date().timeIntervalSinceReferenceDate
        #elseif canImport(Darwin)
        var value = timespec()
        if clock_gettime(CLOCK_MONOTONIC, &value) == 0 {
            return Double(value.tv_sec) + Double(value.tv_nsec) / 1_000_000_000
        }
        return Date().timeIntervalSinceReferenceDate
        #else
        return Date().timeIntervalSinceReferenceDate
        #endif
    }
}
