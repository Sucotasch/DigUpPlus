#!/usr/bin/env bash
# Builds the Windows OCR shim (Sources/OcrShim/ocr.cpp) into the helper folder as ocr.exe. The Swift engine spawns it
# for text on pictures and PDF scans; Windows.Media.Ocr and its C++/WinRT headers come with the Windows SDK, so nothing
# is fetched. Run it inside a Visual Studio developer environment, as the packaging scripts that call it are.
# The options use "-", not "/": MSYS would read "/nologo" as a path of its own.
set -euo pipefail
cd "$(dirname "$0")/.."
helper=${1:?usage: build-ocr.sh <helper folder>}
mkdir -p .build/ocr-shim
sdk=$(cygpath -u "${WindowsSdkDir:-C:/Program Files (x86)/Windows Kits/10}")
winrt=$(ls -d "$sdk"/Include/*/cppwinrt 2>/dev/null | sort -V | tail -1)
[[ -n "$winrt" ]] || { echo "no C++/WinRT headers under $sdk: run this in a Visual Studio developer environment" >&2; exit 1; }
cl -nologo -std:c++17 -EHsc -O2 "-I$(cygpath -w "$winrt")" "-Fo$(cygpath -w "$PWD/.build/ocr-shim/ocr.obj")" \
   "-Fe$(cygpath -w "$PWD/$helper/ocr.exe")" "$(cygpath -w "$PWD/Sources/OcrShim/ocr.cpp")" -link WindowsApp.lib
