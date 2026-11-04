# Доступ агентов (MCP), read-only — 0.1.9

`digup mcp` — локальный MCP-сервер поверх индекса DigUp Plus. Транспорт — stdio, JSON-RPC 2.0 по строке на сообщение
(версия протокола `2024-11-05`); stdout — только протокол, диагностика идёт в stderr. Сервер **только читает**: в нём
нет ни одного инструмента, который пишет, перемещает или удаляет, и он никогда не меняет чужой конфиг.

Код: `Sources/DigUpKit/MCP.swift` (протокол и инструменты), `Sources/digup/MCPService.swift` (stdio-цикл и
`--print-config`). Тесты: `Tests/DigUpKitTests/MCPTests.swift`.

## Инструменты

| Инструмент | Параметры | Что отдаёт |
|---|---|---|
| `search` | `query` (обязателен), `kinds?`, `limit` 1…50 (по умолчанию 10), `offset` 0…10000, `meaning` (по умолчанию true), `code` (по умолчанию false) | `results[]` (`path`, `kind`, `score`, `size`, `modified`, `segment_id`, `loc?`, `loc_end?`, `snippet` ≤100 символов), `total`, `offset`, `next_offset`, `truncated`, `meaning`, `code`, `as_of` |
| `read_snippet` | `path` (обязателен), `segment_id?`, `query?`, `max_tokens` 32…1024 (по умолчанию 200), `code?` | `text` (окно вокруг первого слова запроса), `loc`, `loc_end`, `truncated`, `max_tokens` |
| `index_state` | — | `files`, `kinds`, `states`, `searchable`, `pending`, `unfinished`, `roots`, `as_of`, `model`, `code` |

- `search` по умолчанию ищет по смыслу, если в индексе есть векторы и модель на месте; без модели — только по словам
  (`meaning: false` в ответе). Префикс `code:` в запросе включает индекс кода, как в CLI.
- `read_snippet` без `segment_id` берёт сегмент файла, лучше всего совпавший со словами `query`, иначе первый
  **с текстом** (запись `name` с путём папки не отдаётся); у картинки или записи без тегов текста нет — `isError`.
  Отдаётся всегда окно, никогда файл целиком.
- Бюджеты: на весь ответ `search` — 6000 символов (≈1500 токенов); страница обрывается, `truncated: true`,
  `next_offset` продолжает с последней отданной строки. `offset` больше 10 000 отклоняется, а если продолжение
  упирается в предел — `next_offset: null` и `cursor_limit_reached: true`.
- Ошибки: неверные параметры — JSON-RPC `-32602`; сбой чтения/нет индекса — `isError: true` с текстом; неизвестный
  метод — `-32601`; не JSON — `-32700`.

## Что видит агент

- Только строки, которые есть в индексе (то есть файлы выбранных папок). `read_snippet` на путь, которого в индексе
  нет, отвечает `isError`.
- `--root DIR` (повторяемый) сужает область: путь обязан лежать внутри одного из корней, иначе
  `path is outside the configured agent scope`. Сравнение — после нормализации (`FolderSelection.realPath`), на Windows
  без учёта регистра. Без `--root` область — весь индекс.
- Индекс открывается существующим файлом; сервер не создаёт пустой индекс. `initialize` и `tools/list` отвечают и без
  индекса — инструменты тогда говорят «no index at …».

## Конфиг

```
digup mcp --print-config claude-desktop   # или claude-code, cursor
```

Печатает JSON с путём к `digup`, индексом, выбранными папками как `--root` и `env` (`DIGUP_MODELS`, при выборе
процессора — `DIGUP_DEVICE=cpu`). Вставить его нужно **в объект `mcpServers`** существующего конфига:

- Claude Desktop — `claude_desktop_config.json`;
- Claude Code — `.mcp.json` в проекте (или `claude mcp add`);
- Cursor — `~/.cursor/mcp.json`.

В приложении то же самое: Settings → Storage → Agents → «Copy MCP Config» (шеллинг берёт свои пути и папки).

## Чего нет (сознательно)

- Пишущих инструментов, reindex и правки чужих конфигов.
- `regex_search`/`find_symbol` — только если появится спрос и контракт (фаза 4).
- Keyset-курсора за пределом 10 000: у нас обычная пагинация, предел честно сообщается.

## Проверка

- `python .build/swift_test.py --filter MCPTests` — протокол, лимиты, бюджеты, скоуп, отсутствие индекса и пишущих
  инструментов.
- Живой прогон: `Get-Content .build\mcp-requests.jsonl | digup mcp --index .build\dev-rules\index` — `digup` нужно
  запускать в окружении Swift и `Vendor` (PATH как у `.build/swift_test.py`, `docs/development-guide.md` §4).
