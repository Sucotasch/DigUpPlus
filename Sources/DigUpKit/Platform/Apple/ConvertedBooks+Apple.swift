// The books Platform/Portable reads with a program from outside the app (CHM, DJVU) have no reader here; the Mac
// keeps the Cocoa text system for its word-processor files.

#if canImport(AppKit)
import Foundation

enum ConvertedBook {
    static func text(of url: URL, type ext: String) throws -> String {
        throw ExtractError.unreadable(".\(ext) files aren't read here")
    }
}
#endif
