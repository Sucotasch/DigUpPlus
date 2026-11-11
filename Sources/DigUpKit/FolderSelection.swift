import Foundation

/// Which folders DigUp searches: the folders you chose, minus the folders you skipped inside them. A skip applies
/// inside the chosen folders that contain it, and a chosen folder is searched whole even inside a skipped one (skip
/// Downloads/Media, still choose Downloads/Media/Courses). The crawler, the search filter and the folder lists in
/// onboarding and Settings all follow this rule.
///
/// The folder lists show folders with one level of their subfolders, each with a checkbox. A subfolder can be searched
/// without the rest of its folder (it's chosen on its own), or left out of a folder that's searched (it's skipped).
public struct FolderSelection: Equatable, Sendable {
    /// A folder's checkbox: all of it, some of its subfolders, or none.
    public enum Mark: Sendable {
        case on, mixed, off
    }

    public private(set) var chosen: [String]
    public private(set) var skipped: [String]
    /// Folders already searched (when Settings adds more): whatever is clicked, they stay.
    public let kept: [String]

    public init(chosen: [String] = [], skipped: [String] = [], kept: [String] = []) {
        self.chosen = Self.unique(chosen)
        self.skipped = Self.unique(skipped)
        self.kept = Self.unique(kept)
    }

    /// Whether `path` (a folder or a file) is searched.
    public func isSearched(_ path: String) -> Bool {
        Self.isSearched(path, folders: kept + chosen, skipped: skipped)
    }

    public static func isSearched(_ path: String, folders: [String], skipped: [String]) -> Bool {
        folders.contains { folder in
            (path == folder || isInside(path, folder))
                && !skipped.contains { skip in isInside(skip, folder) && (path == skip || isInside(path, skip)) }
        }
    }

    /// The closest chosen (or kept) folder that searches `path`.
    public func searchedAs(_ path: String) -> String? {
        (kept + chosen).filter { folder in
            (path == folder || Self.isInside(path, folder)) && Self.isSearched(path, folders: [folder], skipped: skipped)
        }.max { $0.count < $1.count }
    }

    /// What the indexer gets: kept and chosen folders, without those another one already searches whole.
    public var folders: [String] {
        let all = Self.unique(kept + chosen)
        return all.filter { folder in
            !all.contains { other in
                other != folder && Self.isInside(folder, other)
                    && Self.isSearched(folder, folders: [other], skipped: skipped)
            }
        }
    }

    /// The skips that leave something out (inside a folder that's searched).
    public var effectiveSkips: [String] {
        let folders = self.folders
        return skipped.filter { skip in folders.contains { Self.isInside(skip, $0) } }
    }

    /// A folder's checkbox: mixed when some of its subfolders are skipped (it's searched) or chosen (it isn't).
    /// Deeper choices don't show here; the folder lists name them.
    public func mark(_ folder: String) -> Mark {
        if isSearched(folder) {
            return skipped.contains { Self.parent($0) == folder && !isSearched($0) } ? .mixed : .on
        }
        return (kept + chosen).contains { Self.parent($0) == folder } ? .mixed : .off
    }

    /// Checks or unchecks a folder and its subfolders: all of it, or none of it.
    public mutating func setFolder(_ folder: String, on: Bool) {
        skipped.removeAll { Self.parent($0) == folder }
        chosen.removeAll { Self.parent($0) == folder }
        setSubfolder(folder, on: on)
    }

    /// Checks or unchecks one folder, leaving the choices inside it as they are.
    public mutating func setSubfolder(_ folder: String, on: Bool) {
        if on {
            skipped.removeAll { $0 == folder }
            if !isSearched(folder) { chosen.append(folder) }
        } else {
            chosen.removeAll { $0 == folder }
            if isSearched(folder) { skipped.append(folder) }
        }
    }

    /// Stops skipping `folder` (without choosing it).
    public mutating func unskip(_ folder: String) {
        skipped.removeAll { $0 == folder }
    }

    public static func isInside(_ path: String, _ folder: String) -> Bool {
        // Windows compares paths without case (SearchService.isCrawled and echo.rs do too): a folder stored as
        // `C:\One\Photos` still contains `c:\one\photos\a.jpg`. The lowercase allocates per call; if a crawl ever
        // shows that cost, normalize the stored roots instead.
        #if os(Windows)
        let path = path.lowercased()
        let folder = folder.lowercased()
        #endif
        return path.hasPrefix(folder.hasSuffix("/") ? folder : folder + "/")
    }

    /// A folder with no entries but junk (Thumbs.db, desktop.ini) and hidden names: the crawl reads nothing there, so a
    /// sync would take its rows for deleted ones. Settings → Folders offers “moved?” or “files deleted” instead.
    public static func isEmptyFolder(_ path: String) -> Bool {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: path) else { return false }
        return entries.allSatisfy { $0.hasPrefix(".") || Rules.isJunk($0) }
    }

    public static func parent(_ path: String) -> String {
        (path as NSString).deletingLastPathComponent
    }

    /// The path as a walk of the folder reports it (/private/var where `standardizedFileURL` says /var).
    public static func realPath(_ path: String) -> String {
        #if os(Windows)
        let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        // Foundation's standardization drops one slash of a share's leading `//` (`\\srv\share` became `/srv/share`, a
        // path on the current drive): a share looked like a folder under C: and never indexed (upstream #181).
        if path.hasPrefix("\\\\") || path.hasPrefix("//") {
            return resolved.hasPrefix("//") ? resolved : "/" + resolved
        }
        return resolved
        #else
        guard let real = realpath(path, nil) else { return path }
        defer { free(real) }
        return String(cString: real)
        #endif
    }

    /// The crawl's spelling, even for a deleted path: resolve its closest surviving ancestor first.
    static func crawlPath(_ path: String) -> String {
        let path = standardized(path)
        if FileManager.default.fileExists(atPath: path) { return realPath(path) }
        #if os(Windows)
        // A share that can't be reached now (the drive is unplugged) has no ancestor to resolve, and walking up would
        // lose its leading `//`: it stays as it is.
        if path.hasPrefix("//") { return path }
        #endif
        let parent = Self.parent(path)
        guard parent != path, !parent.isEmpty else { return path }
        let realParent = crawlPath(parent)
        return realParent + (realParent.hasSuffix("/") ? "" : "/") + (path as NSString).lastPathComponent
    }

    /// `standardizedFileURL`, with a UNC path's leading `//` kept: Foundation drops one slash (`\\srv\share` →
    /// `/srv/share`), which turns a share into a path on the current drive.
    static func standardized(_ path: String) -> String {
        let standardized = URL(fileURLWithPath: path).standardizedFileURL.path
        #if os(Windows)
        if path.hasPrefix("\\\\") || path.hasPrefix("//") {
            return standardized.hasPrefix("//") ? standardized : "/" + standardized
        }
        #endif
        return standardized
    }

    /// A drive letter as Windows writes it ("c:/x" → "C:/x"): the index's paths and a folder typed by hand can differ
    /// only there, while SQLite compares the bytes of a path range.
    static func capitalisedDrive(_ path: String) -> String {
        #if os(Windows)
        guard path.count >= 2, path[path.index(after: path.startIndex)] == ":" else { return path }
        let letter = path.first!
        guard letter.isLetter, letter.isLowercase else { return path }
        return String(letter).uppercased() + path.dropFirst()
        #else
        return path
        #endif
    }

    private static func unique(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        return paths.filter { seen.insert($0).inserted }
    }
}
