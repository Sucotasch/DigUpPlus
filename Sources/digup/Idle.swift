#if os(Windows)
import WinSDK
#endif
import Foundation

/// How long this computer has gone without keyboard or mouse input, in seconds. Nil where the system can't say (Linux),
/// and then the rest of long files keeps its own pacing instead of guessing (`RestPacing`).
enum Idle {
    static func seconds() -> Double? {
        #if os(Windows)
        var info = LASTINPUTINFO()
        info.cbSize = UINT(MemoryLayout<LASTINPUTINFO>.size)
        guard GetLastInputInfo(&info) else { return nil }
        let now = GetTickCount64()
        let last = UINT64(info.dwTime)
        return now >= last ? Double(now - last) / 1000 : 0
        #else
        return nil
        #endif
    }
}
