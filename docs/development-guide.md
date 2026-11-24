# DigUp Plus: руководство разработчика (Windows-форк)

**Дата:** 2026-11-04

**Статус:** актуально для ветки `main` (форк `Sucotasch/DigUpPlus`, upstream `ARahim3/DigUp`; чистый снимок
upstream лежит в `upstream-main`).

**Зачем этот файл:** чтобы человек или агент, открывший репозиторий без контекста, мог собрать, протестировать и
упаковать проект на этой машине, не выясняя заново пути, флаги и причины прошлых решений. Здесь только то, что
не очевидно из кода и `CONTRIBUTING.md`.

Сначала прочитайте `CONTRIBUTING.md` (правила для upstream) и `README.md` («Build from source»). Этот файл — про
конкретную Windows-машину и про fork-specific работу.

## 1. Что это за репозиторий

DigUp Plus — локальный семантический поиск по своим файлам. Движок — Swift (`Sources/DigUpKit`), приложение — Tauri
(`shell/`, Rust + обычные HTML/CSS/JS без сборки). Модель — EmbeddingGemma 2 Q8_0 на llama.cpp, всё считается на
машине, сети нет (кроме одноразовой загрузки модели).

macOS-приложение (`Sources/DigUpApp`) в дереве осталось как эталон поведения, но в форке **не собирается**: в
`Package.swift` для него нет ни продукта, ни зависимости на Sparkle, `build.sh` и `scripts/release.sh` удалены.
Форк ориентирован на эту Windows-машину; portable-сборка — основной формат, установщик остался как запасной.

Этот checkout — **Windows-форк**. `origin` = `https://github.com/Sucotasch/DigUpPlus.git`,
`upstream` = `https://github.com/ARahim3/DigUp.git`. В форке живут:

- пагинация выдачи в главном окне и слои Images (см. `docs/search-results-pagination-plan.md`);
- файловые операции в главном окне: Move To / Copy To / Delete, и результаты списком в панели Total Commander
  (см. `docs/file-operations-plan.md`);
- настройки папки индекса и модели, установщик Windows.

`upstream` не пушить. Автообновлений в форке нет: модуль `updates.rs`, плагин updater и настройка «Check for
updates automatically» удалены, релизы выпускаются вручную. Вместо проверки обновлений Settings → General
показывает версию и кнопку Download, которая открывает страницу релизов форка (`open_releases`).

## 2. Раскладка

| Путь | Что внутри |
|---|---|
| `Sources/DigUpKit` | Движок: `Crawler`, экстракторы, `IndexStore`/`Database` (SQLite + FTS5), `Searcher`, `Indexer`, протокол `Worker`. Без UI. |
| `Sources/DigUpKit/Platform/Apple` | macOS: ImageIO, PDFKit, AVFoundation, Vision, Metal. |
| `Sources/DigUpKit/Platform/Portable` | Windows/Linux: PDFium, stb, miniz, SQLite, ffmpeg из `Vendor/`. |
| `Sources/LlamaRuntime` | Биндинг llama.cpp и инференс EmbeddingGemma. |
| `Sources/digup` | CLI разработчика **и** helper-процессы приложения: `index-service`, `search-service`, `worker`, `download-model`, `estimate`, `search`, `status`, `speed`, `eval`, `mcp`, `repick`, `forget`, `phash`. |
| `Sources/DigUpApp` | macOS-приложение (эталон поведения). В форке не собирается ни на одной платформе. |
| `shell/src-tauri` | Rust-оболочка: трей, хоткей, окна, файловые операции, статус. |
| `shell/ui` | Окна оболочки: `panel.*`, `window.*`, `settings.*`, `setup.*`. Чистые HTML/CSS/JS, без фреймворка и сборки. |
| `Tests/DigUpKitTests`, `Tests/LlamaRuntimeTests` | Swift Testing (`@Suite`/`@Test`/`#expect`). |
| `evals/*.json` | Наборы запросов с известными ответами для `digup eval`. |
| `scripts/` | Сборка llama.cpp/ffmpeg, vendor, упаковка, dev-run, testbed. |
| `Vendor/` | Генерируется `scripts/fetch-vendor.sh`, в git не хранится. |
| `.build/`, `.dev/` | Локальные артефакты, индексы, модели и одноразовые стенды. В git не хранятся. |

`AGENTS.md` и `knowledge.md` в корне — локальные заметки для агентов; они в `.gitignore`, в коммит не попадают.
Этот файл — их публичный, коммитируемый аналог.

## 3. Окружение этой машины

