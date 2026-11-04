# Per-folder indexing rules: top-level-only and kind filters

**Дата:** 2026-11-04 (ревизия 3 — фаза 1 внедрена и проверена на живой сборке). **Статус:** фаза 1 сделана,
фазы 2–3 — план на следующие релизы (`0.1.7`+), фаза 4 отложена. Предшественники: `docs/roadmap-plan.md`
(контекст), `docs/file-operations-plan.md` (образец стиля).

**Что изменилось в ревизии 3:** добавлен дефект Д8 (`status.rs` терял `left_out` на первом проходе — причина не
доходила до Settings), в 1.1 записан `kindSkips` (счёт файла, который обходят два выбранных корня), в 1.2 —
что `--root-rule` требует полный объект (`root` и `shallow`), в конце — раздел «Внедрено и проверено» с числами и
командами проверки.

**Что изменилось в ревизии 2** (подробности — в «Найденные дефекты прежнего плана»): правило привязывается к
ближайшему *выбранному* корню для каждого пути, а не к входному корню обхода; `kinds` не применяются к
code-индексу; `leftOut` привязывается к выбранному корню, иначе Settings не покажет причину; правила едут только в
`index-service` и `estimate`, не в `search-service`; `estimate` сегодня игнорирует исключения — это баг, чинится в
фазе 1; watcher перестаёт рекурсивно следить за shallow-корнями; UI получает правила из `settings_info`, а удаление
папки чистит её правило. В фазах 2–3 исправлена проводка (пороги живут в `window.js`; теги — не `LIKE '%.mp3'`).

## Цель

Два пер-корневых правила индексации, живущих рядом в Settings → Folders:

1. **Типы на папку** — «в этой папке только изображения, в той только видео».
2. **Только верхний уровень** — «не ходить вглубь этой папки».

