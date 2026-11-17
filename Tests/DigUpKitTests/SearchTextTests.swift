import Foundation
import Testing
@testable import DigUpKit

@Suite final class SearchTextTests {
    @Test func stubsHaveWordsButNoProse() {
        for stub in ["DEBUG=true", "root = true", "#separator:pipe", "id,name,value", "User-agent: *", "# Ignore logs\n*.log"] {
            #expect(SearchText.hasWords(stub), "\(stub)")
            #expect(!SearchText.hasProse(stub), "\(stub)")
        }
        #expect(SearchText.hasProse("Buy milk, eggs and bread tomorrow"))
        #expect(!SearchText.hasProse("Meeting at 3"))
        #expect(!SearchText.hasProse("12 34 56 78 90"))
    }

    let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DigUpTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    deinit { try? FileManager.default.removeItem(at: folder) }

    @Test func normalizedFoldsWhatIsTypedDifferently() {
        #expect(SearchText.normalized("الْمَكْتَبَةَ") == "المكتبة")              // harakat
        #expect(SearchText.normalized("إلى الأردن") == "الى الاردن")              // alef forms
        #expect(SearchText.normalized("مـــرحبا") == "مرحبا")                      // tatweel
        #expect(SearchText.normalized("\u{FEFB}") == "\u{0644}\u{0627}")           // the lam-alef ligature → lam, alef
        #expect(SearchText.normalized("\u{FB01}le") == "file")                     // ﬁ
        #expect(SearchText.normalized("র\u{200D}্যাব") == "র্যাব")                  // zero-width joiner
        #expect(SearchText.normalized("\u{09C7}\u{09BE}") == "\u{09CB}")           // ে + া → ো
        #expect(SearchText.normalized("a\u{200B}b") == "a b")                      // zero-width space breaks words
    }

    @Test func queryWordsOfLanguagesWithEndingsArePrefixes() {
        #expect(Searcher.ftsQuery("কুমির") == "\"কুমির\"*")
        #expect(Searcher.ftsQuery("مدرسة الأطفال") == "\"مدرسة\"* OR \"الاطفال\"*")
        #expect(Searcher.ftsQuery("মা") == "\"মা\"*")   // a letter and its vowel sign: two, so it counts
        #expect(Searcher.ftsQuery("payment error") == "\"payment\" OR \"error\"")
        #expect(Searcher.kindHints("জেব্রার ভিডিওতে") == [.video])
        #expect(Searcher.kindHints("صورة حمار وحشي") == [.image])
    }