| Что | Где / версия |
|---|---|
| ОС | Windows 10, i7-5820K (6/12), RTX 4070 Ti SUPER 16 ГБ, CUDA 13.1 |
| Репозиторий | `D:\Arx\Software Downloads\_Images_EDIT-pack\DigUp` (в пути есть пробелы — всегда в кавычках) |
| Git Bash | `D:\Works\Git\bin\bash.exe` |
| Swift | 6.4, `C:\Users\sucot\AppData\Local\Programs\Swift\Toolchains\6.4.0+Asserts\usr\bin\swift.exe`; runtime DLL — `...\Runtimes\6.4.0\usr\bin` |
| Visual Studio | 2022 Community; `vcvars64.bat` в `...\VC\Auxiliary\Build\`; MSVC tools 14.44; CRT redist `...\VC\Redist\MSVC\14.44.35112\x64\Microsoft.VC143.CRT` |
| Rust | `C:\Users\sucot\.cargo\bin`; shell линкует C runtime статически (`shell/src-tauri/.cargo/config.toml`) |
| Node | `C:\Program Files\nodejs`; npm CLI — `C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js` |
| Python | `python` (3.x). `python3` — заглушка Microsoft Store, не работает |
| Модель | `.dev/models`: `embeddinggemma-2-Q8_0.gguf` (310 МБ) + `mmproj-...` (555 МБ) |
| Живой индекс | `.build/asian-index` — 3 772 изображения, на нём проверялись пагинация и слои |
| Chrome for Testing 137 | `C:/Users/sucot/.ext-dev-loop/browsers/cft-137/chrome-win64/chrome.exe` (вне репозитория) |

Главное:

- **Голый `bash` на этой машине — это WSL** (`C:\Windows\System32\bash.exe`), а не Git Bash. Он выберет
  Linux-бинарники из `Vendor/` и неверные пути. Все shell-скрипты запускайте через
  `D:\Works\Git\bin\bash.exe` (или из Git Bash).
- `.build/` — свалка локальных стендов и логов; она не коммитится. Скрипты оттуда (`package-ui.sh`,
  `build-ui-installer.cmd`, CDP-стенды) существуют только на этой машине; их рецепты продублированы ниже,
  чтобы не потерять.
- `Vendor/` и `shell/src-tauri/helper/` тоже не коммитятся: первое собирается `scripts/fetch-vendor.sh`,
  второе — упаковкой.

## 4. Swift: сборка, тесты, CLI

### Сборка

```sh
swift build --product digup                 # из PowerShell тоже работает
python .build/swift_with_vc.py build -c release   # тонкая обёртка: добавляет DLL-папки SwiftPM/Runtime, печатает EXIT
```

- Бинарник: `.build/out/Products/Release-windows-x86_64/digup.exe` (путь надёжнее, чем `.build/release`).
- SwiftPM 6.4 не может создать symlink `.build\release` на Windows (I/O error 512). Это **безвредно**, сборка
  продолжается. Не «чините» это.

### Тесты

```sh
python .build/swift_test.py                        # всё
python .build/swift_test.py --filter SearchPagination
python .build/swift_test.py --filter "DigUpKitTests"
```

Почему не `swift test` напрямую: без окружения он собирает, а потом рапортует все таргеты как failed без вывода.
`swift_test.py` добавляет:

- окружение `vcvars64.bat`;
- DLL-папки Swift Testing/XCTest;
- `Vendor/pdfium/bin`, `Vendor/llama/lib`, `Vendor/ffmpeg/bin`, CUDA 13.1;
- debug CRT из Visual Studio;
- `DIGUP_BACKENDS=Vendor/llama/lib`.

Известный локальный сбой: `IndexStoreTests.modelFilesComeFromTheHuggingFaceCacheWhenThere` падает с Win32 1314 —
тест создаёт symlink, а Developer Mode выключен. Это ограничение среды, не регрессия; тест не менять. Полный
прогон (2026-11-04) — 138 из 139, единственный сбой этот.

`SearchPaginationTests` полностью офлайновые: строят временный индекс в тесте, модель не нужна, идут ~1,5 с.
Флаг `--filter` принимает имя сюиты или теста. Быстрая проверка одной сюиты краулера:
`python .build/swift_test.py --filter CrawlerTests`.

### CLI на живом индексе

```sh
DIGUP_MODELS="$PWD/.dev/models" DIGUP_BACKENDS="$PWD/Vendor/llama/lib" \
PATH="C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v13.1/bin/x64:$PATH" \
.build/out/Products/Release-windows-x86_64/digup.exe search "asian" \
  --index .build/asian-index -n 120 --json