Почему в одном документе: оба — пер-корневые правила обхода, едут через одну проводку (Settings → шелл → аргументы
helper'а → Crawler), один тестовый набор и один релиз. Поиск отдельно не настраивается — он ищет по индексу;
правило применяется в краулере, и выдача следует за индексом (см. «Отвергнутые решения»).

## Проверено по коду (2026-11-04)

Ниже — состояние кода **до** правок ревизии 3 (номера строк оттуда же); что стало после — в 1.1 и 1.8.

- `Crawler.crawl` (`Crawler.swift:46`) обходит входные корни по одному (`:68`), а **выбранные** корни держит отдельно
  (`chosen`, `:61`) и передаёт их из синка (`Indexer.swift:127`). Контекст входа — ближайший выбранный предок
  (`:71-72`), а не сам вход. Входы и выбранные корни — не одно и то же: при частичном синке входы — это изменённые
  папки (`Indexer.swift:101-126`), при вложенных выбранных корнях — ещё и они.
- `foundRoot[url.path] = root.path` (`Crawler.swift:169-170`) запоминает **входной** корень и отбрасывает повторные
  находки; при обходе внешнего корня файл вложенного выбранного корня получает владельца-внешний корень.
  `leftOut` внутри `visit` тоже пишется под `root.path` (`:125, :136, :143-165, :205, :221`), а Settings ищет
  причину по пути **выбранной** папки (`shell/ui/settings.js:220`).
- `DirectoryWalk.skipDescendants()` (`Platform/Portable/Files+Portable.swift:196`: `opened = nil`) — готовая точка
  остановки: после обработки каталога ход не входит в него. У macOS-ветки (`FileManager.enumerator`) та же
  семантика.
- `Rules.classify` возвращает `.index(kind)` / `.skip(reason)` / `.ignore` (`Rules.swift:3-7`); `kind` известен до
  `FileSystem.info` (`Crawler.swift:139-147`) — стат обречённого файла не нужен.
- Синк сам удаляет выпавшие строки (`Indexer.swift:169-173`), поэтому смена правила — **resync, не reindex**.
  `fingerprint` (`Model.swift:80-85`) — явный список бюджетов, правило туда не попадает.
- `IndexService` при старте всегда делает полный синк (`syncRequested = true`), а оболочка перезапускает helper,
  если аргументы изменились (`shell/src-tauri/src/helper.rs:255, :316`). Значит `save → apply_folders → run_index`
  сам сходится к новому правилу в любую сторону (и сужение, и снятие правила).
- Code-индекс получает `args.options` и включает `code = true` (`Sources/digup/main.swift:482-483`): правила,
  попавшие в общие `IndexOptions`, применились бы и к нему.
- `folder_arguments()` (`main.rs:326`) едет и в `index_launch` (`:268`), и в `search_launch` (`:229`), и в
  стартовый `search-service` (`:934`); `estimate` (`:451-461`) собирает аргументы сам и **не** передаёт ни
  `--exclude`, ни `--exclude-ext`, ни `include_datasets`-независимые правила.
- `estimate` идёт через тот же `Crawler.crawl` (`Sources/digup/main.swift:279`) — правила и исключения,
  доехавшие до `estimate`, дают сходный с фактом прогноз.
- Watcher следит рекурсивно (`watcher.rs:57`) и фильтрует события по `Rules.isWalked`-подобному `walked`
  (`:96-110`); типы фильтруются одним глобальным списком (`:29, :43-44`).
- UI: строки папок рисует `folderRow()` (`settings.js:208`), причины — `reasonLines()` (`:189`), образец
  «поменял settings → save → apply_folders» — `set_skipped` (`main.rs:2537`), вопросы «в строке» —
  `confirmRemoval()` (`settings.js:259`) поверх `.confirm` (`settings.css:52-55`).
- `FolderSelection.folders` (`FolderSelection.swift:47`) выбрасывает вложенный выбранный корень, если внешний
  ищется целиком; это macOS-эталон, оболочка передаёт `settings.folders` как есть, а `Crawler` берёт `chosen`
  напрямую. Вложенные корни в форке живут (setup кладёт и родителя, и выбранную подпапку).

## Найденные дефекты прежнего плана

### Д1. Правило цеплялось к входному корню обхода, а не к владельцу файла

Прежний текст: «правило текущего корня» + `chosen.filter(...).max(by: count)` на входе, shallow — сравнением
`url.path == rootPath`. Это верно только когда входы совпадают с выбранными корнями. В форке это не так:

- частичный синк обходит изменённые папки (`Indexer.swift:101-126`), и `root.path` — подпапка, а не корень;
- при вложенных выбранных корнях внешний обход первым доходит до файлов внутреннего (`foundRoot` отбрасывает
  повторные находки, `Crawler.swift:169`), и файл получил бы правило внешнего корня;
- shallow-проверка «папка == входной корень» во время частичного синка не пускала бы вообще ничего (вход — не
  корень), а во время полного — пускала бы подпапки вложенного корня, если внешний корень shallow.

**Решение:** владелец пути = ближайший **выбранный** корень (`chosen`), кэш по каталогам:

```swift
var owners: [String: String] = [:]          // каталог → владелец ("" = нет)
func owner(of path: String) -> String? {
    let found: String
    if let known = owners[path] { found = known } else {
        found = chosen.filter { $0 == path || FolderSelection.isInside(path, $0) }
            .max(by: { $0.count < $1.count }) ?? ""
        owners[path] = found
    }
    return found.isEmpty ? nil : found
}
```

Сравнение — через `FolderSelection.isInside` (на Windows без регистра), как везде в краулере. Кэш заполняется на
каталог, а не на файл (файл спрашивает владельца своего каталога): `O(выбранных корней)` на новый каталог, не на
файл.

### Д2. `kinds` протёк бы в code-индекс

`codeOptions = args.options` + `code = true` (`main.swift:482-483`). Правило «только изображения» на папке
опустошило бы code-индекс целиком. **Решение:** правила применяются только при `!options.code` (это уже ветка
классификации, `Crawler.swift:139`). UI правил — только у обычных папок.

### Д3. `leftOut` попадал не в ту папку

Причины писались под входным корнем. При частичном синке это подпапка, которой в Settings нет, — строка «not read»
не появлялась. **Решение:** `leftOut` и `foundRoot` пишут владельца (`owner(of:) ?? root.path`). Для случая
«вход = выбранный корень» поведение не меняется.

### Д4. Правила в `search-service` — лишний риск

`folder_arguments` — общая для индекса и поиска. Кривое правило сломало бы и поиск, который ничего не краулит.
**Решение:** отдельная `rule_arguments(settings)` только для `index_launch` и `estimate`.

### Д5. `estimate` уже сейчас врёт (не только про правила)

`estimate` (`main.rs:451-461`) не передаёт `--exclude`, `--exclude-ext` и `--include-datasets`; прогноз в setup
расходится с фактом, если человек что-то исключил. Это баг, найденный при проверке плана, и он мешает критерию
«estimate сходится с фактом». **Решение:** `estimate` получает `--exclude`/`--exclude-ext` из settings и
`--root-rule` для присланных папок; `--include-datasets` уже передаётся.

### Д6. Watcher остался бы рекурсивным

Shallow-корень с глубоким деревом (сборочный каталог, архив) слал бы синк на каждое изменение в глубине, который
краулер тут же отбрасывает. **Решение:** `FolderWatcher::start` получает список shallow-корней и следит за ними
`RecursiveMode::NonRecursive`; вложенные выбранные корни и так в `folders` и получают свой рекурсивный watch.
Типы: событие файла, который правило папки не индексирует, всё равно попросит синк — осознанный shortcut (фильтр
потребовал бы дублировать таблицы расширений движка в Rust); цена ограничена одной папкой, а не всем индексом.

### Д7. UI и уборка правил

Прежний план писал «профиль в settings.js читает `info.profile` из `main.rs:1216`» — такой строки нет, пороги
живут в `window.js:14-17`. Для фазы 1: правила обязаны приехать в `settings_info`, кнопка — в `folderRow`,
редактор — в строке (как `confirmRemoval`), а `remove_folder` обязан удалить правило папки. Заодно `remove_folder`
(`main.rs:2409`) чистит `skipped` через `Path::starts_with` — на Windows это сравнение с регистром, поэтому
`c:\one\photos\sub` переживает удаление `C:\One\Photos`. **Решение:** общий `inside(path, folder)` без регистра и
уборка `root_rules` в `remove_folder` и `apply_setup_folders`.

### Д8. `left_out` терялся, когда синк ставил в очередь новые файлы

`Status::apply` (`status.rs:58-66`) разбирал событие `sync` ветками `match`: `"sync" if count("new") > 0` стояла
**до** ветки, записывающей `left_out`, поэтому на первом проходе (новых файлов всегда > 0) причины не доходили до
Settings, и строка «N not read» появлялась только после второго синка. Нашлось при живой проверке: helper присылал
`left_out`, а страница показывала `null`. **Решение:** `"sync"` — одна ветка: сначала `left_out` (если объект),
потом `Indexing`/`Idle`; поведение счётчиков не изменилось. Тест `a_sync_that_queues_files_still_records_what_it_left_out`.

## Отвергнутые решения (чтобы не переобсуждать)

- **Раздельные правила для индексации и поиска** — нет: поиск ищет по индексу; «фильтр поверх индексированных»
  делает числа на чипах зависимыми от невидимого фильтра (тот класс UX-обмана, который мы сняли с All-files).
- **Fingerprint при смене правил** — нет: правило не меняет векторы; reindex уничтожил бы индекс без причины.
  Resync сам сходится к новому правилу.
- **Отдельный crawl-проход на корень с пост-фильтрацией** — нет: обход по одному корню уже есть; пост-фильтр дал бы
  неверные `leftOut`-репорты («not read» вместо «of a kind this folder doesn't index»).
- **Правило на каждую подпапку (дерево правил)** — нет: правило живёт только на выбранных корнях; вложенный корень
  получает своё правило, потому что он сам выбран.
- **Плагины с пользовательским кодом** (фаза 4) — отложено: песочница, ABI, privacy-контракт; декларативные
  правила закрывают 90% спроса.

## Фаза 1 — kind-фильтры и top-level-only на корень (ядро)

**Решение.** Новая секция settings (camelCase, как весь файл):

```json
"rootRules": {
  "D:/Photos":  { "kinds": ["image", "screenshot"], "shallow": false },
  "D:/Records": { "kinds": ["audio"],               "shallow": true  }
}
```

- Нет записи, `kinds` пуст, `shallow: false` — папка индексируется как сейчас.
- `kinds` — точные виды `FileKind`: `screenshot`, `image`, `pdf`, `doc`, `audio`, `video`. В UI «Pictures»
  отправляет и `image`, и `screenshot` (иначе скриншоты выпадут из «только изображения»).
- Данные — на Settings, НЕ в `IndexOptions.fingerprint`.

### 1.1 Engine: правило на владельца пути

- `Sources/DigUpKit/Model.swift`: `RootRule { root: String; kinds: Set<FileKind>?; shallow: Bool }`
  (`Codable`, `Sendable`, `Equatable`) и `IndexOptions.rootRules: [RootRule] = []`.
- `Crawler.crawl`: собрать `rules: [String: RootRule]` (ключ — `FolderSelection.crawlPath(rule.root)`), **только
  если `!options.code`**; `owner(of:)` из Д1.
- `kinds`: в `case .index(let kind)` (`Crawler.swift:183`), до `FileSystem.info`:
  `let kinds = rule.kinds.flatMap { $0.isEmpty ? nil : $0 }`; если `kinds` заданы и `!kinds.contains(kind)` →
  `leftOut("of a kind this folder doesn't index", under: owner)` и `return`. Счёт — через `kindSkips: Set<String>`:
  файл вложенного выбранного корня обходят оба корня (внешний и внутренний), а причина должна быть одна (иначе в
  Settings «2 of a kind…» на один файл).
- `shallow`: проверяется **до** ветки каталогов, по папке-контейнеру записи
  (`isDirectory ? url.path : deletingLastPathComponent`): если владелец этой папки — shallow-корень и папка не сам
  корень, то `walker.skipDescendants()`, причина `beyond the top level` (+ `folders beyond the top level` в
  `skippedFolders` и `leftOut` для самой подпапки) и `return`. Так частичный синк, обходящий папку внутри shallow-
  корня, не читает ничего — правило не обходится через изменённую подпапку. Файлы верхнего уровня владельца
  обрабатываются как обычно; вложенный выбранный корень не режется, потому что его владелец — он сам.
- `foundRoot` и все `leftOut(under:)` в `visit` — владелец (`?? root.path`).
- Пост-проходы (code project, datasets) уже берут `foundRoot` — получают исправленную привязку бесплатно.
- Стоимость: один фильтр по `chosen` на новый каталог (кэш), ноль изменений для папок без правил.

### 1.2 CLI: разбор аргументов

- `--root-rule <json>` в `Arguments.repeated` (`main.swift:73`), декодирование в `init` (он уже `throws`):
  `{"root":"D:/Photos","kinds":["image"],"shallow":true}` → `[RootRule]`. Нечитаемый JSON или неизвестный вид —
  `CLIError` (шелл присылает только провалидированный JSON; ошибка означает баг, и молча индексировать «всё»
  нельзя). Объект обязан содержать `root` и `shallow` — синтезированный `Decodable` не подставляет значения по
  умолчанию; шелл всегда шлёт оба ключа, а ручной объект без `shallow` отвергается с внятной ошибкой (проверено).
- `options.rootRules = rootRules` рядом с `--include-datasets` (`main.swift:109-118`).

### 1.3 Shell: settings → helper

- `settings.rs`: `root_rules: BTreeMap<String, RootRule>` + `RootRule { kinds: Vec<String>, shallow: bool }`
  (оба с `#[serde(default)]`). `kinds` — строки, а не enum: неизвестное имя из будущей/правленой версии не должно
  ронять загрузку settings (иначе весь файл уедет в `.bad` и настройки обнулятся).
- `main.rs`: `const KINDS: [&str; 7]`; `rule_arguments(&Settings)` рендерит `--root-rule` только для непустых
  правил и выбрасывает неизвестные виды; пустой `kinds` в JSON не пишется (отсутствие = все виды).
- `index_launch` (`main.rs:268`) и `estimate` — `args.extend(rule_arguments(&settings))`; `search_launch` — нет.
- `estimate` дополнительно получает `--exclude` и `--exclude-ext` из settings (Д5).
- `set_root_rule(folder, kinds, shallow)` по образцу `set_skipped`: путь сверяется с `settings.folders` через
  `models::same_path`; ключ — написание из `settings.folders`; пустое правило удаляет запись; save → `apply_folders`.
- `remove_folder` и `apply_setup_folders` чистят `root_rules` (Д7), `remove_folder` — ещё и `skipped` без регистра.
- `settings_info`: `"rootRules": settings.root_rules`.

### 1.4 UI: Settings → Folders

- `folderRow()` (не code): в `side` перед Remove — кнопка «Rules», открывает редактор строкой ниже (как
  `confirmRemoval`): чекбоксы Pictures / PDFs / Documents / Recordings / Videos, чекбокс «Top level only», Save и
  Cancel. Всё отмечено = правила нет (пусто); «Pictures» = `image` + `screenshot`.
- `reasonLines()` — две строки-перевода: «of a kind this folder doesn't index», «folders beyond the top level».
- Правило читается из `info.rootRules` поиском по `samePath` (пути могут отличаться регистром).

### 1.5 Watcher: shallow без рекурсии

- `FolderWatcher::start(..., shallow: &[PathBuf], ...)`: `RecursiveMode::NonRecursive` для shallow-корней,
  `Recursive` для остальных. Code-watcher передаёт пустой список.
- В шапке `watcher.rs` — строка про shortcut: событие неиндексируемого типа в папке с `kinds` всё равно просит
  синк; апгрейд — когда на больших библиотеках это станет заметно.

### 1.6 Тесты

Swift (новая сюита `RootRulesTests` рядом с `CrawlerTests`):

1. `kinds` режет вид и пишет причину в `leftOut` под выбранным корнем.
2. `shallow` индексирует файлы корня и не индексирует подпапки; причина «folders beyond the top level».
3. Пустое правило = байт-в-байт как без правил (регресс).
4. Вложенные корни: `A` kinds=[image], `A/B` kinds=[video] → `A/x.jpg` и `A/B/y.mp4` в индексе, `A/B/z.jpg` нет.
   Это тест на Д1 (обход `A` первым).
5. Частичный синк (`sync(roots, changedPaths:)`) с shallow-корнем: изменение верхнего файла индексируется,
   изменение в подпапке — нет.
6. Сходимость: индекс с правилом «все виды» → сузили до image → синк удаляет лишние строки, `summary.removed`
   совпадает; сняли правило → они вернулись (`summary.added`).

Rust (cargo):

7. `rule_arguments`: одно `--root-rule` на правило, пустое правило пропущено, неизвестный вид выброшен, JSON
   разбирается `serde_json`.
8. Round-trip settings с `rootRules` и загрузка файла без секции (старые настройки); неизвестный вид остаётся в
   файле (иначе настройки целиком уехали бы в `.bad`).
9. `inside()` (без регистра) — на удалении папки убирает и её саму, и вложенные пути.
10. `Status::apply`: `sync` с новыми файлами и `left_out` записывает и то, и другое (Д8).

### 1.7 Критерии приёмки

1. Папка A с kinds=["image","screenshot"]: видео внутри не индексируется, в leftOut видна причина, чипы не врут.
2. Папка B shallow: файлы верхнего уровня в индексе, подпапки — нет.
3. Снятие правила → resync возвращает полноту: пере-эмбеддинг только вернувшихся файлов.
4. Watcher: новый файл в A не того вида не появляется в выдаче; того вида — появляется; глубина shallow-корня не
   вызывает синков.
5. `estimate` с правилами сходится с фактом первой проходки (±10%) и учитывает `skipped`/`skipTypes`.
6. Правило не влияет на code-индекс.
7. `python .build/swift_test.py` — 144/145 (тот же symlink-сбой), `cargo test --locked` — 62 зелёных,
   `node --check shell/ui/*.js` — чисто, `digup eval evals/*.json` без регрессий на настройках по умолчанию.

### 1.8 Внедрено и проверено (2026-11-04)

Изменённые файлы:

| Файл | Что |
|---|---|
| `Sources/DigUpKit/Model.swift` | `RootRule`, `IndexOptions.rootRules` |
| `Sources/DigUpKit/Crawler.swift` | `rules`, `owner(of:)`, `kindSkips`, shallow-проверка по контейнеру, `leftOut`/`foundRoot` по владельцу |
| `Sources/digup/main.swift` | `--root-rule` (разбор, `CLIError`), `options.rootRules`, usage |
| `shell/src-tauri/src/settings.rs` | `root_rules: BTreeMap<String, RootRule>`, тест round-trip |
| `shell/src-tauri/src/main.rs` | `KINDS`, `rule_arguments`, `inside`, `index_launch`/`estimate`, `set_root_rule`, уборка в `remove_folder`/`apply_setup_folders`, `settings_info`, `settings`-watcher `shallow` |
| `shell/src-tauri/src/watcher.rs` | `shallow: &[PathBuf]`, `NonRecursive`, shortcut-комментарий |
| `shell/src-tauri/src/status.rs` | Д8: `left_out` на любом `sync` |
| `shell/ui/settings.js` | кнопка «Rules», редактор в строке, `ruleText`, переводы причин |
| `shell/ui/settings.css` | `.confirm.rules`, `.confirm .choice` |
| `Tests/DigUpKitTests/RootRulesTests.swift` | 6 тестов (kinds, shallow, пустое правило, вложенные корни, частичный обход, сходимость) |

Проверки (все прошли):

- `python .build/swift_test.py` — 145 тестов, 144 прошли; единственный сбой — известный symlink-тест (Win32 1314).
- `cargo test --locked` — 62 теста, 0 сбоев; `cargo build --locked` — успешно.
- `node --check` по всем `shell/ui/*.js` — чисто.
- Живой прогон helper'а на дереве из 5 картинок + 1 видео (`digup estimate`): без правила 5+1; `--root-rule
  shallow` — 5 картинок, подпапок 0; `--root-rule kinds=[image,screenshot]` — 5 картинок и
  `left_out: 1 of a kind this folder doesn't index`; битый JSON — ошибка и код 1.
- UI через CDP на dev-сборке: кнопка «Rules» есть, редактор открывается (Pictures/PDFs/Documents/Recordings/Videos +
  «Top level only»), Save пишет `rootRules` в settings.json (ключ — написание из `settings.folders`), строка папки
  показывает «pictures, PDFs, documents, recordings only».
- Тот же прогон доиндексировал реальный индекс: `digup status` → 5 векторов, вид только `image` (видео отсечено
  правилом, сохранённым из UI), повторный запуск — `added 0`, `unchanged 5`, причина в `left_out`, и в Settings
  строка «5 of 5 indexed · 1 not read · why» → «1 of a kind this folder doesn't index».
- Watcher и `search-service` — по коду и тестам: в аргументах `index-service`/`estimate` есть `--root-rule` (правило
  применилось в живом индексе: 5 картинок, видео в `left_out`), у процесса `search-service` флага нет (проверено по
  командной строке).

Что осталось непроверенным вживую (только тестами): NonRecursive-watcher на живой папке (события глубины),
поведение на code-индексе с включённым правилом (правила туда не едут по построению), удаление папки с правилом на
Windows без учёта регистра (есть тест `inside`). `digup eval evals/*.json` не гонялся: поиск не менялся, а папка без
правила проходит те же ветки, что раньше (тест `noRuleLeavesTheCrawlAsItWas` сравнивает `candidates`, `leftOut` и
`skippedFolders`).

## Фаза 2 — пороги поиска в Settings (дешёвая)

- Settings → новая подсекция «Search»: zGate (число, 2.0 по умолчанию) и профили слоёв Images — Standard
  (0.648/0.600), Loose (0.60/0.55), Strict (0.68/0.64). Свободных чисел нет: пагинация слоёв опирается на
  `TIER_GAP` и защиту от низкой шкалы (`window.js:17, :175`).
- **Исправленная проводка:** пороги живут в `shell/ui/window.js` (`IMAGE_TIERS`, `TIER_GAP`, `tierRequest`), а не в
  settings.js; окно получает профиль из `window_info` (`main.rs:718`) и считает пороги от профиля. `zgate` сейчас
  окно **не отправляет** (`window.js:152-160`), хотя `search-service` его принимает
  (`Sources/digup/SearchService.swift:10-17`): добавить поле в запрос, иначе настройка мертва.
- Панель (`panel.js`) слоёв не имеет — профиль её не касается; `--zgate` CLI остаётся для диагностики.
- Проверка: `evals/*.json` до/после на Standard (дефолт, регрессий быть не должно), Loose/Strict — ручной прогон
  на живом индексе и снимок чисел.

## Фаза 3 — теги аудио (mp3 и соседи): декларативно, не плагин

**Решение.** `typeRules` — продолжение rootRules в settings:

```json
"typeRules": { ".mp3": "tags", ".wav": "skip", ".pdf": "full" }
```

- Режимы: `full` (как сейчас), `tags` (ffprobe → title/artist/album/genre/year в FTS + имя файла, **без**
  эмбеддинга звука), `skip` (не читать; причина в leftOut «skipped by type rule»).
- **Fingerprint не трогаем:** он глобален на индекс (`Model.swift:80`), и смена правила для одного расширения
  пере-индексировала бы всё. Целевой re-embed — `store.requeue(id)` (`IndexStore.swift:293`), как у changed-файлов.
- **Исправление прежнего черновика:** `SELECT id FROM files WHERE path LIKE '%.mp3'` неверен — `LIKE` в SQLite
  регистрозависим для не-ASCII и не покрывает `.MP3`/другие расширения. Расширение уже есть в `files.kind` и в
  пути; выбирать по `lower(substr(...))` или по списку расширений, а режим хранить в мете индекса
  (`store.meta`, как `vector_source`) — источник истины для синка, переживающий перезапуск.
- Триггер: helper сравнивает `typeRules` из настроек с метой индекса на старте sync; изменившиеся расширения →
  `requeue` их строк. Синк сам не может «увидеть» смену режима — правила не меняют файл.
- Экстрактор: `FFmpeg.output(FFmpeg.ffprobe, ["-show_entries", "format_tags", "-of", "json"])`
  (`Platform/Portable/Media+Portable.swift:26-52`), ffprobe уже ищется `find("ffprobe")` — новых бинарников нет.
  Сегмент `addSegment(kind: .chunk, modality: .text, text: "title — artist — album…")` → FTS; вектора нет, значит в
  meaning-выдаче файл участвует только по словам — это заявленное поведение режима.
- Требует правок `Indexer.prepare`/`process`/`audio`: сейчас аудио-сегменты всегда идут через `AudioExtractor` и
  эмбеддинг; для `tags` нужен текстовый сегмент без вектора (проверить, что `Searcher` и `summaries` не считают
  такой файл «failed»).
- Тесты: ffprobe-теги на .mp3-фикстуре, созданной ffmpeg'ом в тесте; `skip` не создаёт сегментов; смена
  full→tags пере-эмбеддит только эти строки (счётчик), остальной индекс не тронут.
- Открытый вопрос до реализации: `requeue` перечитывает файл целиком — для `tags` это дёшево (ffprobe), но
  `full → skip` должен ещё и удалять сегменты; проверить `IndexStore.delete` vs `requeue` на пустом результате.

## Фаза 4 (отложено) — плагины

Отложено до реального спроса. Единственная приемлемая архитектура — out-of-process экстракторы по JSON-lines
(как `digup worker`); настройка — маппинг расширение → команда. Не проектировать, пока фаза 3 не покажет спрос.

## Независимые находки (не входят в правило, но чинятся/документируются)

| Находка | Что не так | Что делаем |
|---|---|---|
| `estimate` (`main.rs:451-461`) | не передаёт `--exclude`/`--exclude-ext` | чиним в фазе 1 (Д5) |
| `remove_folder` (`main.rs:2409`) | `Path::starts_with` сравнивает регистр на Windows → осиротевшие `skipped` | общий `inside()` без регистра (Д7) |
| `status.rs` (`:58-66`) | `left_out` терялся на синке с новыми файлами (первый проход) | одна ветка `sync` (Д8), тест |
| Watcher и `kinds` | событие неиндексируемого типа просит синк | shortcut в коде + строка в шапке `watcher.rs` |
| `documents/development-guide.md` | устаревшие числа (56 тестов, 133/134, 0.1.1, `website.yml`) | обновлено 2026-11-04 |
| `folder_arguments` в `search-service` | правило могло бы сломать поиск | правила туда не едут (Д4) |

## Порядок работ и релизы

1. Фаза 1 — сделана 2026-11-04 (см. 1.8), идёт в ближайший релиз.
2. Фаза 2 — тот же или следующий релиз (дешёвая).
3. Фаза 3 — следующий релиз после фазы 1.
4. Фаза 4 — по спросу.

Каждая фаза: полные тесты + `evals` до/после на настройках по умолчанию + ручной прогон на реальной библиотеке.

## Риски и их обработка

- **Смешанные правила вложенных корней** — владелец = ближайший выбранный корень, кэш по каталогам (Д1), тест 4.
- **Правило осиротело** (папка удалена) — `remove_folder`/`apply_setup_folders` чистят `root_rules`; ключ
  сверяется через `same_path`.
- **`--root-rule` в dev-запуске** (`--roots` задаёт корни флагом, settings-папок нет): правила из Settings не едут.
  Правила и корни всегда из одного источника; задокументировано в шапке `settings.rs`.
- **Производительность**: фильтр по выбранным корням один раз на каталог (кэш), файлы папок без правил не платят
  ничего; shallow снимает целые поддеревья с обхода — быстрее, чем сейчас; watcher без рекурсии — дешевле.
- **leftOut-репорт**: две новые причины, переводы в `reasonLines`.
- **Правило на папке, которой больше нет**: `crawlPath` уводит путь к выжившему предку; правило просто не
  совпадёт, индекс не тронется.
