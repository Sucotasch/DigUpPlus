import DigUpKit
import Foundation
#if os(Windows)
import WinSDK
#endif

/// Ends the indexing helper when reading one file runs away. Apple's PDF text extraction has grown without end on a
/// page of some PDFs (30 GB in 3.5 minutes, never returning), and nothing stops code like that from outside but ending
/// the process. Every second the watchdog looks at the helper's memory (footprint) and at the read that has been silent
/// the longest (`Indexer.slowestRead`): past `memoryLimit`, or past the policy's limits, it writes down the file and why
/// (`StoppedFile`) and exits with `StoppedFile.exitCode`: the app starts a new helper, which marks that file as one that
/// couldn't be read and goes on.
final class Watchdog: @unchecked Sendable {
    let memoryLimit: UInt64
    let policy: WatchdogPolicy
    let note: URL

    /// Half the Mac's memory, but at least 4 GB and at most 8 GB: indexing peaks at 1–3 GB on the biggest files.
    static var defaultMemoryLimit: UInt64 {
        min(8 << 30, max(4 << 30, ProcessInfo.processInfo.physicalMemory / 2))
    }

    init(folder: URL, memoryLimit: UInt64 = Watchdog.defaultMemoryLimit, policy: WatchdogPolicy = .default) {
        self.memoryLimit = memoryLimit
        self.policy = policy
        note = StoppedFile.location(in: folder)
    }

    func start() {
        Thread.detachNewThread { [self] in
            while true {
                Thread.sleep(forTimeInterval: 1)
                let read = Indexer.slowestRead
                if let footprint = Self.footprint(), footprint > memoryLimit {
                    stop(read?.path, why: "needed more than \(Self.size(memoryLimit)) of memory to read")
                }
                if let read, let why = policy.verdict(for: read, at: Monotonic.now()) {
                    stop(read.path, why: why)
                }
            }
        }
    }

    private func stop(_ path: String?, why: String) -> Never {
        StoppedFile(path: path, why: why).write(to: note)
        emit(["event": "error", "message": "watchdog: \(why): \(path ?? "no file being read")"])
        FileHandle.standardError.write(Data("watchdog: \(why): \(path ?? "no file being read")\n".utf8))
        #if os(Windows)
        exit(StoppedFile.exitCode)
        #else
        _exit(StoppedFile.exitCode)
        #endif
    }

    private static func size(_ bytes: UInt64) -> String {
        bytes >= 1 << 30 ? String(format: "%.0f GB", Double(bytes) / Double(1 << 30)) : "\(bytes >> 20) MB"
    }

    /// This process's memory as Activity Monitor counts it: its footprint on a Mac, resident memory on Linux and the
    /// working set on Windows (`K32GetProcessMemoryInfo`, the same number Task Manager shows).
    static func footprint() -> UInt64? {
        #if canImport(Darwin)
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : nil
        #elseif os(Windows)
        var counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = DWORD(MemoryLayout<PROCESS_MEMORY_COUNTERS>.size)
        guard K32GetProcessMemoryInfo(GetCurrentProcess(), &counters, counters.cb) else { return nil }
        return UInt64(counters.WorkingSetSize)
        #elseif os(Linux)
        guard let statm = try? String(contentsOfFile: "/proc/self/statm", encoding: .utf8),
              let pages = statm.split(separator: " ").dropFirst().first.flatMap({ UInt64($0) }) else { return nil }
        return pages * UInt64(getpagesize())
        #else
        return nil
        #endif
    }
}

/// The file a helper stopped on (`Watchdog`), written beside the index for the next helper.
struct StoppedFile: Codable {
    /// The exit status that says "a file was stopped: start a new helper" (EX_TEMPFAIL).
    static let exitCode: Int32 = 75

    let path: String?
    let why: String

    static func location(in folder: URL) -> URL {
        folder.appendingPathComponent("stopped-file.json")
    }

    func write(to url: URL) {
        try? JSONEncoder().encode(self).writeReplacing(url)
    }

    /// The note an earlier helper left, removed as it's read.
    static func take(from folder: URL) -> StoppedFile? {
        let url = location(in: folder)
        guard let data = try? Data(contentsOf: url) else { return nil }
        try? FileManager.default.removeItem(at: url)
        return try? JSONDecoder().decode(StoppedFile.self, from: data)
    }
}