    @Test func aPictureKeptOnlyForItsWordsIsNotAmongThePictures() throws {
        let index = folder.appendingPathComponent("look-filter")
        let store = try IndexStore(directory: index)
        let words = try store.insert(Candidate(path: "/shots/error.png", kind: .screenshot, size: 1, mtime: 1,
                                               inode: 1, device: 1, looksPictures: false))
        try store.addSegment(file: words, kind: .ocr, modality: .text, text: "zorblat in the log")
        try store.finish(words, state: "done")
        let looked = try store.insert(Candidate(path: "/photos/dog.png", kind: .image, size: 1, mtime: 1,
                                                inode: 2, device: 1, looksPictures: true))
        try store.addSegment(file: looked, kind: .ocr, modality: .text, text: "zorblat too")
        try store.finish(looked, state: "done")
        // A PDF a folder keeps only for its scans' text: an OCR result, not a document.
        let scan = try store.insert(Candidate(path: "/books/scan.pdf", kind: .pdf, size: 1, mtime: 1,
                                              inode: 3, device: 1, looksDocuments: false, ocrScans: true))
        try store.addSegment(file: scan, kind: .ocr, modality: .text, loc: 2, text: "zorblat on page two")
        try store.finish(scan, state: "done")
        let searcher = try Searcher(store: store, loadVectors: false)
        // Images is the look only; OCR is any text (the picture with both, and the scan); All files sees everything.
        #expect(try searcher.search("zorblat", queryVector: nil, section: .images).map(\.path) == ["/photos/dog.png"])
        #expect(try searcher.search("zorblat", queryVector: nil, section: .ocr).map(\.path).sorted()
                == ["/books/scan.pdf", "/photos/dog.png", "/shots/error.png"])
        #expect(try searcher.search("zorblat", queryVector: nil, section: .documents).isEmpty)
        #expect(try searcher.search("zorblat", queryVector: nil).map(\.path).sorted()
                == ["/books/scan.pdf", "/photos/dog.png", "/shots/error.png"])
    }

    @Test func aPageRenderedForItsFewWordsIsNoOCRResult() throws {
        let store = try IndexStore(directory: folder.appendingPathComponent("page-image-ocr"))
        // A book whose cover had little text: the reader rendered that page, and its words sit in the page image. The
        // folder never asked for its scans' text, so the book is a document and not an OCR result.
        let book = try store.insert(Candidate(path: "/books/book.pdf", kind: .pdf, size: 1, mtime: 1, inode: 1, device: 1))
        try store.addSegment(file: book, kind: .pageImage, modality: .image, loc: 1, text: "zorblat cover")
        try store.finish(book, state: "done")
        // The 0.1.16 betas kept a scan's reading in its page image: a folder that asked for the text is an OCR result.
        let beta = try store.insert(Candidate(path: "/books/scan.pdf", kind: .pdf, size: 1, mtime: 1, inode: 2, device: 1,
                                              ocrScans: true))
        try store.addSegment(file: beta, kind: .pageImage, modality: .image, loc: 3, text: "zorblat on the scan")
        try store.finish(beta, state: "done")
        let searcher = try Searcher(store: store, loadVectors: false)
        #expect(try searcher.search("zorblat", queryVector: nil, section: .ocr).map(\.path) == ["/books/scan.pdf"])
        #expect(try searcher.search("zorblat", queryVector: nil, section: .documents).map(\.path).sorted()
                == ["/books/book.pdf", "/books/scan.pdf"])
        #expect(try searcher.search("zorblat", queryVector: nil).map(\.path).sorted()
                == ["/books/book.pdf", "/books/scan.pdf"])
    }

    @Test func theRecognizedTextOfAFileIsItsOCRText() throws {
        let store = try IndexStore(directory: folder.appendingPathComponent("ocr-text"))
        let picture = try store.insert(Candidate(path: "/shots/error.png", kind: .screenshot, size: 1, mtime: 1,
                                                inode: 1, device: 1, ocrPictures: .all))
        try store.addSegment(file: picture, kind: .ocr, modality: .text, text: "the words on it")
        try store.finish(picture, state: "done")
        let plain = try store.insert(Candidate(path: "/photos/dog.png", kind: .image, size: 1, mtime: 1,
                                              inode: 2, device: 1))
        try store.finish(plain, state: "done")
        // A scan keeps one reading a page: the preview asks for the page it is on.
        let scan = try store.insert(Candidate(path: "/books/scan.pdf", kind: .pdf, size: 1, mtime: 1,
                                              inode: 3, device: 1, looksDocuments: false, ocrScans: true))
        try store.addSegment(file: scan, kind: .ocr, modality: .text, loc: 5, text: "page five")
        try store.finish(scan, state: "done")
        let searcher = try Searcher(store: store, loadVectors: false)
        #expect(try searcher.ocrText(ofFile: "/shots/error.png") == "the words on it")
        #expect(try searcher.ocrText(ofFile: "/photos/dog.png") == nil)
        #expect(try searcher.ocrText(ofFile: "/books/scan.pdf", part: 5) == "page five")
        #expect(try searcher.ocrText(ofFile: "/books/scan.pdf", part: 6) == nil)
    }

    @Test func bengaliAndArabicWordsStayWhole() throws {
        let store = try IndexStore(directory: folder)
        let id = try store.insert(Candidate(path: "/notes/trip.txt", kind: .doc, size: 1, mtime: 1, inode: 1, device: 1))
        try store.addSegment(file: id, kind: .chunk, modality: .text, loc: 1,
                             text: "সুন্দরবনে আমরা কুমিরও দেখেছি। قَالَ إِنَّ الْمَكْتَبَةَ تُغْلَقُ")
        let searcher = try Searcher(store: store, loadVectors: false)
        let bengali = try searcher.search("কুমির", queryVector: nil)
        #expect(bengali.map(\.path) == ["/notes/trip.txt"])
        #expect(bengali.first?.excerpt?.contains("«কুমিরও»") == true)   // the whole word, never a piece of it
        #expect(try searcher.search("المكتبة", queryVector: nil).map(\.path) == ["/notes/trip.txt"])
        #expect(try searcher.search("কলকাতা", queryVector: nil).isEmpty)
    }

    @Test func aWordInNoFileIsFoundAtTheStartOfLongerOnes() throws {
        let store = try IndexStore(directory: folder)
        func add(_ path: String, _ text: String, kind: FileKind = .doc, segment: SegmentKind = .chunk) throws {
            let id = try store.insert(Candidate(path: path, kind: kind, size: 1, mtime: 1, inode: UInt64(path.count),
                                                device: 1))
            try store.addSegment(file: id, kind: segment, modality: .text, loc: 1, text: text)
        }
        try add("/shots/settings.png", "Model picker: Grok4 (default)", kind: .screenshot, segment: .ocr)
        try add("/notes/wiki.txt", "Read the Grokipedia page about rivers.")
        try add("/notes/pets.txt", "The cat sleeps on the sofa.")
        try add("/notes/tags.txt", "Pick a category for each photo.")
        let searcher = try Searcher(store: store, loadVectors: false)
        // "grok" is in no file as a word. While it's typed (the last word as a prefix) and once typing stops, it finds
        // the same files.
        let typing = try searcher.search("grok", queryVector: nil, prefixLast: true)
        let stopped = try searcher.search("grok", queryVector: nil)
        #expect(Set(stopped.map(\.path)) == ["/shots/settings.png", "/notes/wiki.txt"])
        #expect(Set(typing.map(\.path)) == Set(stopped.map(\.path)))
        #expect(stopped.first { $0.path == "/shots/settings.png" }?.excerpt?.contains("«Grok4»") == true)
        // Another word with it: both count.
        #expect(try searcher.search("grok rivers", queryVector: nil).map(\.path) == ["/notes/wiki.txt", "/shots/settings.png"])
        // A word that's in a file as typed stays whole: "cat" isn't "category". So do two letters.
        #expect(try searcher.search("cat", queryVector: nil).map(\.path) == ["/notes/pets.txt"])
        #expect(try searcher.search("gr", queryVector: nil).isEmpty)
    }

    @Test func quotesSplitAQueryIntoPhrasesAndLooseWords() {
        let straight = SearchText.quoted("\"greenhouse hush\" notes")
        #expect(straight.phrases == [["greenhouse", "hush"]])
        #expect(Searcher.terms(straight.loose) == ["notes"])
        // Typographic quotes are what a phone or a word processor inserts; an apostrophe is not a quote.
        let typographic = SearchText.quoted("“greenhouse hush” another")
        #expect(typographic.phrases == [["greenhouse", "hush"]])
        #expect(Searcher.terms(typographic.loose) == ["another"])
        #expect(SearchText.quoted("it's").phrases.isEmpty)
        // Still typing: an unclosed span is loose words, not a phrase that can't match yet.
        let typing = SearchText.quoted("\"still typ")
        #expect(typing.phrases.isEmpty)
        #expect(Searcher.terms(typing.loose) == ["still", "typ"])
        // Stopwords and single letters stay in a phrase: adjacency, not a list of words.
        #expect(SearchText.quoted("\"the a b\"").phrases == [["the", "a", "b"]])
        // The meaning vector reads the words, not the syntax.
        #expect(SearchText.withoutQuotes("\"greenhouse hush\"") == "greenhouse hush")
        #expect(Prompts.query("\"greenhouse hush\"").hasSuffix("query: greenhouse hush"))
    }

    @Test func aQueryWithoutQuotesIsNotAPhrase() {
        // Every character of what's typed stays in the loose text, so a search without quotes matches and ranks as it
        // always has; only a quote mark changes anything.
        #expect(SearchText.quoted("greenhouse hush notes").loose == "greenhouse hush notes")
        #expect(SearchText.quoted("greenhouse hush notes").phrases.isEmpty)
    }

    @Test func aQuotedQueryFindsOnlyConsecutiveWordsInOrder() throws {
        let store = try IndexStore(directory: folder)
        func add(_ path: String, _ text: String, kind: FileKind = .doc, segment: SegmentKind = .chunk) throws {
            let id = try store.insert(Candidate(path: path, kind: kind, size: 1, mtime: 1, inode: UInt64(path.count),
                                                device: 1))
            try store.addSegment(file: id, kind: segment, modality: .text, loc: 1, text: text)
        }
        try add("/notes/adjacent.txt", "A greenhouse hush around the gaze.")
        try add("/notes/apart.txt", "Greenhouse notes.\n\nSome lines between.\n\nHush later.")
        try add("/notes/folded.txt", "THE GREENHOUSE,\nHUSH — and a résumé.")
        try add("/notes/other.txt", "Greenhouse plans and a hush fund.")
        try add("/shots/scan.png", "greenhouse hush", kind: .screenshot, segment: .ocr)
        let searcher = try Searcher(store: store, loadVectors: false)

        // In that order and adjacent; punctuation, a line break, case and accents are not gaps. A file with the same
        // two words apart, and one with them swapped, are not matches.
        let phrase = try searcher.search("\"greenhouse hush\"", queryVector: nil)
        #expect(Set(phrase.map(\.path)) == ["/notes/adjacent.txt", "/notes/folded.txt", "/shots/scan.png"])
        #expect(try searcher.search("\"hush greenhouse\"", queryVector: nil).isEmpty)
        #expect(try searcher.search("\"greenhouse meadow\"", queryVector: nil).isEmpty)
        // The words outside the quotes search as they do today: every file with either word.
        #expect(Set(try searcher.search("greenhouse hush", queryVector: nil).map(\.path))
                == ["/notes/adjacent.txt", "/notes/apart.txt", "/notes/folded.txt", "/notes/other.txt",
                    "/shots/scan.png"])
        // A phrase and a loose word: both must be there.
        #expect(try searcher.search("\"greenhouse hush\" gaze", queryVector: nil).map(\.path) == ["/notes/adjacent.txt"])
        // Several spans: all of them.
        #expect(try searcher.search("\"greenhouse hush\" \"around the gaze\"", queryVector: nil).map(\.path)
                == ["/notes/adjacent.txt"])
        // The OCR section is a words search, so it gets phrases with no extra code.
        #expect(try searcher.search("\"greenhouse hush\"", queryVector: nil, section: .ocr).map(\.path)
                == ["/shots/scan.png"])
        // The excerpt points at the phrase.
        #expect(phrase.first { $0.path == "/notes/folded.txt" }?.excerpt?.contains("HUSH") == true)
    }

    @Test func garbledPageTextIsNoticed() {
        // As PDFKit reads Bengali and Arabic pages made by Quartz/WebKit (testbed/make_lang.swift).
        let glyphOrder = "বািড় ভাড়ার চিপ ধানমি ৭ নর রােডর িতন বডরেমর াট মািসক ২৫,০০০ টাকা ভাড়ায় দওয়া হেলা। ভাড়ায়া দুই মােসর"
        let bengali = "বাড়ি ভাড়ার চুক্তিপত্র। ধানমন্ডি ৭ নম্বর রোডের তিন বেডরুমের ফ্ল্যাটটি মাসিক ২৫,০০০ টাকা ভাড়ায় দেওয়া হলো।"
        let lost = "ارتفعت ا.بيعات بنسبة خمسة عشر با.ئة في الربع الثالث. زرنا مدينة البتراء ا?ثرية في جنوب ا?ردن."
        let arabic = "ارتفعت المبيعات بنسبة خمسة عشر بالمئة في الربع الثالث. زرنا مدينة البتراء الأثرية في جنوب الأردن."
        #expect(PageTextProblem.check(glyphOrder) == .glyphOrder)
        #expect(PageTextProblem.check(bengali) == nil)
        #expect(PageTextProblem.check(lost) == .lostLetters)
        #expect(PageTextProblem.check(arabic) == nil)
        #expect(PageTextProblem.check("Revenue grew 20%. See p.4?No. Done.") == nil)
    }

    @Test func schemaOneMigratesToTheCurrentSchema() throws {
        // An index as schema 1 made it: SQLite's default tokenizer, text as extracted, screenshots' OCR with a vector,
        // its vectors named by the llama.cpp build.
        let built = "google/embeddinggemma-2@bfcd298 llama.cpp-b11461-metal text-q8_0+mmproj-q8_0"
        let db = try Database(path: folder.appendingPathComponent("index.sqlite").path)
        try db.execute("""
            CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
                size INTEGER NOT NULL, mtime REAL NOT NULL, inode INTEGER NOT NULL, device INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending', detail TEXT, info TEXT, indexed_at REAL);
            CREATE TABLE segments(id INTEGER PRIMARY KEY, file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                kind TEXT NOT NULL, modality TEXT NOT NULL, loc REAL, loc_end REAL, excerpt TEXT, vec BLOB);
            CREATE VIRTUAL TABLE fts USING fts5(name, body, tokenize = 'porter unicode61 remove_diacritics 2');
            INSERT INTO files VALUES(1, '/d/notes.txt', 'doc', 1, 1, 1, 1, 'done', NULL, NULL, 1);
            INSERT INTO segments VALUES(1, 1, 'chunk', 'text', 1, NULL, NULL, NULL);
            INSERT INTO fts(rowid, name, body) VALUES(1, '', 'قَالَ إِنَّ الْمَكْتَبَةَ تُغْلَقُ');
            INSERT INTO files VALUES(2, '/d/rent.pdf', 'pdf', 1, 1, 2, 1, 'done', NULL, NULL, 1);
            INSERT INTO segments VALUES(2, 2, 'page', 'text', 1, NULL, NULL, NULL);
            INSERT INTO fts(rowid, name, body) VALUES(2, '', 'বািড় ভাড়ার চিপ ধানমি ৭ নর রােডর িতন বডরেমর াট মািসক ২৫,০০০ টাকা ভাড়ায় দওয়া হেলা।');
            INSERT INTO files VALUES(3, '/d/shot.png', 'screenshot', 1, 1, 3, 1, 'done', NULL, NULL, 1);
            INSERT INTO segments VALUES(3, 3, 'ocr', 'text', NULL, NULL, 'Booking K7Q2LM', zeroblob(1536));
            INSERT INTO fts(rowid, name, body) VALUES(3, '', 'Booking K7Q2LM');
            INSERT INTO meta VALUES('fingerprint', '\(built) | photo140 shot280 page280 frame70/3.0s audio30.0/25.0s');
            INSERT INTO meta VALUES('vector_source', '\(built)');
            PRAGMA user_version = 1;
            """)
        let store = try IndexStore(directory: folder)
        var version: Int64 = 0
        try store.db.query("PRAGMA user_version") { version = $0.int(0) }
        #expect(version == IndexStore.schemaVersion)
        let searcher = try Searcher(store: store, loadVectors: false)
        #expect(try searcher.search("المكتبة", queryVector: nil).map(\.path) == ["/d/notes.txt"])
        #expect(try store.pending(limit: nil).map(\.path) == ["/d/rent.pdf"])   // to be read again, as a picture
        // Schema 3: the screenshot's words are for keyword search only.
        var vectors = -1
        try store.db.query("SELECT COUNT(vec) FROM segments WHERE kind = 'ocr'") { vectors = Int($0.int(0)) }
        #expect(vectors == 0)
        #expect(try searcher.search("K7Q2LM", queryVector: nil).map(\.path) == ["/d/shot.png"])
        // Schema 4: the vectors are named by their version, not by the llama.cpp build that made them.
        let named = "google/embeddinggemma-2@bfcd298 llama.cpp-vectors1 text-q8_0+mmproj-q8_0"
        #expect(try store.meta("vector_source") == named)
        #expect(try store.meta("fingerprint")?.hasPrefix(named + " | ") == true)
        // Schema 5 (long files finished later, `LongFilesTests`) leaves short ones as they were.
        #expect(try store.unfinishedCount() == (0, 0))
    }

    @Test func landmarkFindsThePageInPreview() {
        let pages = ["Quarterly business review\nRevenue grew in Japan and Europe.",
                     "Hiking trip to Mount Fuji\nWe took the Yoshida trail from the fifth station in Japan."]
        // A word that's on that page, preferring one that isn't on an earlier page…
        #expect(Landmark.find(page: 2, texts: pages, words: ["japan", "Yoshida"]) == "Yoshida")
        // …else any that is.
        #expect(Landmark.find(page: 2, texts: pages, words: ["japan", "bread"]) == "Japan")
        #expect(Landmark.find(page: 2, texts: pages, words: ["bread"]) == nil)
        #expect(Landmark.find(page: 1, texts: pages, words: ["japan"]) == nil)   // opens there anyway
        // Spelled as the page spells it; a word a garbled text layer lost isn't offered.
        let arabic = ["التقرير الربعي", "رحلة إلى البتراء\nزرنا مدينة البتراء الأثرية في جنوب الأردن"]
        #expect(Landmark.find(page: 2, texts: arabic, words: ["الاردن"]) == "الأردن")
        let garbled = ["التقرير الربعي", "زرنا مدينة البتراء ا?ثرية في جنوب ا?ردن"]
        #expect(Landmark.find(page: 2, texts: garbled, words: ["الاردن"]) == nil)
    }

    @Test func matchesAreFoundAsKeywordSearchFindsThemButShownAsWritten() {
        let arabic = "زرنا مدينة البتراء الأثرية في جنوب الأردن."
        let found = SearchText.matches(of: "الاردن", in: arabic).map { String(arabic[$0]) }
        #expect(found == ["الأردن"])                                     // the hamza is kept: it's how it's written
        let voweled = "إِنَّ الْمَكْتَبَةَ تُغْلَقُ"
        #expect(SearchText.matches(of: "المكتبة", in: voweled).map { String(voweled[$0]) } == ["الْمَكْتَبَةَ"])
        let bengali = "একটি বড় কুমিরের ছবি"
        #expect(SearchText.matches(of: "কুমির", in: bengali).map { String(bengali[$0]) } == ["কুমিরের"])   // never "কুমি"
        let english = "Sunday trip: day two"
        #expect(SearchText.matches(of: "day", in: english).map { String(english[$0]) } == ["day"])   // not in "Sunday"
        let turkish = String(repeating: "İ", count: 60) + " son kelime"
        #expect(SearchText.matches(of: "kelime", in: turkish).map { String(turkish[$0]) } == ["kelime"])
    }

    @Test func snippetsQuoteTheTextAsWritten() {
        let text = "قَالَ مُحَمَّدٌ إِنَّ الْمَكْتَبَةَ الْعَامَّةَ تُغْلَقُ فِي السَّاعَةِ الثَّامِنَةِ مَسَاءً يَوْمَ الْخَمِيسِ"
        let snippet = SearchText.snippet(text, terms: ["المكتبة"])
        #expect(snippet?.contains("«الْمَكْتَبَةَ»") == true)
        #expect(SearchText.snippet(text, terms: ["كلمة"]) == nil)
    }

    @Test func realArabicAbbreviationsAreNotLostLetters() {
        #expect(PageTextProblem.check("أ.د.محمد علي، أستاذ في الجامعة. د.خالد و د.سارة من شركة ذ.م.م للتجارة") == nil)
        let bullets = String(repeating: "\u{F0B7} Item one of the slide\n", count: 6)
        #expect(PageTextProblem.check(bullets) == nil)
    }
}