```

`--zgate 0` снимает смысловой порог (удобно для замеров пагинации). `DIGUP_MODELS` нужен для эмбеддинга запроса;
без модели CLI работает в keyword-режиме. `digup --help` — остальные команды.

## 5. Shell (Tauri): сборка, тесты, живой запуск

```sh
cd shell/src-tauri
cargo test --locked      # 79 тестов
cargo build --locked
```

Если cargo в Git Bash берёт не тот линкер (`/usr/bin/link.exe` затмевает MSVC), задайте:

```sh
export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER="C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/link.exe"
export PATH="$(dirname "$CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER"):$PATH"
```

**UI вкомпилируется в бинарник.** После любой правки `shell/ui/*` нужен `cargo build` или полная упаковка,
иначе окно останется старым. Проверка синтаксиса:

```sh
for f in shell/ui/*.js; do node --check "$f" || echo "FAIL $f"; done
```

Живой запуск с черновыми индексом/настройками, чтобы не трогать реальные данные:

```powershell
$bin = swift build --show-bin-path
shell\src-tauri\target\debug\digup-shell.exe --helper "$bin\digup.exe" `
  --index .build\dev\index --roots "<папка>" --settings .build\dev\settings.json `
  --models .dev\models
```

- `--debug-window "" --debug-show` — открыть большое окно; `--debug-window "" --debug-settings --debug-show` —
  окно и Settings (Settings открывается кнопкой окна, поэтому одно `--debug-settings` без окна его не показывает);
- `--debug-window "<запрос>" --debug-quit` — напечатать отчёт страницы и выйти;
- `--debug-query "<запрос>" --debug-quit` — то же для панели;
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` перед запуском — управлять окном по CDP
  (`http://127.0.0.1:9222/json` перечисляет страницы: `/`, `/window.html`, `/settings.html`).

`python .build/run_digup.py <аргументы>` запускает собранный `digup.exe` с теми же DLL-путями, что и
`swift_test.py` (без них процесс не стартует, код `0xC0000135`); файл, как и `swift_test.py`, локальный и
неотслеживаемый.

Перед повторным запуском закройте предыдущий экземпляр: окно/трей/индекс-сервис могут держать файлы.

## 6. Сборка для Windows

### Portable — то, что форк выпускает (`scripts/package-portable.sh`)

```sh
scripts/package-portable.sh        # → shell/src-tauri/target/release/DigUpPlus.exe
```

Скрипт собирает helper-папку так же, как установщик, затем `npx @tauri-apps/cli@2.12.2 build --no-bundle` и кладёт
результат в `shell/src-tauri/target/release` — единственное место сборки: `DigUpPlus.exe` рядом с `helper/`,
`THIRD-PARTY-NOTICES.txt` и `portable.txt` (старые имена exe убираются). Ничего не устанавливается: папку можно
скопировать куда угодно и запустить. Благодаря `portable.txt`
оболочка держит настройки, логи, индекс, модель и профиль WebView2 в папке `data` рядом с exe (см. §5), а не в
`%APPDATA%`/`%LOCALAPPDATA%`; `--data <папка>` или `DIGUP_DATA` указывают другое место. Без `portable.txt` (установщик)
всё по-прежнему в `%APPDATA%\com.sucotasch.digupplus` и `%LOCALAPPDATA%\DigUpPlus`.

**В этой папке должен остаться один exe.** Любая `cargo build --release` (и `tauri build`) кладёт туда же
`digup-shell.exe`, `digup_shell.pdb` и `digup-shell.d` — рядом с `DigUpPlus.exe`; скрипт пакета их удаляет, ручная
сборка сюда — нет. Собирать в `target/release` руками нельзя, и после такой сборки эти три файла надо убрать: иначе в
папке два exe, и легко запустить устаревший. Живые проверки (гейты G26, G30) запускают уже собранные
`DigUpPlus.exe` и `helper\digup.exe` и ничего не собирают.

Скрипт печатает SHA-256 helper'а (`HELPER SHA256: …`): если в новом релизе helper побитово тот же, можно выложить
только `DigUpPlus.exe` и `portable.txt` (и `THIRD-PARTY-NOTICES.txt`), без 400 МБ helper'а. `SHELL_ONLY=1
scripts/package-portable.sh` дополнительно собирает `-shell-only.zip` из этих трёх файлов.

Из Git Bash `link.exe` из `D:\Works\Git\usr\bin` перебивает MSVC, и Tauri-сборка падает на `extra operand … .rcgu.o`
(§5). Поэтому портативную сборку на этой машине запускают обёрткой `.build/package-portable-local.cmd`: она входит в
`vcvars64.bat`, называет `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER` и ставит MSVC первым в `PATH` перед вызовом
скрипта. Прямой запуск `scripts/package-portable.sh` без этого — тот же сбой.

### Установщик (остался от upstream, `scripts/package-windows.sh`)

`scripts/package-windows.sh` — полная упаковка. Требования (заголовок скрипта): Git Bash внутри Visual Studio
developer environment, `scripts/fetch-vendor.sh`, `scripts/build-llama.sh`, `scripts/build-ffmpeg.sh` (последний —
в MSYS2 MINGW64), Swift, Rust, Python, Node.

Внутри: `swift build -c release --product digup` → сбор helper-папки (`digup.exe`, DLL llama.cpp, PDFium, CUDA
runtime, Swift runtime, C++ CRT, ffmpeg/ffprobe, Windows OCR shim `ocr.exe` из `scripts/build-ocr.sh`) →
`scripts/notices.py` → `npx @tauri-apps/cli@2.12.2 build --bundles nsis` с `helper/` и
`THIRD-PARTY-NOTICES.txt` как resources.

Выход: `shell/src-tauri/target/release/bundle/nsis/DigUp Plus_<version>_x64-setup.exe` (~440 МБ).
Версия берётся из `shell/src-tauri/tauri.conf.json` (сейчас `0.1.18`), не из `Cargo.toml` (там `0.1.0` у пакета
оболочки, но имя файла и настройки идут от `tauri.conf.json`). Подписи и update-артефактов больше нет: `signing` из
скрипта убран вместе с плагином updater.

### Быстрый путь: изменился только UI

Когда Swift-helper уже собран и менялись только `shell/ui/*`, полный `swift build` не нужен. На этой машине для
этого есть локальные обёртки (в git их нет):

- `.build/package-ui.sh` — берёт готовый `.build/out/Products/Release-windows-x86_64/digup.exe`, собирает
  helper-папку, генерирует notices и запускает Tauri CLI. Версии Swift/CRT/CUDA захардкожены — обновляйте при
  обновлении Visual Studio.
- `.build/build-ui-installer.cmd` — вызывает `vcvars64.bat`, выставляет MSVC-линкер и PATH (Swift, cargo, node,
  Git Bash) и запускает `package-ui.sh`.
- `.build/package-local.sh` + `.build/build-installer.cmd` — то же самое, но с полной сборкой helper'а
  (копия `scripts/package-windows.sh` с путями этой машины).

Запуск из корня репозитория:

```sh
MSYS_NO_PATHCONV=1 cmd.exe /c ".build\\build-ui-installer.cmd"
```

`MSYS_NO_PATHCONV=1` обязателен, иначе Git Bash превратит `/c` в путь. Команда идёт ~20–25 минут (cargo release +
NSIS; сам NSIS — последние ~4 минуты). Успех виден по `PACKAGE_EXIT 0` и свежему установщику.

Проверка результата:

```sh
ls -la shell/src-tauri/target/release/digup-shell.exe dist/
md5sum shell/src-tauri/target/release/bundle/nsis/*_x64-setup.exe dist/*.zip   # если сравниваете сборки
```

### Грабли упаковки

| Симптом | Причина / решение |
|---|---|
| `link.exe` не тот, странные ошибки линковки | Git Bash подсунул `/usr/bin/link.exe`; задайте `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER` и PATH (см. §5) |
| `npx: command not found` | В окружении vcvars нет npm-шима; вызывайте `node "C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js" --yes @tauri-apps/cli@2.12.2` |
| `python3` открывает Store / падает | `python3` — заглушка; скрипты уже падают обратно на `python`, но не вызывайте `python3` вручную |
| Скрипт требует CUDA | `ggml-cuda.dll` нужен CUDA runtime; без него helper молча уйдёт на CPU. Задайте `CUDA_PATH` |
| В `bundle/nsis` старый установщик другой версии | Скрипты сами делают `rm -rf` папки; если запускаете Tauri CLI вручную — удалите её |
| Установщик собрался, но UI старый | Страницы вкомпилированы; нужен `cargo build`/Tauri build после правки `shell/ui` |
| `package-ui.sh` взял старый helper | Он не собирает Swift; сначала `swift build -c release --product digup` или полный `package-windows.sh` |
| Подпись/обновления | Ни подписи, ни автообновления: релизы вручную, zip заменяет папку |

## 7. Проверка UI без установки

Окно можно прогнать headless на настоящих `window.html/css/js` с замоканным Tauri-мостом. Стенд этого форка:

```sh
node .build/make-tier-harness.cjs     # собирает .build/tier-bench/bench.html из shell/ui + calibration-hits.json
node .build/run-tier-cdp.cjs          # обычные пороги
TIER_LOW=1 node .build/run-tier-cdp.cjs   # защита: вся шкала cosine ниже обычных порогов
```

Что делает `run-tier-cdp.cjs`: запускает Chrome for Testing 137 headless с `--remote-debugging-port`, через CDP
кликает чип Images, листает visible/weaker до конца, раскрывает hidden и печатает JSON. Это проверяет реальный
код окна, а не копию.

Ожидаемый результат на текущем `calibration-hits.json` (регрессионный снимок, не продуктовые константы):

```json
{"first":{"ranked":120,"total":3014,"hiddenTotal":758,"chip":"894","cutoffs":{"visible":0.648,"weak":0.6}},
 "loaded":{"ranked":894,"weaker":2120,"cells":3014,"falling":true},
 "hidden":{"hidden":758,"falling":true,"aboveWeak":true},"errors":[]}
```

`TIER_LOW=1` должен дать сдвинутые пороги (`0.4779/0.4299`), `ranked=1330`, `hidden=81`, `errors:[]`. Если числа
разошлись — сначала проверьте, не менялся ли `calibration-hits.json`, потом код.

Ограничения стенда: mock-helper, нет реального paint/декодирования миниатюр, нет WebView2. Живую проверку делайте
через dev-запуск (§5) или установленный установщик; для пагинации в живом окне использовались запросы `korean` и
`chinese` на `.build/asian-index`.

Старые стенды пагинации: `.build/make-pagination-harness.cjs` + `.build/run-pagination-cdp.cjs`
(порт 9876, переменная `PAGINATION_QUERY`), живая проверка — `.build/live-pagination-check.cjs` и
`.build/check-live-pagination.cjs`. Они локальные и не коммитятся; при потере ориентируйтесь на этот раздел и
`docs/search-results-pagination-plan.md` §11.

## 8. Как устроен поиск (минимум, который надо помнить)

Поток: выбранные папки → crawl/diff → экстракторы (изображения, текст, аудио) → модель в helper-процессе →
один SQLite-индекс (`index.sqlite`; code-поиск — отдельный `code.sqlite`) → запрос эмбеддится и смешивается с
FTS5 → страница результатов. Каждый сегмент несёт `loc`/`locEnd`, поэтому хит открывается на странице PDF, минуте
аудио или строке кода.

Главное окно (`shell/ui/window.js`) грузит **120** результатов, затем по **300**; догрузка инкрементальная, без
полной перерисовки. Панель остаётся на 40, macOS — на 120.

Протокол `search-service` (одна JSON-строка на запрос/ответ):

| Поле | Смысл |
|---|---|
| `offset`, `limit` | страница в полном рейтинге |
| `total` | файлов во всём рейтинге после смысловых гейтов и `kinds` (до проверки существования файлов) |
| `strong_total` | из них сильных: score ≥ 0.5 от глобального лучшего (в слоях Images — `visible`) |
| `strong` | сильных **в этой странице** (для старого UI) |
| `consumed` | сколько кандидатов покрыла страница до фильтрации |
| `next_offset` | `offset + consumed`; клиент двигает offset по нему, а не по `hits.length` |
| `generation` | растёт при `reload()`; страницы другой генерации отбрасываются |
| `kind_counts` / `kind_totals` | сильные / все результаты по каждому виду во всём рейтинге (чипы окна) |
| `tier_counts` | `{visible, weak, hidden}` по всему рейтингу изображений (только для слоёв Images) |

Правила, которые легко нарушить:

- `next_offset` считается по `consumed`: helper отфильтровывает несуществующие пути и исключённые типы **после**
  нарезки страницы. Если двигать offset по числу хитов, появятся пропуски.
- `strong` страницы считается по **глобальному** `topScore`, иначе вторая страница объявит сильными свои слабые
  результаты.
- Смена `generation` или `meaning` между страницами — это другой рейтинг: окно перезапускает поиск, а не смешивает
  страницы.
- `total` — верхняя оценка: исчезнувшие файлы вычитаются по мере догрузки/сверки индекса. `kind_totals` тоже
  считаются по индексу, не по `stat`.

### Слои Images (текущая fork-логика)

Фильтр Images показывает изображения не одной кучей, а тремя слоями по **cosine лучшего сегмента** (абсолютная
величина, не зависящий от запроса z-score):

- `visible` — cosine ≥ 0.648: показываются сразу;
- `weak` — 0.600 ≤ cosine < 0.648: свёрнуты как weaker matches;
- `hidden` — cosine < 0.600: отдельная свёрнутая секция, грузится своим запросом (`by_cosine`, `cosine_ceiling`).

Пороговые значения получены на живом индексе (3 772 изображения, запросы Asian/Anime): 0.648 — начало «не совсем
того», 0.600 — конец единичных нерелевантных. Если у запроса вся шкала ниже (visible < 30 изображений), окно
опускает оба порога под собственный топ: `visible = top - 0.05`, `weak = visible - (visible профиля - weak профиля)`
(для Standard это прежние 0.048). Это защита от пустого первого экрана; профили — Settings → Search, константы
менять только с новым замером.

Запрос слоёв: `by_cosine: true`, `cosine_floor: weak`, `tier_cutoffs: [visible, weak]`. Скрытый хвост:
`cosine_ceiling: weak`. Файлы, попавшие по словам и не имеющие вектора (`keyword_rank != null`), показываются
сразу, независимо от cosine. Движок при `by_cosine` сортирует по cosine (совпадения по словам — сверху), а
`tier_counts` считает по всему `best`, включая хвост ниже floor.

Чипы видов берут числа из `kind_totals`; для Images чип показывает `visible`, то есть «сколько видно сразу», а не
весь рейтинг.

### Code-поиск

Opt-in, отдельный индекс, префикс `code:` (CLI: `--code`). При пагинации ранг для выбора «где определение» должен
оставаться глобальным (`start + hits.count`), иначе на второй странице перестанет работать правило «искать
определение только в первых 10». Материализация code-хита дороже, живой замер больших страниц ещё не сделан.

## 9. Состояние ветки и что дальше

Ветка, называвшаяся `file-operations` (сегодня это `main`; сама ветка удалена 2026-11-19, её вершина — предок `main`,
все теги достижимы из `main`), база — upstream/main `d6f1f48`. Перед коммитом 2026-10-27 origin был на
`ceeb001 Load search results a page at a time`; рабочее дерево содержало незакоммиченные слои Images, counts и
починку кэша превью — они вошли в коммит вместе с этим руководством.

Проверки (даты по пунктам):

- 2026-11-04: `python .build/swift_test.py` — 152 теста, 151 прошли (единственный сбой — symlink-тест 1314 выше);
- 2026-11-04: `cargo test --locked` в `shell/src-tauri` — 66 тестов, все прошли;
- `node --check` по всем `shell/ui/*.js` — чисто;
- пер-корневые правила (типы, top-level-only), пороги поиска и записи по тегам проверены на живой сборке:
  `docs/per-folder-rules-plan.md` §1.8, «Фаза 2», «Фаза 3»;
- версия в `tauri.conf.json` — `0.1.15` (0.1.6 выпущен 2026-11-04; 0.1.7–0.1.9 выпущены 2026-11-05 одним тегом
  `v0.1.9`: аудио по правилам папки, Rescan/Re-read, надёжность инкремента, MCP; 0.1.10 выпущен 2026-11-12:
  жизненный цикл папки (Re-pick, пустая папка), пакет из upstream и исправление выделения; 0.1.11 выпущен
  2026-11-12: результаты окна открываются списком в панели Total Commander; helper не менялся, поэтому к полному
  zip приложен `-shell-only.zip`; 0.1.13 выпущен 2026-11-13: группы похожих по облику в Find similar (с клавишей
  `G`/`Shift+G`), подсказка картинки при наведении, WIC-декод JPEG (досчёт отпечатков 8.3 → 6.4 мс на картинку) и
  исправление порванных превью; helper изменился, поэтому нужен полный zip; 0.1.14 выпущен 2026-11-15: группы в
  табличном виде, вторая галочка «look-alikes in every search», «Groups only», выделение группы целиком
  (трёхшаговая галочка представителя, Alt+click снимает группу), подпись и колесо-альбом в подсказке при наведении,
  клик больше не ставит галочку, правая кнопка не меняет выделение, исправлены Shift+стрелки и Shift+клик по
  чекбоксу; helper изменился (версия MCP), нужен полный zip; 0.1.15 выпущен 2026-11-16: книги — FB2 в UTF-8 и
  Windows-1251, EPUB, zip как одна книга, CHM через `hh.exe`, старый DOC своим читателем (OLE + piece table), DJVU
  через DjVuLibre при его наличии; RTF читается в своей кодовой странице; подсказка и `Space` листают страницы PDF
  и фрагменты книг; документы участвуют в выделении и файловых операциях (включая Total Commander); строка
  группировки осталась только там, где есть картинки; кэш превью ограничен 512 файлами; helper изменился, нужен
  полный zip);
- 0.1.16 выпущен 2026-11-17: текст на картинках и сканах — Windows OCR (`Windows.Media.Ocr`) в отдельном
  `ocr.exe` рядом с helper: движок языка профиля и английский, оба чтения идут в keyword-поиск; в правиле папки
  (и подпапки) — `Images` (индексировать вид) и `OCR` (читать текст любых картинок): любой из двух включает картинки
  в правило, `Images` снят + `OCR` включён = только слова, без вектора, и результаты в разделе **OCR**; у документов
  та же пара — `Documents` и `OCR Documents` (текст сканов PDF), `Documents` снят + `OCR Documents` включён = только
  текст сканов, PDF хранится текстовым (`as_document = 0`), обычные документы не читаются; оба OCR по умолчанию
  выключены; раздел **Screenshots** заменён на **OCR** (картинки + сканы, поиск по словам); схема индекса 10 (`looks`,
  `ocr_pictures`, `ocr_scans`, `as_document`), смена бита перечитывает только затронутые файлы, а не всю папку; в
  правилах папки — её непосредственные подпапки: галочка «читать / не читать» и `Rules…` с тем же редактором (виды,
  глубина, аудио, пропуск типов, OCR), на уровень за раз; исключённая подпапка остаётся в списке и хранит правило, а
  выключение «Scan its subfolders» сохраняет и правила, и выбор; поля правила общие для Settings и окна Choose Folders
  (`shell/ui/rules.js`), и его сохранение больше не теряет правила подпапок и OCR; shim собирается
  `scripts/build-ocr.sh`; в 0.1.16 также: точные фразы в кавычках (слова подряд и в том же порядке, несколько
  кавычек — все обязательны, вектор без кавычек; `SearchText.quoted`); распознанный текст в превью (в OCR открыт, в
  Images — строкой, выделение и Copy all); одно ранжирование на клик фильтра и `section_totals` — числа на плашках;
  протокол helper 2; энкодер держится тёплым 15 минут (`--encoder-idle 900`), строка «Preparing the model…»; проверка
  скорости не запускается, когда замер уже есть, и строка «Checking this computer's speed…» — только при реальном
  замере; остаток длинных книг читается только в простое (`--rest-when-idle 300`, пауза 2× шага после каждого);
  helper изменился, нужен полный zip;
- 0.1.17 выпущен 2026-11-19: закрыты подтверждённые находки стороннего аудита (Gemini + проверка Claude, оба сверены с
  кодом): счётчики `scanned_pages`/`ocr_chars` в PDF пишутся числами, а не текстом `(0 + N)`; картинка, удалённая или
  перемещённая во время OCR, не роняет транзакцию своего пакета (проверка `current` в `pictureText`); веб-вью больше не
  может слать `file_op` в обход `file_operation`; перенос индекса подвешивает поисковый helper (`SearchService::suspend`),
  чтобы запрос, проскочивший флаг, не открыл старый индекс; Re-pick/Forget в Settings больше не блокируют главный поток
  (async + `spawn_blocking` под `index_move`), а Re-pick откатывает индекс, если настройки не сохранились; шаги уже
  завершённого длинного файла не читаются впустую; Drop-guard для `RUNNING` и защита worker'а от пустого батча. Не
  меняли (проверено): длинные пути (`std::fs` сам добавляет `\\?\`), `Names::taken`'s `path.exists()`, ожидание рендеров
  при выходе, регистр в `vanished`/`emptyRoots` (строки с другим регистром не попадают в `files(under:)` — инвариант
  записан комментарием и тестом); helper изменился, нужен полный zip;
- 0.1.18 выпущен 2026-11-19: долгий старт после обновления разобран по замерам. Ничего не переиндексировалось (mtime
  базы и worker-логов не менялись): диск читали модель и векторы, а `prewarm` держал под своим локом всю очередь
  запросов, поэтому окно стояло пустым, пока грузились 240 МБ векторов (на холодном HDD — минуты). Теперь `prewarm`
  отвечает сразу: модель и векторы грузятся в фоне (`startEncoderInBackground`, `startLoadingVectors` — своё соединение
  с тем же индексом), поиск в это время отвечает словами с `"warming":true`, а события `encoder`/`vectors` со
  `state:"ready"` заставляют окно и панель повторить запрос сами — с защитой от гонки «событие пришло раньше ответа»
  (`state.ready`). Время загрузки пишется в `search.log` (`prewarm: …`). Замеры, отменившие первый план: частичный
  covering-индекс `segments(id, file, modality, kind, loc, vec) WHERE vec IS NOT NULL` оказался **медленнее** табличного
  скана (1.66–1.73 с против 0.90–1.05 с на копии реального индекса) и добавил 556 МБ — не делаем; снятие JOIN с `files`
  и `json_extract` дало 10 % (0.90 против 1.00 с) и тоже не оправдывает правку. Попутно найдено: `MCPServer.version`
  остался `0.1.16` после выпуска 0.1.17 — агенты видели старую версию; поднят до 0.1.18 (тест
  `theServerVersionIsTheAppsVersion` теперь ловит это в прогоне). helper изменился, нужен полный zip;
- 0.1.19 выпущен 2026-11-19: движок llama.cpp поднят `b11461` → `b12540`; собственный патч `no-logits` удалён —
  upstream #30445/#30461 делает то же (и #30522 чинит их регрессию). Reference-векторы прошли (тест не пропущен),
  индекс не переиндексируется; на нашем CUDA это **не** бит-в-бит: косинус ≥ 0.99962, top-5 поиска сохраняется,
  хвост top-20 сдвигается на ~0.02 z. helper изменился, полный zip;
- 0.1.20 выпущен 2026-11-19: кадр из видео наконец можно **сохранить и скопировать**. Меню результата —
  `Save Frame at 0:12:34…` (момент совпадения) и `Copy Frame`; в боковой панели и Space-просмотре — `Save frame`
  для **текущего** кадра после перемотки. Helper отдаёт кадр в нативном размере (`full`) и его байты inline
  (`data`: asset-URL не `fetch`-ится из-за origin, а canvas из него tainted); `save_frame` — диалог, имя
  `<видео> — ЧЧ-ММ-СС.jpg`, папка рядом с видео, последняя выбранная запоминается. Замеры и границы —
  `docs/frame-extraction-plan.md`. helper изменился, полный zip;
- 0.1.21 выпущен 2026-11-19: в правой панели предпросмотра у видео `Save frame` видна **до** ▶ (сохраняет момент
  совпадения), после ▶ — текущий кадр; в 0.1.20 она была только после ▶ и в flex-строке уезжала за видео (теперь
  видео и кнопка в колонке). Только оболочка, helper тот же (`857f1917…`) — shell-only zip;
- 0.1.22 собран 2026-11-25, ждёт проверки перед публикацией: **видео смотрится наведением** — по правилам Imagus
  (`docs/media-tools-plan.md` §1): 300 мс простоя, окно углом к курсору и растёт в свободную сторону, не больше
  исходника (уменьшается до площади, не растягивается), скрытие — `pointerover` вне окна и карточки, без таймеров;
  так окно больше не висит на сетке, забитой видео. Контролы нативные, как в боковой панели (автоскрытие, иконки,
  колесо только громкость); поверх — только `Pin`, `Save frame`, `×`, всегда видимые. Старт `loc − 2`, muted 25 % с
  запоминанием через нативный `volumechange`, loop < 60 с, один декодер, `prefers-reduced-motion` без автозапуска,
  неиграемый кодек — кадр helper'а и строка почему. Гейт 24/24 настоящими движениями мыши по сетке из 12 видео
  (мгновенное скрытие при уходе, жизнь над окном, pin, ×, громкость, старт, loop, fallback). Плюс
  **`Extract frames…`/`Contact sheet…`** у видео: до 120 кадров каждую секунду или равномерно по клипу, нативный
  размер или 1280 px, в `<видео> — frames/0001.jpg…` и `<видео> — sheet.jpg` рядом с видео; занятое имя → `(2)`,
  ничего не перезаписывается; helper пишет в скрытую временную папку, shell переименовывает (без копирования); op —
  своей очередью, не в `ASK_OPS`. `tile` в вендоренном ffmpeg нет — сетка через `hstack`/`vstack`. Гейт 12/12.
  Панель по хоткею: `shadow(false)` убрал прямоугольную рамку Windows вокруг скруглённой панели (снимок до/после).
  helper изменился (op и версия): полный zip, HELPER SHA256
  `9609c29b85bc928432362630e9add7e195d11b4689e46a635c68355179000a74`; zip `DigUpPlus-0.1.22-windows-x64.zip`
  480 780 279 байт, SHA-256 `3848d665e2fc498e080095bc77cc94ca7291c7a9830472897ec73bf91364ed5c`;
- на 2026-11-25: `python .build/swift_test.py` — 234 теста, 233 прошли (тот же symlink-тест), `cargo test --locked`
  — 82, все прошли;
- на 2026-11-19: `python .build/swift_test.py` — 231 тест, 230 прошли (тот же symlink-тест), `cargo test --locked`
  — 82, все прошли;
- GitHub Actions в форке выключены, workflow-ов три: `ci.yml`, `packages.yml`, `homebrew.yml`
  (`gh workflow list -R Sucotasch/DigUpPlus --all` → `disabled_manually`); `website.yml` в нашей ветке нет. Default
  branch — `main` (до 2026-11-19 проект жил в `file-operations`, та же история; чистый upstream — в `upstream-main`,
  кнопку **Sync fork** у форка не нажимать); сборки только вручную (`scripts/package-portable.sh`).

Проверено на 2026-10-27 (снимок того дня, числа в нём исторические):

- `python .build/swift_test.py --filter SearchPagination` — 6 тестов, все прошли (включая
  `imageLayersAreCutOnCosineAndPageInOrder` и `kindCountsCoverTheWholeRankingNotJustThePage`);
- `node --check` по всем `shell/ui/*.js` — чисто;
- headless-стенд слоёв: обычные и `TIER_LOW=1` пороги, без ошибок (числа выше);
- `cargo test` в `shell/src-tauri` — 55 тестов, все прошли после удаления updater'а.
- GitHub Actions в форке выключены (`gh workflow disable ci.yml packages.yml homebrew.yml website.yml`), default
  branch — `file-operations`; сборки только вручную (`scripts/package-portable.sh`).

Не проверено / открытые задачи:

- живой WebView2 после сборки слоёв: paint, декодирование миниатюр, поведение скрытого хвоста на больших индексах;
- code-пагинация на большом репозитории;
- индекс ≥ 50 тыс. файлов: полное сканирование и стоимость страницы (при >100 мс рассмотреть кэш рейтинга в
  helper'е);
- macOS и быстрая панель по-прежнему на 120/40; перенос пагинации на macOS — отдельный PR;
- таблица дороже сетки; виртуализация для десятков тысяч строк — отдельный этап.

## 10. Грабли, на которые уже наступали

- **`Package.resolved`** больше нет: после удаления macOS-приложения и Sparkle внешних зависимостей в пакете не
  осталось, SwiftPM сам удаляет файл. Возвращать его из истории не нужно.
- **Превью helper'а**: при старте helper удаляет `<index>/previews`, поэтому закэшированные пути в UI мертвы.
  `results.js` слушает событие `helper` (`search`/`ready`), очищает `renders` и повторяет запрос один раз со
  свежим `<img>`; после второй неудачи показывает иконку типа. Не убирайте ретрай.
- **Fingerprint индекса**: векторы помечены моделью, ревизией, runtime и dtype. Смена модели/настроек требует
  `--reindex`; смешивание источников — жёсткая ошибка.
- **Размерность векторов — 768.** MRL 512d/256d измерен на нашем индексе (12 запросов, копия реального индекса) и
  отклонён: 512d меняет ~1.2 из топ-5 картинок на другие (не look-alike), 256d — ~2 из 5, и оба ломают калибровку
  слоёв Images. Мотивы, цифры и условия возврата — `docs/vector-dimensions-plan.md`; менять размерность только с
  `vectorVersion`/fingerprint и полным реиндексом.
- **Кадр из видео и asset-URL.** Страница не может `fetch`-ить `convertFileSrc(path)` (другой origin), а canvas,
  нарисованный из такой картинки, tainted — `toBlob` бросает `SecurityError`. Поэтому `render` с `"data":true`
  отдаёт байты JPEG inline (base64) для Copy Frame (PNG в буфер), а `"full":true` — кадр в размере файла
  (`pixels: 0`, без scale) для Save Frame. Не пытайтесь снова через fetch/canvas: см.
  `docs/frame-extraction-plan.md`, `.build/frame-live2.mjs`.
- **`Vendor/`**: SHA-256 пины в `scripts/vendor-checksums.json`; версию и хэши менять одним коммитом, хэш не
  брать из самого скачанного файла.
- **llama.cpp**: пин — `b12540` (коммит `95b09b62`), `scripts/build-llama.sh`; собственный патч `llama.cpp-no-logits.patch`
  удалён — с #30445/#30461 upstream сам пропускает LM head у pooled-эмбеддингов. Обновление должно пройти
  `Tests/LlamaRuntimeTests/ReferenceVectorTests`; перегенерация эталона инвалидирует все индексы. На нашем CUDA
  b12540 даёт не бит-в-бит, а косинус ≥ 0.99962 к b11461 (порог теста — 0.999), top-5 поиска на реальном индексе
  сохраняется, хвост top-20 сдвигается на ~0.02 z; индекс не переиндексируется.
- **Приватность**: никакой телеметрии и сетевых вызовов, кроме загрузки модели и открытия страницы релизов по кнопке.
- **Windows-тесты**: symlink-тест 1314 — среда, не код.
- **Пути с пробелами**: кавычки в скриптах обязательны; `MSYS_NO_PATHCONV=1` для `cmd.exe /c`.
- **Имя сборки**: файлы называются по `productName`/`version` из `tauri.conf.json` (`DigUp Plus_<version>_…`).


## 11. Карта документации

| Файл | О чём |
|---|---|
| `README.md` | продукт, установка, «Build from source» |
| `CONTRIBUTING.md` | правила upstream, PR, отчёты о багах |
| `docs/search-results-pagination-plan.md` | пагинация: замеры, протокол, слои Images, как воспроизвести |
| `docs/file-operations-plan.md` | Move/Copy/Delete в окне Windows (по-русски, источник истины) |
| `docs/roadmap-plan.md` | бэклог форка: P0–P3, что уже внедрено, порядок релизов |
| `docs/per-folder-rules-plan.md` | пер-корневые правила индексации: типы, top-level-only, пороги, теги |
| `docs/kensaku-ideas-plan.md` | что берём из kensaku: MCP для агентов, надёжность инкремента, frecency, внешние экстракторы |
| `docs/lookalike-groups-plan.md` | группы похожих по облику в Find similar: pHash-256, порог, свёртка, Expand all, ключ `G` |
| `docs/hover-peek-plan.md` | подсказка картинки при наведении: задержка, размер, что отложено |
| `docs/wic-decode-plan.md` | WIC-декод JPEG на Windows: замеры, шов, баг с выравниванием строк |
| `docs/image-embedding-performance.md` | замеры скорости эмбеддинга, пул процессов |
| `docs/model-profiles-plan.md` | хранение модели, папка, удаление, профили |
| `AGENTS.md`, `knowledge.md` | локальные заметки агентов (не коммитятся) |
