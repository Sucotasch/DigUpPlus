// DigUp's Windows OCR: prints the words on a picture, one reading per engine.
//
// Windows.Media.Ocr reads one language per engine and mangles the other (a Russian screenshot read by en-US loses its
// letters, and Latin code read by ru loses its digits and punctuation), so the helper runs the user profile's engine and
// English, and stores both readings for keyword search. Readings are separated by a U+001E line, which recognized text
// never holds; the Swift side splits on it and drops empty readings.
//
// Built by scripts/package-portable.sh with the C++/WinRT headers that come with the Windows SDK, beside the helper as
// ocr.exe. Arguments: the image's path. Exit 0 when it was read (even with no words), 1 when it couldn't be opened.
#include <windows.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Storage.Streams.h>
#include <iostream>
#include <string>
#include <vector>

using namespace winrt;
using namespace Windows::Globalization;
using namespace Windows::Graphics::Imaging;
using namespace Windows::Media::Ocr;
using namespace Windows::Storage;

static std::string utf8(std::wstring_view text) {
    if (text.empty()) return {};
    int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size, nullptr, nullptr);
    return out;
}

int wmain(int argc, wchar_t** argv) {
    init_apartment();
    if (argc < 2) return 1;

    SoftwareBitmap bitmap{nullptr};
    try {
        // Foundation hands a Windows path with forward slashes ("D:/Pictures/a.png"); WinRT wants backslashes.
        std::wstring path(argv[1]);
        for (auto& character : path) {
            if (character == L'/') character = L'\\';
        }
        auto file = StorageFile::GetFileFromPathAsync(path).get();
        auto stream = file.OpenAsync(FileAccessMode::Read).get();
        auto decoder = BitmapDecoder::CreateAsync(stream).get();
        bitmap = decoder.GetSoftwareBitmapAsync().get();
    } catch (winrt::hresult_error const& error) {
        std::cerr << "ocr: " << utf8(argv[1]) << ": " << utf8(error.message()) << "\n";
        return 1;
    }

    // The profile's language first, then English when that isn't it.
    std::vector<OcrEngine> engines;
    winrt::hstring profile_tag;
    if (auto profile = OcrEngine::TryCreateFromUserProfileLanguages()) {
        engines.push_back(profile);
        profile_tag = profile.RecognizerLanguage().LanguageTag();
    }
    if (std::wstring_view(profile_tag).substr(0, 2) != L"en") {
        if (auto english = OcrEngine::TryCreateFromLanguage(Language(L"en-US"))) {
            engines.push_back(english);
        }
    }

    bool first = true;
    for (auto const& engine : engines) {
        std::string text;
        try {
            text = utf8(engine.RecognizeAsync(bitmap).get().Text());
        } catch (winrt::hresult_error const&) {
            continue;
        }
        if (!first) std::cout << '\x1E' << '\n';
        std::cout << text;
        first = false;
    }
    return 0;
}
