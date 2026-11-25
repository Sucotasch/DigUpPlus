// DigUp Plus's window on Windows and Linux (tried out on the Mac first), for the searches the panel is too small for: kind
// filters with what the query found of each kind, the results as a grid of pictures (code as a list), the selected
// one in a preview pane with why it matched, and a status bar with indexing. Before a search it shows the home:
// examples to try, what's indexed, the shortcut. The Mac app's search window (Sources/DigUpApp/SearchWindow.swift) is
// the reference; the helper (`digup search-service`) does the work, and results.js has what a result says.
"use strict";

const TYPING_PAUSE = 120;   // ms after the last keystroke until the search runs (the query was embedded meanwhile)
const LIMIT = 120;          // the first page, as before: the window opens on the best results at once
// The Images filter's cosine layers, by profile (Settings → Search → Images): shown at once, the middle folded as
// weaker matches, and the tail behind its own fold. The standard cutoffs come from live results (2026-10-27, 3 772
// images): 0.648 is where "not quite" begins for Asian and Anime, 0.600 where their single irrelevant images end. A
// query whose whole scale sits lower has both moved down under its own top picture — the engine decides that
// (`Searcher.tierMinVisible`) and returns the pair it used, so the list and the chips can't disagree.
const IMAGE_TIER_PROFILES = {
  standard: { visible: 0.648, weak: 0.600 },
  loose: { visible: 0.600, weak: 0.550 },     // more weaker matches: a small or uneven collection
  strict: { visible: 0.680, weak: 0.640 },    // fewer: only what's clearly close
};
const PAGE_SIZE = 300;      // later pages: measured at ~13–18 ms of DOM each
const MORE_MARGIN = 400;    // px from the end of the list that asks for the next page
const FILTERS = [
  { key: "images", title: "Images", kinds: ["image", "screenshot"], section: "images", icon: "image" },
  { key: "ocr", title: "OCR", section: "ocr", icon: "screenshot" },
  { key: "documents", title: "Documents", kinds: ["pdf", "doc"], section: "documents", icon: "doc" },
  { key: "video", title: "Video", kinds: ["video"], icon: "video" },
  { key: "audio", title: "Audio", kinds: ["audio"], icon: "audio" },
];
const FILTER_OF_KIND = { screenshot: "images", image: "images", pdf: "documents", doc: "documents", video: "video",
                         audio: "audio" };
/// What the tick boxes, Select All and Move To/Copy To/Delete work on: every result that is a file handled by hand —
/// pictures, recordings, videos, PDFs and documents. Code search has its own index and stays out.
const MEDIA = new Set(["screenshot", "image", "video", "audio", "pdf", "doc"]);
/// The table's columns, in order; Properties is what the other columns don't say (a picture's size, a PDF's pages…).
const COLUMNS = [
  { key: "name", title: "Name" },
  { key: "size", title: "Size" },
  { key: "type", title: "Type" },
  { key: "date", title: "Date" },
  { key: "properties", title: "Properties" },
];
const EXAMPLES = [
  ["a screenshot of an error message", "ocr"], ["receipt", "documents"], ["whiteboard notes", "images"],
  ["someone laughing", "audio"], ["a dog on the beach", "video"], ["slides about the budget", "documents"],
];
/// What the home counts, in this order: "104 pictures, 25 PDFs…"
const KIND_ORDER = ["pictures", "pdf", "doc", "audio", "video", "code"];
const COUNTED = { pictures: ["picture", "pictures"], pdf: ["PDF", "PDFs"],
                  doc: ["document", "documents"], audio: ["audio file", "audio files"], video: ["video", "videos"],
                  code: ["code file", "code files"] };
const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6.5"/><path d="M15 15 L20.5 20.5"/></svg>';

const $ = (id) => document.getElementById(id);
const $query = $("query"), $content = $("content"), $side = $("side"), $splitter = $("splitter"), $kinds = $("kinds"), $menu = $("menu");
const $batch = $("batch"), $batchSummary = $("batch-summary"), $batchToggle = $("batch-toggle");
const $modal = $("modal"), $report = $("report");
const $announce = $("announce"), $more = $("more-results"), $moreCount = $("more-count");

/// The paths `paintSelection` last drew as chosen; null when the next paint must go over every cell (the grid was
/// rebuilt, or more cells were added).
let painted = null;

const state = {
  query: "",
  filter: "images",     // the window opens on Images (this fork's home ground); null is All files
  text: "",             // what was searched (without "code:")
  ranked: [],           // the strong results, best first
  weaker: [],           // below half the best one's score: folded
  counts: {},           // results of each filter for the query, whatever the filter (the chips' numbers)
  meaning: true,        // the results matched by meaning too (false: words only)
  warming: false,       // words only because the vectors are still loading (they arrive with a "vectors" event)
  ready: 0,             // the helper's ready events (model and vectors), so a reply can tell one arrived meanwhile
  hasResults: false,    // the results of the query in the field are in
  total: 0,             // files in the whole ranking (the engine's total; the helper may filter a few)
  strongTotal: 0,       // of those, the strong ones, over the whole ranking
  nextOffset: 0,        // where the next page starts in the ranking; moves by the helper's `consumed`
  matchesGeneration: null,   // the helper's index generation this list came from
  like: null,                // "Find similar": the file whose own vector is the query
  loadingMore: false,
  pageError: null,      // the last page's error, beside the button; the loaded results stay
  codePhase: null,      // "hint": "code:" alone; "off": no code folders
  selection: null,      // a result's path
  selected: new Set(),  // the files chosen for Move To, Copy To or Delete (their paths; every file kind but code)
  anchor: null,         // where a Shift-click or Shift-arrow range starts
  busy: null,           // the file operation under way: {id, kind, done, total, bytes, size, path}
  sheet: false,         // a sheet is up: a confirmation, or an operation's progress
  note: null,           // what the status bar says for a moment after an operation
  showWeaker: false,
  tc: null,             // Total Commander's program (Settings → General): the batch bar's two buttons, when found
  // Find similar's look-alike groups (Settings → Search): the lists the helper found, each starting with the picture
  // to show; which of them are open; and how many pictures are still getting a fingerprint.
  groups: null,
  groupsByPath: null,
  groupOpen: new Map(),
  expandAll: false,
  grouping: true,
  groupingEverywhere: false,   // Settings: group look-alikes in every search, not only Find similar
  onlyGroups: false,     // Find similar: leave the pictures that look like nothing else out of the list
  groupDifference: 6,
  groupingPending: 0,
  groupTries: 0,
  tiered: false,        // the list is the Images filter's cosine layers (visible / weaker / hidden)
  tierCutoffs: null,    // {visible, weak} the layers are cut on (the defaults, or lowered for a low-scale query)
  hidden: [],           // images under the weak cutoff: shown only when their fold is opened
  hiddenTotal: 0,       // of those, how many the whole image ranking has (the helper's count)
  hiddenOffset: 0,      // where the next hidden page starts
  showHidden: false,
  loadingHidden: false,
  hiddenError: null,
  showsPreview: true,
  view: "grid",         // how the results are shown: a grid of pictures, or a table (code stays a list)
  sort: null,           // the table's column and direction: { key, desc }; null keeps the best match first
  navigated: false,     // the selection was moved by the arrow keys or a click since the last edit: ← → move it then
  generation: 0,
  timer: null,
  error: null,
  info: { folders: [], hotkey: null, hasCode: false },
  app: {},              // indexing and the model, from the shell (status.rs): line, progress, caveat, counts
  indexed: null,        // files indexed of each kind (the home)
};
let debugPending = false;
let resultSeq = 0;   // ids for the results a screen reader follows through the field

// MARK: Searching

function isCode() {
  return state.filter === "code" || /^code:/i.test(state.query.trim());
}

/// The query or the filter changed: after a short pause in typing, the search. A filter click isn't typing, so it
/// searches at once (`immediate`) — the pause exists for the encoder's per-keystroke embed, which a click doesn't make.
function run(immediate = false) {
  const generation = ++state.generation;
  clearTimeout(state.timer);
  state.navigated = false;
  state.error = null;
  state.note = null;       // a search's count is what matters now, not the last operation's line; its report stays
  state.loadingMore = false;
  state.pageError = null;
  const wasChosen = state.selected.size;
  clearSelection(false);   // a new query or filter starts with nothing chosen
  // Ticks belong to what is visible: a new search may hide them in weak or hidden results, so they go - said out loud.
  if (wasChosen) setNote(`Selection cleared: ${countOf(wasChosen, "file")} chosen, and the search changed`);
  // Find similar's look-alike groups belong to the query that is going; a new one starts them fresh.
  clearGroups();
  state.groupOpen.clear();
  state.expandAll = false;
  state.groupTries = 0;
  const typed = state.query.trim();
  const code = isCode();
  const text = /^code:/i.test(typed) ? typed.slice(5).trim() : typed;
  state.codePhase = null;
  if (!typed || (code && (!state.info.hasCode || !text))) {
    Object.assign(state, { ranked: [], weaker: [], counts: {}, hasResults: false, selection: null, like: null,
                           total: 0, strongTotal: 0, nextOffset: 0, matchesGeneration: null,
                           tiered: false, tierCutoffs: null, hidden: [], hiddenTotal: 0, hiddenOffset: 0,
                           showHidden: false, loadingHidden: false, hiddenError: null,
                           loadingMore: false, pageError: null });
    if (typed) state.codePhase = state.info.hasCode ? "hint" : "off";
    clearGroups();
    render();
    return;
  }
  // A stale page from an earlier query must never be asked for: reset the paging while the old results stay on screen.
  Object.assign(state, { total: 0, strongTotal: 0, nextOffset: 0, matchesGeneration: null });
  ask({ op: "embed_ahead", q: text, code }).catch(() => {});
  // Results of an earlier query stay until these are in; with none to show, a spinner.
  renderBar();
  renderPagination();
  if (!state.hasResults) renderContent();
  const filter = FILTERS.find((item) => item.key === state.filter);
  state.timer = setTimeout(async () => {
    // An encoder that idled out reloads on the first meaning search (1–5 s, measured): say so instead of showing
    // nothing. Every filter now embeds the query: the chips' numbers come from the ordinary ranking, OCR's page alone
    // stays a words search (the engine keeps its section words-only).
    const usesMeaning = !state.like;
    const preparing = usesMeaning ? setTimeout(() => setNote("Preparing the model…"), 600) : null;
    try {
      const filtered = Boolean(filter) && !code;
      // The Images filter is shown in cosine layers. Its cutoffs are asked for in every search: the helper lowers them
      // under the query's own top picture when it must, and returns the pair it cut on, so the list, its folds and the
      // chips read one decision.
      const layered = filtered && filter.key === "images";
      const base = imageTiers();
      // One request: the filter's page and, from the whole ranking, the numbers on every chip. The OCR filter's page
      // is words-only (the engine's rule for that section), but the query is still embedded, because the other chips'
      // numbers come from the ordinary ranking.
      const readyAt = state.ready;
      const all = await ask({ op: "search", q: text, code, meaning: !state.like,
                              limit: LIMIT, tier_cutoffs: [base.visible, base.weak],
                              ...(filter?.kinds ? { kinds: filter.kinds } : {}),
                              ...(filter?.section ? { section: filter.section } : {}),
                              ...(state.like && !code ? { like: state.like } : {}),
                              ...(layered ? { by_cosine: true } : {}) });
      const shown = all;
      const tiers = shown.tier_counts ?? null;
      const cutoffs = layered
        ? (shown.tier_cutoffs ? { visible: shown.tier_cutoffs[0], weak: shown.tier_cutoffs[1] } : base)
        : null;
      if (generation !== state.generation) return;
      // The chips count the whole query, the same on every request: a click can't rewrite them. A helper too old to
      // send its totals falls back to this page's kind counts.
      const counts = countsOfReply(all, all.hits.slice(0, all.strong));
      // A rerun of the same query (the index moved under the list) keeps the person on the file they were on; a
      // new query starts at the top.
      const sameQuery = text === state.text;
      const previous = state.selection;
      const visible = [], weak = [];
      for (const hit of shown.hits) (tierOf(hit, layered ? cutoffs : null) === "visible" ? visible : weak).push(hit);
      const layers = layered && tiers != null;
      Object.assign(state, { counts, text, meaning: shown.meaning, warming: shown.warming === true,
                             hasResults: true,
                             // A kind filter asks for every result of that kind, so its weaker tail starts open. The
                             // All view keeps the fold: there the weak results are noise around unrelated kinds.
                             showWeaker: Boolean(filter) && !code,
                             ranked: layers ? visible : shown.hits.slice(0, shown.strong),
                             weaker: layers ? weak : shown.hits.slice(shown.strong),
                             tiered: layers, tierCutoffs: cutoffs,
                             hidden: [], hiddenTotal: layers ? tiers.hidden : 0, hiddenOffset: 0, showHidden: false,
                             hiddenError: null, loadingHidden: false,
                             total: shown.total ?? shown.hits.length,
                             strongTotal: layers ? tiers.visible : shown.strong_total ?? shown.strong,
                             nextOffset: shown.next_offset ?? shown.hits.length,
                             matchesGeneration: shown.generation ?? null, loadingMore: false, pageError: null });
      // The model or the vectors became ready while this request was in flight (the helper's event can reach the page
      // first): this answer is words only, so ask again rather than leave that on screen.
      if (state.warming && state.ready !== readyAt) {
        run();
        return;
      }
      // A new query starts at its best result (the comment above `sameQuery`): the preview beside the list shows the
      // first row. The same query run again stays on the file the person was on, if it's still there.
      if (!sameQuery || !rows().some((hit) => hit.path === state.selection)) {
        state.selection = rows()[0]?.path ?? null;
      }
      render();
      // Find similar: what looks alike among these results, folded into groups (the helper answers from its
      // fingerprints; pictures without one get theirs as it goes).
      refreshGroups();
      if (sameQuery && previous && state.selection === previous) {
        $content.querySelector(`[data-path="${CSS.escape(previous)}"]`)?.scrollIntoView({ block: "center" });
      }
      if (debugPending) report();
    } catch (error) {
      if (generation !== state.generation) return;
      state.error = String(error);
      renderStatus();
    } finally {
      clearTimeout(preparing);
      if (state.note === "Preparing the model…") {
        state.note = null;
        renderStatus();
      }
    }
  }, immediate ? 0 : TYPING_PAUSE);
}

/// The filter whose `kinds` the list is showing (the same one `run` sends), or nil for all files/code.
function pageFilter() {
  if (isCode()) return null;
  return FILTERS.find((item) => item.key === state.filter) ?? null;
}

/// The Images layers' cutoffs in use: the chosen profile (Settings → Search), or Standard.
function imageTiers() {
  return IMAGE_TIER_PROFILES[state.info?.imageTiers] || IMAGE_TIER_PROFILES.standard;
}

/// The helper's request for the Images pages after the first: ranked by cosine, cut on the pair the helper returned
/// (the same numbers the first page and the chips used).
function tierRequest(cutoffs) {
  return { by_cosine: true, tier_cutoffs: [cutoffs.visible, cutoffs.weak] };
}

/// Which image layer a hit belongs to. A file that matched by its words is shown at once, whatever its cosine.
function tierOf(hit, cutoffs) {
  if (!cutoffs || hit.keyword_rank != null) return "visible";
  const cosine = hit.cosine ?? -1;
  return cosine >= cutoffs.visible ? "visible" : cosine >= cutoffs.weak ? "weak" : "hidden";
}

function remainingResults() {
  return Math.max(0, state.total - state.nextOffset);
}

function remainingStrong() {
  return Math.max(0, state.strongTotal - state.nextOffset);
}

/// The footer's page control: shown only while there is something to fetch, and never says "300 more" when fewer
/// than 300 remain. `weaker` results are fetched only after the strong ones, by the button or by unfolding them.
function renderPagination() {
  const active = state.hasResults && state.query.trim() && !state.error;
  const remaining = active ? remainingResults() : 0;
  const strongRemaining = active ? remainingStrong() : 0;
  const total = state.total;
  if (!active || (!remaining && !(total > LIMIT && state.nextOffset >= total))) {
    $more.hidden = true;
    $moreCount.hidden = true;
    $more.textContent = "";
    $moreCount.textContent = "";
    return;
  }
  if (!remaining) {
    $more.hidden = true;
    $more.textContent = "";
    $moreCount.hidden = false;
    $moreCount.textContent = `All ${total.toLocaleString()} results shown`;
    return;
  }
  const inStrong = strongRemaining > 0;
  const size = Math.min(PAGE_SIZE, inStrong ? strongRemaining : remaining);
  $more.hidden = false;
  $more.disabled = state.loadingMore;
  $more.textContent = state.loadingMore ? "Loading…"
    : state.pageError ? "Retry"
    : inStrong ? `Show ${size.toLocaleString()} more`
    : `Show ${size.toLocaleString()} weaker ${size === 1 ? "result" : "results"}`;
  $moreCount.hidden = false;
  $moreCount.textContent = state.pageError ? "Couldn't load more results"
    : `There ${remaining === 1 ? "is" : "are"} ${remaining.toLocaleString()} more ${remaining === 1 ? "result" : "results"}`;
}

/// Asks for the next page. A scroll near the end asks only while strong results remain; the button also opens the
/// weaker tail, so a click never loads rows the user cannot see.
function loadMore(auto = false) {
  if (state.loadingMore || !state.hasResults || !state.query.trim()) return;
  const strongRemaining = remainingStrong();
  const remaining = remainingResults();
  if (remaining <= 0) return;
  if (auto && strongRemaining <= 0) return;
  const inStrong = strongRemaining > 0;
  const limit = Math.min(PAGE_SIZE, inStrong ? strongRemaining : remaining);
  if (limit <= 0) return;
  const generation = state.generation;
  const text = state.text;
  const code = isCode();
  const filter = pageFilter();
  const offset = state.nextOffset;
  state.loadingMore = true;
  state.pageError = null;
  renderPagination();
  // The same mode the first page was ranked in: if the encoder wasn't ready then, later pages must not suddenly
  // switch to meaning and mix two different rankings.
  ask({ op: "search", q: text, code, meaning: state.meaning, limit, offset,
        ...(state.like && !code ? { like: state.like } : {}),
        ...(filter?.kinds ? { kinds: filter.kinds } : {}),
        ...(filter?.section ? { section: filter.section } : {}),
        ...(state.tiered ? tierRequest(state.tierCutoffs) : {}) })
    .then((reply) => {
      if (generation !== state.generation) return;
      if (state.matchesGeneration != null && reply.generation != null
          && reply.generation !== state.matchesGeneration) {
        // The index changed under the list: mixing two rankings would skip or repeat files.
        run();
        return;
      }
      if (reply.meaning != null && reply.meaning !== state.meaning) {
        // The encoder stopped (or came back) between pages: a keyword page and a meaning page are different rankings.
        run();
        return;
      }
      const seen = new Set([...state.ranked, ...state.weaker].map((hit) => hit.path));
      const hits = reply.hits || [];
      const pageStrong = state.tiered
        ? hits.filter((hit) => tierOf(hit, state.tierCutoffs) === "visible" && !seen.has(hit.path))
        : hits.slice(0, reply.strong ?? 0).filter((hit) => !seen.has(hit.path));
      const pageWeak = state.tiered
        ? hits.filter((hit) => tierOf(hit, state.tierCutoffs) === "weak" && !seen.has(hit.path))
        : hits.slice(reply.strong ?? 0).filter((hit) => !seen.has(hit.path));
      state.ranked.push(...pageStrong);
      state.weaker.push(...pageWeak);
      state.total = reply.total ?? state.total;
      if (!state.tiered) state.strongTotal = reply.strong_total ?? state.strongTotal;
      state.nextOffset = reply.next_offset ?? (offset + (reply.consumed ?? hits.length));
      state.matchesGeneration = reply.generation ?? state.matchesGeneration;
      if (!inStrong && !state.showWeaker) state.showWeaker = true;
      // Every page is inserted into the list it belongs to, sorted or not, so a page never redraws everything loaded
      // before it. The first weaker page adds the fold itself if the list doesn't have one yet.
      const needsRebuild = !appendHits(pageStrong, pageWeak);
      if (needsRebuild) {
        const scroll = $content.scrollTop;
        renderContent();
        $content.scrollTop = scroll;
      } else if (pageWeak.length) {
        updateWeakerToggle();
      }
      if (!rows().some((hit) => hit.path === state.selection)) state.selection = rows()[0]?.path ?? null;
      renderBar();
      renderSide();
      renderStatus();
      renderBatch();
      renderPagination();
      syncActiveDescendant();
      refreshGroups();   // a new page can join a group or start one
      if (debugPending) report();
      // A page can be short after the helper filters moved files: keep filling the viewport while it is still near the
      // end. `nextOffset` moving is the guard against asking for the same page forever.
      if (auto && state.nextOffset > offset) setTimeout(maybeLoadMore, 0);
    })
    .catch((error) => {
      if (generation !== state.generation) return;
      state.pageError = String(error);
    })
    .finally(() => {
      if (generation === state.generation) {
        state.loadingMore = false;
        renderPagination();
        renderStatus();
      }
    });
}

/// Appends a page without rebuilding the list: `renderContent()` on every page would be quadratic (10k hits took
/// 479 ms to draw at once, while 300 appended cells take ~13–18 ms). Returns false when the current DOM has no place
/// for this page, in which case the caller rebuilds.
function appendHits(strongHits, weakHits) {
  painted = null;   // the new cells haven't been painted
  if (isCode()) {
    const box = $content.querySelector(".code-list");
    if (!box) return false;
    let toggle = box.querySelector(".weaker-main");
    for (const hit of strongHits) box.insertBefore(codeRow(hit), toggle ?? null);
    if (weakHits.length) {
      if (!toggle) { toggle = weakerToggle(); box.append(toggle); }
      if (state.showWeaker) {
        // A fold opened for the first time shows the weaker rows the first page had put there as well, not only
        // the ones this page brought.
        const weak = box.querySelector(".weaker-results") ? weakHits : state.weaker;
        for (const hit of weak) box.append(codeRow(hit, true));
      }
    }
    return true;
  }
  if (state.view === "table") {
    const body = $content.querySelector("tbody");
    if (!body) return false;
    let weakerRow = body.querySelector(".weaker-row:not(.hidden-row)");
    const freshWeak = !weakerRow || !weakerRow.nextElementSibling;
    if (weakHits.length && !weakerRow) {
      weakerRow = weakerTableRow();
      body.append(weakerRow);
    }
    if (!state.sort) {
      for (const hit of shownHits(strongHits)) {
        const row = tableRow(hit);
        if (weakerRow) body.insertBefore(row, weakerRow); else body.append(row);
      }
      // A fold opened for the first time shows the weaker rows the first page had put there as well.
      const weak = freshWeak ? state.weaker : weakHits;
      if (weak.length && state.showWeaker) for (const hit of shownHits(weak)) body.append(tableRow(hit));
      return true;
    }
    // Sorted: insert each row where it belongs between the rows already there, instead of redrawing the whole table
    // (a page at 10k rows would otherwise cost the sort and the DOM of all of them).
    const byPath = new Map([...state.ranked, ...state.weaker].map((hit) => [hit.path, hit]));
    const strongRows = [];
    for (let node = body.firstElementChild; node && node !== weakerRow; node = node.nextElementSibling) {
      if (node.classList.contains("result-row")) strongRows.push(node);
    }
    const weakRows = [];
    if (weakerRow) {
      for (let node = weakerRow.nextElementSibling; node; node = node.nextElementSibling) {
        if (node.classList.contains("result-row")) weakRows.push(node);
      }
    }
    const insert = (rows, hit, row, before) => {
      let low = 0, high = rows.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        const other = byPath.get(rows[mid].dataset.path);
        if (!other || compareHits(other, hit) <= 0) low = mid + 1; else high = mid;
      }
      body.insertBefore(row, rows[low] ?? before ?? null);
      rows.splice(low, 0, row);
    };
    for (const hit of shownHits(sortedHits(strongHits))) insert(strongRows, hit, tableRow(hit), weakerRow);
    if (weakHits.length && state.showWeaker) {
      if (!weakerRow) return false;
      // On a first fold, render the weak rows already received as well; later pages only add their own.
      const weak = weakRows.length === 0 ? state.weaker : weakHits;
      for (const hit of shownHits(sortedHits(weak))) insert(weakRows, hit, tableRow(hit), null);
    }
    return true;
  }
  const grid = $content.querySelector(".grid");
  if (!grid) return false;
  if (strongHits.length) {
    const cellsBox = cells(strongHits, "grid");
    grid.append(...cellsBox.childNodes);
  }
  if (weakHits.length) {
    let toggle = $content.querySelector(".weaker-main");
    if (!toggle) { toggle = weakerToggle(); grid.after(toggle); }
    if (state.showWeaker) {
      let weakGrid = $content.querySelector(".grid.weaker-results");
      if (!weakGrid) {
        weakGrid = element("div", "grid weaker-results");
        toggle.after(weakGrid);
      }
      // A fold opened for the first time shows the weak rows the first page had put there as well; on later pages
      // the DOM already has them, so only the new page is added.
      const weak = weakGrid.childElementCount ? weakHits : state.weaker;
      const cellsBox = cells(weak, "grid weaker-results");
      weakGrid.append(...cellsBox.childNodes);
    }
  }
  return true;
}

/// Keeps the fold's own count current after pages of weaker results arrive (the toggle holds an icon and a text node).
function updateWeakerToggle() {
  const toggle = $content.querySelector(".weaker-main");
  if (!toggle) return;
  const count = state.weaker.length;
  const text = state.showWeaker ? "Weaker matches" : `${count} weaker ${count === 1 ? "match" : "matches"}`;
  if (toggle.lastChild?.nodeType === Node.TEXT_NODE) toggle.lastChild.textContent = text;
  else toggle.append(text);
}

/// The scroll listener: only strong pages load by themselves; the weaker tail waits for its fold or the button.
function maybeLoadMore() {
  if (!state.hasResults || state.loadingMore || !state.query.trim()) return;
  if ($content.scrollTop + $content.clientHeight < $content.scrollHeight - MORE_MARGIN) return;
  if (remainingStrong() > 0) loadMore(true);
}

function setQuery(text) {
  $query.value = text;
  queryChanged();
}

function queryChanged() {
  closeBig();
  state.query = $query.value;
  $("clear").hidden = !state.query;
  run();
}

/// A filter key this window knows, or All files: a saved or handed-over "screenshots" (from before Images and OCR were
/// the same pictures) must not leave the window on a filter that no longer exists.
function knownFilter(key) {
  return key === "code" || FILTERS.some((filter) => filter.key === key) ? key : null;
}

function setFilter(key) {
  if (key === state.filter) return;
  state.filter = key;
  state.like = null;   // a filter change searches by words again
  if (key !== "code" && /^code:/i.test(state.query.trim())) {
    // Leaving code for files: "code:" goes from the field.
    $query.value = state.query.trim().slice(5).trim();
    state.query = $query.value;
  }
  run(true);
}

/// Every result shown, in the order it's shown: the strong ones, then the weaker ones once they're unfolded; in the
/// table, each group by the column chosen.
/// Whether the window groups its results now. Find similar has its own switch (on unless turned off); a normal search
/// groups only when Settings → Search asks for it, so the main list stays as it was. The view doesn't matter: the table
/// folds the same way (a swipe through the views must not lose the groups).
/// Whether this search can hold pictures at all: look-alike groups are fingerprints of pictures, and documents,
/// recordings and videos have none, so the line and the work behind it stay out of those categories.
function picturesPossible() {
  return state.filter === null || state.filter === "images";
}

function groupingActive() {
  if (isCode() || !picturesPossible()) return false;
  return state.like ? state.grouping : state.groupingEverywhere;
}

/// The badge a group's representative carries: "+N" while folded, "−N" while open. The grid puts it on the picture, the
/// table beside the name; either way a click toggles the group, as G does for the result under the cursor.
function groupBadge(hit) {
  const group = groupOf(hit.path);
  if (!group || hit.path !== group[0]) return null;
  const badge = element("button", "group-badge", `${groupOpen(group) ? "−" : "+"}${group.length - 1}`);
  badge.type = "button";
  badge.dataset.group = group[0];
  badge.setAttribute("aria-expanded", String(groupOpen(group)));
  badge.onmousedown = (event) => { event.stopPropagation(); event.preventDefault(); };
  badge.onclick = (event) => { event.stopPropagation(); toggleGroup(group); };
  decorateGroupBadge(badge, group);
  return badge;
}

/// Says how many of the group's files are chosen, so a folded group with hidden copies shows it at a glance.
function decorateGroupBadge(badge, group) {
  const chosen = group.filter((path) => state.selected.has(path)).length;
  badge.classList.toggle("chosen", chosen > 0);
  badge.title = (groupOpen(group) ? "Fold these look-alikes (G)" : `${group.length - 1} more like this (G)`)
    + (chosen ? ` · ${chosen} of ${group.length} chosen` : "");
}

function groupOf(path) {
  return state.groupsByPath?.get(path) ?? null;
}

function groupOpen(group) {
  return state.groupOpen.get(group[0]) ?? state.expandAll;
}

/// One list as entries: a plain picture, or an open group's pictures together (the grid draws those in one frame).
function groupEntries(list) {
  if (!groupingActive()) return list.map((hit) => ({ hit }));
  const index = new Map(list.map((hit, at) => [hit.path, at]));
  const entries = [];
  for (const hit of list) {
    const group = groupOf(hit.path);
    // "Groups only": a picture that looks like nothing else is left out; a copy keeps its place when the picture it
    // belongs to ranks outside this list (that is where the list shows it).
    if (!group) {
      if (!state.onlyGroups) entries.push({ hit });
      continue;
    }
    if (!index.has(group[0])) { entries.push({ hit }); continue; }
    if (hit.path !== group[0]) continue;
    if (!groupOpen(group)) { entries.push({ hit }); continue; }
    entries.push({ group: group.map((path) => list[index.get(path)]).filter(Boolean) });
  }
  return entries;
}

function shownHits(list) {
  return groupEntries(list).flatMap((entry) => entry.group ?? [entry.hit]);
}

function rows() {
  const sorted = (hits) => (state.view === "table" && state.sort ? sortedHits(hits) : hits);
  const shown = (hits) => shownHits(sorted(hits));
  return [...shown(state.ranked), ...(state.showWeaker ? shown(state.weaker) : []),
          ...(state.showHidden ? shown(state.hidden) : [])];
}

// MARK: Look-alike groups (Find similar)

/// Forgets the groups of the query that was going: a new search starts them fresh, and a list without groups shows
/// as it always did.
function clearGroups() {
  state.groups = null;
  state.groupsByPath = null;
  state.groupingPending = 0;
  state.groupTries = 0;
  state.groupOpen.clear();
  state.expandAll = false;
}

/// What a fold leaves: a chosen file that is no longer shown leaves the selection, unless it is one of a group's
/// copies folded under its representative — those stay chosen (that is what ticking the group is for), and the
/// representative's badge says how many. The cursor moves to a picture that is shown.
function settleSelection() {
  const shown = new Set(rows().map((hit) => hit.path));
  for (const path of [...state.selected]) {
    if (shown.has(path)) continue;
    const group = groupOf(path);
    if (group && group[0] !== path && shown.has(group[0])) continue;
    state.selected.delete(path);
  }
  if (state.anchor && !shown.has(state.anchor)) state.anchor = null;
  if (state.selection && !shown.has(state.selection)) state.selection = rows()[0]?.path ?? null;
}

/// The helper's look-alike groups for what the list shows, then a redraw. Pictures an index made before schema 7 has
/// no fingerprint for get one a few at a time (the helper's short budget), so the window asks again while that makes
/// progress instead of waiting for a whole-index pass.
async function refreshGroups() {
  if (!groupingActive() || !state.hasResults) {
    if (state.groups) {
      clearGroups();
      renderContent();
      renderGroups();
      renderBatch();
    }
    return;
  }
  const paths = [...state.ranked, ...(state.showWeaker ? state.weaker : []),
                 ...(state.showHidden ? state.hidden : [])].map((hit) => hit.path);
  if (paths.length < 2) {
    if (state.groups) {
      clearGroups();
      renderContent();
      renderGroups();
    }
    return;
  }
  const generation = state.generation;
  let computed = 0;
  try {
    const reply = await ask({ op: "visual_groups", paths, difference: state.groupDifference });
    if (generation !== state.generation) return;
    state.groups = reply.groups || [];
    state.groupsByPath = new Map();
    for (const group of state.groups) for (const path of group) state.groupsByPath.set(path, group);
    state.groupingPending = reply.pending ?? 0;
    computed = reply.computed ?? 0;
    state.groupTries += 1;
  } catch {
    if (generation !== state.generation) return;
    clearGroups();
  }
  settleSelection();
  const scroll = $content.scrollTop;
  renderContent();
  $content.scrollTop = scroll;
  renderSide();
  renderBatch();
  renderGroups();
  renderStatus();
  if (computed > 0 && state.groupingPending > 0 && state.groupTries < 40) {
    setTimeout(() => { if (generation === state.generation) refreshGroups(); }, 350);
  }
}

/// Redraws what a change to the grouping touches, keeping the scroll place (opening a group must not jump the list).
function redrawGroups() {
  settleSelection();
  painted = null;
  const scroll = $content.scrollTop;
  renderContent();
  $content.scrollTop = scroll;
  renderSide();
  renderBatch();
  renderGroups();
  renderStatus();
}

/// Opens or folds one group; a single choice steps out of "Expand all" without folding the others.
function toggleGroup(group) {
  const opening = !groupOpen(group);
  // Leaving "Expand all": every group keeps what it was showing, and only this one changes.
  if (state.expandAll) {
    for (const other of state.groups ?? []) state.groupOpen.set(other[0], state.expandAll);
    state.expandAll = false;
  }
  state.groupOpen.set(group[0], opening);
  // Folding with the cursor on a copy: it lands on the picture the group folds under, not at the top of the list.
  if (!opening && state.selection && group.includes(state.selection)) state.selection = group[0];
  redrawGroups();
}

/// Expand all, or fold every group back (the line's button, and Shift+G).
function toggleAllGroups() {
  state.expandAll = !state.expandAll;
  state.groupOpen.clear();
  redrawGroups();
}

/// The Group look-alikes switch: off shows the list flat, on asks the helper for the groups again.
function applyGrouping() {
  if (!groupingActive()) {
    if (state.groups) clearGroups();
  } else {
    refreshGroups();
  }
  settleSelection();
  painted = null;
  const scroll = $content.scrollTop;
  renderContent();
  $content.scrollTop = scroll;
  renderSide();
  renderBatch();
  renderGroups();
  renderStatus();
}

/// Settings → Search, from the window's own controls: the value is kept for the next start. Writes go one after
/// another (`lookalikeSave`): two quick clicks must not finish in the other order and leave the old value in the file.
let lookalikeSave = Promise.resolve();
function saveLookalike() {
  const value = { groups: state.grouping, everywhere: state.groupingEverywhere,
                  difference: state.groupDifference };
  lookalikeSave = lookalikeSave
    .then(() => invoke("set_lookalike", value))
    .then((saved) => {
      state.groupDifference = Number(saved.difference ?? state.groupDifference);
      renderGroups();
    })
    .catch(failed);
}

/// The line under the kind chips, only in Find similar: how many groups and folded pictures, all/none, and the
/// difference. It is the only new control in the window, and a normal search never sees it.
function renderGroups() {
  const line = $("groups");
  // Find similar always shows its line (that is where the switch lives); a normal search shows it only while it groups,
  // and only where pictures can be: a documents or recordings search has nothing to fold.
  const on = state.like ? state.grouping : state.groupingEverywhere;
  const active = !isCode() && picturesPossible() && state.hasResults
    && (Boolean(state.like) || state.groupingEverywhere);
  line.hidden = !active;
  if (!active) return;
  const groups = state.groups || [];
  const folded = groups.reduce((sum, group) => sum + (groupOpen(group) ? 0 : group.length - 1), 0);
  const chosen = groups.reduce((sum, group) => sum + group.filter((path) => state.selected.has(path)).length, 0);
  const pending = state.groupingPending;
  $("groups-count").textContent = !on ? "Look-alike groups are off"
    : groups.length
      ? `${groups.length.toLocaleString()} ${groups.length === 1 ? "group" : "groups"}`
        + (folded ? ` · ${folded.toLocaleString()} folded` : " · all shown")
        + (state.onlyGroups ? " · groups only" : "")
        + (chosen ? ` · ${chosen.toLocaleString()} chosen` : "")
        + (pending ? ` · ${pending.toLocaleString()} getting a fingerprint` : "")
      : pending ? `${pending.toLocaleString()} pictures are getting a fingerprint`
      : "No look-alikes grouped";
  $("groups-count").title = chosen ? "Alt+click a picture to clear its look-alike group's selection" : "";
  $("groups-expand").hidden = !groups.length || !on;
  $("groups-expand").textContent = state.expandAll ? "Collapse all" : "Expand all";
  // The controls say what the window is doing; the number field keeps what is being typed into it.
  $("group-on").checked = on;
  $("group-only").checked = state.onlyGroups;
  for (const id of ["group-only", "group-difference", "group-preset-6", "group-preset-33"]) {
    $(id).disabled = !on;
  }
  if (document.activeElement !== $("group-difference")) $("group-difference").value = state.groupDifference;
}

function selectedHit() {  const shown = rows();
  return shown.find((hit) => hit.path === state.selection) ?? shown[0] ?? null;
}

// MARK: Drawing

function render() {
  hidePeek();
  renderBar();
  renderContent();
  renderSide();
  renderStatus();
  renderBatch();
  renderPagination();
  renderGroups();
}

function renderBar() {
  const code = isCode();
  $("glass").innerHTML = code ? ICONS.code : SEARCH_ICON;
  $query.placeholder = state.filter === "code" ? "Describe the code: “retry a request with backoff”, a name in it…"
    : state.info.hasCode ? "Describe it: “zebra in a video”, “code: retry with backoff”…"
    : "Describe it: “receipt from the hardware store”, “zebra in a video”…";
  $kinds.replaceChildren();
  // Images first: this fork's home ground (the cosine layers open with the weaker tail), All files last as the
  // mixed view. Code sits past the divider: another index, not another kind of this one.
  FILTERS.forEach((filter, index) => {
    const selected = state.filter === filter.key && !code;
    $kinds.append(chip(filter.title, filter.icon, code ? null : state.counts[filter.key], selected,
                       () => setFilter(selected ? null : filter.key), index + 1));
  });
  $kinds.append(chip("All files", null, null, state.filter === null && !code, () => setFilter(null),
                     FILTERS.length + 1));
  if (state.info.hasCode) {
    $kinds.append(element("span", "divider"));
    $kinds.append(chip("Code", "code", code ? state.counts.code : null, code,
                       () => setFilter(state.filter === "code" ? null : "code"), FILTERS.length + 2));
  }
  $("toggle-view").hidden = code;
  updateViewButton();
}

/// All · Screenshots 4 · Images 9 · …: what the query found of each kind; a click shows only that kind.
function chip(title, icon, count, selected, action, number) {
  const button = element("button", "chip" + (selected ? " selected" : ""));
  if (icon) button.insertAdjacentHTML("beforeend", ICONS[icon]);
  button.append(title);
  if (count != null && state.query.trim()) button.append(element("span", "number", count.toLocaleString()));
  button.title = `${title} (${MOD}${number})`;
  button.setAttribute("aria-pressed", String(selected));
  button.onclick = action;
  return button;
}

function renderContent() {
  hidePeek();   // the cells are rebuilt: a peek attached to an old one would be stale (and its album with it)
  closeHover();   // same for a player anchored to one of them; a pinned one has no anchor to lose
  painted = null;
  thumbnails.disconnect();
  $content.replaceChildren();
  $content.scrollTop = 0;
  if (!state.info.folders.length) $content.append(chooseFolders());
  else if (!state.query.trim()) $content.append(home());
  else if (state.codePhase) $content.append(codeHintOrOff());
  else if (!state.hasResults) $content.append(centered(element("div", "spinner")));
  // Words found nothing while the model loads: "Nothing found" would be a lie, and the answer is on its way.
  else if (state.warming) $content.append(centered(element("div", "spinner")));
  else if (!state.ranked.length && !state.weaker.length && !state.hiddenTotal) $content.append(nothingFound());
  else if (groupingActive() && state.onlyGroups && !state.groups?.length) {
    $content.append(centered(element("div", "tier-note", "No look-alikes at this difference.")));
  }
  else if (isCode()) $content.append(codeList());
  else if (state.view === "table") $content.append(resultsTable());
  else $content.append(grid());
  syncActiveDescendant();
}

function grid() {
  const box = element("div");
  box.append(cells(state.ranked, "grid"));
  if (state.weaker.length) {
    box.append(weakerToggle());
    if (state.showWeaker) box.append(cells(state.weaker, "grid weaker-results"));
  }
  if (state.tiered && (state.hiddenTotal > 0 || state.hidden.length)) {
    box.append(hiddenToggle());
    if (state.showHidden) {
      box.append(cells(state.hidden, "grid hidden-results"));
      if (state.loadingHidden) box.append(element("div", "tier-note", "Loading hidden images…"));
      else if (state.hiddenError) box.append(element("div", "tier-note", "Couldn't load the hidden images"));
      else if (state.hiddenOffset < state.hiddenTotal) {
        const count = Math.min(PAGE_SIZE, state.hiddenTotal - state.hiddenOffset);
        const more = element("button", "weaker-toggle hidden-more", `Show ${count.toLocaleString()} more hidden`);
        more.onclick = () => loadHidden();
        box.append(more);
      }
    }
  }
  return box;
}

/// The results as a table: Name, Size, Type, Date and Properties, sorted by a click on a heading. The chosen files are
/// ticked here too, and Move To, Copy To and Delete work on them as in the grid.
function resultsTable() {
  const wrap = element("div", "table-wrap");
  const table = element("table", "results-table");
  table.setAttribute("role", "grid");
  table.setAttribute("aria-label", "Results");
  if (isWindows) table.setAttribute("aria-multiselectable", "true");
  const head = element("thead");
  const headRow = element("tr");
  if (isWindows) {
    const cell = element("th", "check");
    cell.setAttribute("role", "columnheader");
    cell.setAttribute("aria-label", "Select");
    headRow.append(cell);
  }
  for (const column of COLUMNS) {
    const cell = element("th", column.key);
    cell.setAttribute("role", "columnheader");
    cell.setAttribute("aria-sort", state.sort?.key === column.key ? (state.sort.desc ? "descending" : "ascending") : "none");
    const button = element("button", "sort" + (state.sort?.key === column.key ? " sorted" : ""));
    button.append(column.title);
    if (state.sort?.key === column.key) button.append(element("span", "arrow", state.sort.desc ? "↓" : "↑"));
    button.title = `Sort by ${column.title}`;
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = () => sortBy(column.key);
    cell.append(button);
    headRow.append(cell);
  }
  head.append(headRow);
  const body = element("tbody");
  for (const hit of shownHits(sortedHits(state.ranked))) body.append(tableRow(hit));
  if (state.weaker.length) {
    body.append(weakerTableRow());
    if (state.showWeaker) for (const hit of shownHits(sortedHits(state.weaker))) body.append(tableRow(hit));
  }
  if (state.tiered && (state.hiddenTotal > 0 || state.hidden.length)) {
    body.append(hiddenTableRow());
    if (state.showHidden) {
      for (const hit of shownHits(sortedHits(state.hidden))) body.append(tableRow(hit));
      if (state.hiddenOffset < state.hiddenTotal) body.append(hiddenMoreRow());
    }
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

/// The row that folds the weaker results away, between the table's strong rows and its weak ones.
function weakerTableRow() {
  const row = element("tr", "weaker-row");
  const cell = element("td");
  cell.colSpan = COLUMNS.length + (isWindows ? 1 : 0);
  cell.append(weakerToggle());
  row.append(cell);
  return row;
}

/// The row that folds the images below the weak cutoff away, under the weaker rows.
function hiddenTableRow() {
  const row = element("tr", "weaker-row hidden-row");
  const cell = element("td");
  cell.colSpan = COLUMNS.length + (isWindows ? 1 : 0);
  cell.append(hiddenToggle());
  row.append(cell);
  return row;
}

/// The row that fetches more of the hidden tail, under the hidden rows.
function hiddenMoreRow() {
  const row = element("tr", "weaker-row hidden-row");
  const cell = element("td");
  cell.colSpan = COLUMNS.length + (isWindows ? 1 : 0);
  const count = Math.min(PAGE_SIZE, state.hiddenTotal - state.hiddenOffset);
  const more = element("button", "weaker-toggle hidden-more", `Show ${count.toLocaleString()} more hidden`);
  more.onclick = () => loadHidden();
  cell.append(more);
  row.append(cell);
  return row;
}

/// One result in the table: its kind's icon, its name and the place that matched, size, type, date, and what the other
/// columns leave out.
function tableRow(hit) {
  const chosen = state.selected.has(hit.path);
  const row = element("tr", "result-row" + (hit.path === state.selection ? " selected" : "") + (chosen ? " checked" : ""));
  row.dataset.path = hit.path;
  row.setAttribute("role", "row");
  row.setAttribute("aria-selected", String(chosen));
  if (isWindows) {
    const cell = tableCell("check");
    if (MEDIA.has(hit.kind)) cell.append(checkboxFor(hit));
    row.append(cell);
  }
  const nameCell = tableCell("name-column");
  const name = element("div", "table-name");
  const icon = element("span", "type-icon");
  icon.innerHTML = ICONS[hit.kind] || ICONS.doc;
  const text = element("span", "name", "‎" + nameOf(hit.path));
  text.title = nameOf(hit.path);
  if (hit.info?.tags === "1") text.append(element("span", "tags-badge", "by tags"));
  name.append(icon, text);
  const place = placeOf(hit);
  if (place) name.append(element("span", "place", place));
  const group = groupingActive() ? groupOf(hit.path) : null;
  if (group && hit.path === group[0]) name.append(groupBadge(hit));
  else if (group) row.classList.add("group-member");
  nameCell.append(name);
  const type = typeOf(hit), date = dateOf(hit.modified), properties = propertiesOf(hit);
  const typeCell = tableCell("type", type);
  typeCell.title = type;
  const dateCell = tableCell("date", date);
  dateCell.title = date;
  const propertiesCell = tableCell("properties", properties);
  propertiesCell.title = properties;
  row.append(nameCell, tableCell("size", hit.size > 0 ? bytes(hit.size) : ""), typeCell, dateCell, propertiesCell);
  wire(row, hit);
  peekOnHover(row, hit);   // the list needs it more than the grid: there is no picture in a row to look at
  return row;
}

function tableCell(className, text) {
  const cell = element("td", className, text);
  cell.setAttribute("role", "gridcell");
  return cell;
}

/// A click on a heading sorts by it; a second click turns the order around.
function sortBy(key) {
  state.sort = state.sort?.key === key ? { key, desc: !state.sort.desc } : { key, desc: false };
  renderContent();
}

/// The order the table's column puts two results in; `sortedHits` and a page inserted into a sorted table both use
/// exactly this one, so they can't disagree about where a row goes.
function compareHits(a, b) {
  const { key, desc } = state.sort;
  const value = (hit) => {
    switch (key) {
      case "name": return nameOf(hit.path).toLocaleLowerCase();
      case "size": return Number(hit.size) || 0;
      case "type": return typeOf(hit).toLocaleLowerCase();
      case "date": return Number(hit.modified) || 0;
      default: return propertiesOf(hit).toLocaleLowerCase();
    }
  };
  const left = value(a), right = value(b);
  const order = typeof left === "number" ? left - right : left.localeCompare(right, undefined, { numeric: true });
  return order ? order * (desc ? -1 : 1) : nameOf(a.path).localeCompare(nameOf(b.path), undefined, { numeric: true });
}

/// The results by the table's column, in the direction chosen; without a column, the best match first.
function sortedHits(hits) {
  return state.sort ? [...hits].sort(compareHits) : hits;
}

/// The table's Type: the extension as file managers show it, or what kind it is when it has none.
function typeOf(hit) {
  const extension = extensionOf(hit.path);
  return extension ? extension.toUpperCase() : KIND_TITLE[hit.kind] || "File";
}

/// What the other columns don't say: a picture's size, a document's pages, a recording's length, code's lines.
function propertiesOf(hit) {
  const info = hit.info || {};
  const parts = [];
  if (info.width && info.height) parts.push(`${info.width} × ${info.height}`);
  if (info.pages) parts.push(Number(info.pages) === 1 ? "1 page" : `${Number(info.pages).toLocaleString()} pages`);
  else if (info.read_to != null) parts.push("partly read");
  if (info.lines) parts.push(Number(info.lines) === 1 ? "1 line" : `${Number(info.lines).toLocaleString()} lines`);
  if (info.duration) parts.push(clock(Number(info.duration)));
  // A recording read by its tags has no length (nothing was decoded): its artist and album say more.
  if (info.tags === "1") {
    const tags = [info.artist, info.album].filter(Boolean).join(" — ");
    if (tags) parts.push(tags);
  }
  return parts.join(" · ");
}

function cells(hits, className) {
  const box = element("div", className);
  if (className === "grid" && isWindows) {
    box.setAttribute("role", "listbox");
    box.setAttribute("aria-multiselectable", "true");
  }
  for (const entry of groupEntries(hits)) {
    if (!entry.group) {
      box.append(cell(entry.hit));
      continue;
    }
    // An open group is one green frame across the row, its pictures in a grid of their own.
    const block = element("div", "group-block");
    for (const hit of entry.group) block.append(cell(hit));
    box.append(block);
  }
  return box;
}

/// A result in the grid: its picture in a fixed box (a picture's own shape never sizes the cell), what kind it is,
/// the page or moment that matched, its name and folder.
function cell(hit) {
  const chosen = state.selected.has(hit.path);
  const item = element("div", "cell" + (hit.path === state.selection ? " selected" : "") + (chosen ? " checked" : ""));
  item.dataset.path = hit.path;
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", String(chosen));
  item.setAttribute("aria-label", `${KIND_TITLE[hit.kind] || "File"}, ${nameOf(hit.path)}, ${reasonOf(hit)}`);
  const picture = element("div", "picture");
  picture.append(cellPicture(hit));
  if (isWindows && MEDIA.has(hit.kind)) picture.append(checkboxFor(hit));
  if (hit.kind !== "image" && hit.kind !== "screenshot") {
    const badge = element("span", "kind-badge");
    badge.innerHTML = ICONS[hit.kind] || ICONS.doc;
    picture.append(badge);
  }
  const group = groupingActive() ? groupOf(hit.path) : null;
  if (group && hit.path === group[0]) {
    picture.append(groupBadge(hit));
  } else if (group) {
    item.classList.add("group-member");
  }
  const place = placeOf(hit);
  if (place) picture.append(element("span", "place on-image", place));
  const name = element("div", "name", "‎" + nameOf(hit.path));
  if (hit.info?.tags === "1") name.append(element("span", "tags-badge", "by tags"));
  item.append(picture, name, folderLine(folderOf(hit)));
  wire(item, hit);
  peekOnHover(item, hit);
  return item;
}

/// A click on the checkbox is the same choice as a click on the picture: plain takes it (a group's best match takes
/// the group), Shift+click takes the range from the last one, Alt+click lets go of its group, Ctrl/⌘ toggles one.
function checkboxFor(hit) {
  const box = element("button", "checkbox");
  box.type = "button";
  box.setAttribute("role", "checkbox");
  box.setAttribute("aria-label", `Select ${nameOf(hit.path)}`);
  box.innerHTML = ICONS.check;
  const mixed = mixedChoice(hit.path);
  box.classList.toggle("mixed", mixed);
  box.setAttribute("aria-checked", mixed ? "mixed" : String(state.selected.has(hit.path)));
  box.onmousedown = (event) => { event.stopPropagation(); event.preventDefault(); };
  box.onclick = (event) => {
    event.stopPropagation();
    if (event.shiftKey || event.altKey) { pick(hit, event); return; }
    toggleSelected(hit.path);
  };
  return box;
}

/// A group's representative whose own file is not chosen while some of its copies are: the tick goes grey (aria "mixed")
/// and the next click clears the copies — the second step after "drop the head, keep the copies".
function mixedChoice(path) {
  if (!groupingActive()) return false;
  const group = groupOf(path);
  return Boolean(group && group[0] === path && !state.selected.has(path)
    && group.some((member) => state.selected.has(member)));
}

/// The picture of a cell: the photo or screenshot, the frame or page that matched (from the helper, once the cell
/// scrolls into view), a document's passage in small print, or the kind's icon.
function cellPicture(hit) {
  if (hit.kind === "audio") return bigIcon("audio");
  const what = renderOf(hit);
  if (what) {
    const image = element("img", hit.kind === "pdf" ? "page" : "");
    image.alt = "";
    image.dataset.render = JSON.stringify([...what, Math.round(240 * (window.devicePixelRatio || 1))]);
    thumbnails.observe(image);
    return image;
  }
  if (hit.kind === "doc" && hit.excerpt) {
    const card = element("div", "text-card");
    card.dir = "auto";
    card.innerHTML = marked(hit.excerpt.slice(0, 600));
    return card;
  }
  return bigIcon(hit.kind, true);
}

function bigIcon(kind, quiet) {
  const icon = element("div", "big-icon" + (quiet ? " quiet" : ""));
  icon.innerHTML = ICONS[kind] || ICONS.doc;
  return icon;
}

/// Pictures are asked of the helper as their cells come into view: a search can show a hundred of them.
const thumbnails = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const image = entry.target;
    thumbnails.unobserve(image);
    const [kind, loc, pixels] = JSON.parse(image.dataset.render);
    const path = image.closest("[data-path]").dataset.path;
    loadRenderedImage(image, path, kind, loc, pixels,
      (file) => { if (image.isConnected) image.closest("[data-path]").dataset.thumb = file; },
      (shown) => shown.replaceWith(bigIcon(kind === "image" ? "image" : kind, true)));
  }
}, { root: $content, rootMargin: "300px" });

function folderLine(text, tag = "div") {
  const line = element(tag, "folder");
  const inner = document.createElement("bdi");
  inner.textContent = text;
  line.append(inner);
  line.title = text;
  return line;
}

function weakerToggle() {
  const count = state.weaker.length;
  const toggle = element("button", "weaker-toggle weaker-main" + (state.showWeaker ? " open" : ""));
  toggle.innerHTML = ICONS.chevron;
  toggle.append(state.showWeaker ? "Weaker matches" : `${count} weaker ${count === 1 ? "match" : "matches"}`);
  toggle.onmousedown = (event) => event.preventDefault();
  toggle.onclick = () => {
    state.showWeaker = !state.showWeaker;
    // The weaker ones folded away take their files out of what's chosen.
    const left = new Set(rows().map((hit) => hit.path));
    for (const path of state.selected) if (!left.has(path)) state.selected.delete(path);
    if (state.anchor && !left.has(state.anchor)) state.anchor = null;
    if (!rows().some((hit) => hit.path === state.selection)) state.selection = rows()[0]?.path ?? null;
    const scroll = $content.scrollTop;
    renderContent();
    $content.scrollTop = scroll;
    renderSide();
    renderBatch();
    renderStatus();
  };
  return toggle;
}

/// The fold for the images below the weak cutoff: opened, it fetches and shows them a page at a time.
function hiddenToggle() {
  const toggle = element("button", "weaker-toggle hidden-toggle" + (state.showHidden ? " open" : ""));
  toggle.innerHTML = ICONS.chevron;
  toggle.append(state.showHidden ? "Hidden images"
    : `${state.hiddenTotal.toLocaleString()} hidden ${state.hiddenTotal === 1 ? "image" : "images"}`);
  toggle.onmousedown = (event) => event.preventDefault();
  toggle.onclick = () => {
    state.showHidden = !state.showHidden;
    // The hidden ones folded away take their files out of what's chosen, as the weaker fold does.
    const left = new Set(rows().map((hit) => hit.path));
    for (const path of state.selected) if (!left.has(path)) state.selected.delete(path);
    if (state.anchor && !left.has(state.anchor)) state.anchor = null;
    if (!rows().some((hit) => hit.path === state.selection)) state.selection = rows()[0]?.path ?? null;
    const scroll = $content.scrollTop;
    renderContent();
    $content.scrollTop = scroll;
    renderSide();
    renderBatch();
    renderStatus();
    if (state.showHidden && !state.hidden.length) loadHidden();
  };
  return toggle;
}

/// Fetches the next page of the hidden tail (below the weak cutoff): a search of its own, since the main ranking
/// leaves those images out. They are ranked by cosine as well, so the fold opens from its best image down.
function loadHidden() {
  if (state.loadingHidden || !state.tiered || !state.hasResults || !state.query.trim()) return;
  if (state.hiddenOffset >= state.hiddenTotal) return;
  const generation = state.generation;
  const filter = pageFilter();
  const limit = Math.min(PAGE_SIZE, state.hiddenTotal - state.hiddenOffset);
  const offset = state.hiddenOffset;
  state.loadingHidden = true;
  state.hiddenError = null;
  renderContent();
  ask({ op: "search", q: state.text, code: false, meaning: state.meaning,
        limit, offset,
        ...(filter?.kinds ? { kinds: filter.kinds } : {}),
        ...(filter?.section ? { section: filter.section } : {}),
        by_cosine: true, cosine_ceiling: state.tierCutoffs.weak })
    .then((reply) => {
      if (generation !== state.generation) return;
      const seen = new Set(state.hidden.map((hit) => hit.path));
      state.hidden.push(...(reply.hits || []).filter((hit) => !seen.has(hit.path)));
      state.hiddenOffset = reply.next_offset ?? (offset + (reply.consumed ?? (reply.hits || []).length));
      state.loadingHidden = false;
      renderContent();
      renderSide();
      renderStatus();
      renderBatch();
      refreshGroups();   // the tail can hold look-alikes of its own
    })
    .catch((error) => {
      if (generation !== state.generation) return;
      state.loadingHidden = false;
      state.hiddenError = String(error);
      renderContent();
    });
}

/// Code results, one under another: the file, where in its repo, the lines that matched.
function codeList() {
  const box = element("div", "code-list");
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", "Code results");
  for (const hit of state.ranked) box.append(codeRow(hit));
  if (state.weaker.length) {
    box.append(weakerToggle());
    if (state.showWeaker) for (const hit of state.weaker) box.append(codeRow(hit, true));
  }
  return box;
}

function codeRow(hit, weaker) {
  const item = element("div", "row" + (hit.path === state.selection ? " selected" : "") + (weaker ? " weaker-results" : ""));
  item.dataset.path = hit.path;
  item.setAttribute("role", "option");
  const icon = element("div", "icon");
  icon.innerHTML = ICONS.code;
  const text = element("div", "text");
  const head = element("div", "head");
  head.append(element("span", "title", "‎" + nameOf(hit.path)));
  const place = placeOf(hit);
  if (place) head.append(element("span", "place", place));
  head.append(folderLine(folderOf(hit), "span"));
  text.append(head);
  if (hit.excerpt) {
    const lines = element("div", "lines");
    lines.innerHTML = marked(hit.excerpt);
    text.append(lines);
  }
  item.append(icon, text);
  wire(item, hit);
  return item;
}

/// A result's clicks: one selects it, two open it, the other button offers what to do with the file. The field keeps
/// the keyboard (as on the Mac: ← → move the selection once you've picked a result).
function wire(item, hit) {
  // The keyboard stays with the results after a click, as in a file manager: Del and the F-keys work right away, and
  // the arrows, Space and Enter are answered at the document level, which never looks at the focus. Out of the Tab
  // order (the field is reached by Tab, Ctrl+F or a click).
  item.tabIndex = -1;
  // Dragged out of the window, the file goes along (to a file manager, a mail, a chat). On Linux, WebKit's own drag with
  // the file's address: GTK starts it from the press, as Wayland wants (a drag started later is refused).
  if (isLinux) {
    item.draggable = true;
    item.ondragstart = (event) => {
      const address = "file://" + hit.path.split("/").map(encodeURIComponent).join("/");
      event.dataTransfer.setData("text/uri-list", address);
      event.dataTransfer.setData("text/plain", hit.path);
      event.dataTransfer.effectAllowed = "copy";
    };
  }
  // Elsewhere: pressed and moved a little, the system's drag (which needs the button down).
  item.onmousedown = (event) => {
    if (event.button !== 0 || isLinux) return;
    event.preventDefault();
    const [x, y] = [event.clientX, event.clientY];
    const moved = (move) => {
      if (Math.hypot(move.clientX - x, move.clientY - y) < 6) return;
      done();
      invoke("drag_out", { path: hit.path, icon: item.dataset.thumb || null }).catch(() => {});
    };
    const done = () => {
      window.removeEventListener("mousemove", moved);
      window.removeEventListener("mouseup", done);
    };
    window.addEventListener("mousemove", moved);
    window.addEventListener("mouseup", done);
  };
  item.onclick = (event) => { item.focus({ preventScroll: true }); pick(hit, event); };
  item.ondblclick = () => open(hit);
  item.oncontextmenu = (event) => {
    event.preventDefault();
    // The menu acts on what was clicked — every ticked file when it is one of them, just this file otherwise — and
    // never changes the selection: a right click is how one opens a menu, not how one chooses files.
    select(hit.path);
    const ticked = state.selected.has(hit.path) ? selectedHits() : [];
    const media = isWindows && MEDIA.has(hit.kind);
    const fileTargets = ticked.length ? ticked : media ? [hit] : [];
    const pathTargets = ticked.length ? ticked : [hit];
    const items = [
      ["Open", () => open(hit)],
      [`Show in ${FILE_MANAGER}`, () => reveal(hit)],
      null,
      ["Copy", () => invoke("copy_file", { path: hit.path }).catch(failed)],
      [pathTargets.length > 1 ? "Copy Paths" : "Copy Path", () => copyPaths(pathTargets)],
    ];
    if (hit.kind === "video" && hit.loc != null) {
      // The moment the result matched: the helper renders it at the video's own size, the shell saves or copies it.
      items.push(null,
        [`Save Frame at ${clock(hit.loc)}…`, () => saveFrame(hit.path, "video", hit.loc)],
        ["Copy Frame", () => copyFrame(hit.path, "video", hit.loc)]);
    }
    if (hit.kind === "video") {
      // Two separate things (a sequence of stills, or one contact sheet), both beside the video and neither overwriting.
      items.push(["Extract frames…", () => framesDialog(hit, "sequence")],
                 ["Contact sheet…", () => framesDialog(hit, "sheet")]);
    }
    if (hit.kind === "image" || hit.kind === "screenshot") {
      // The picture itself changes - no edited copy - and Ctrl+Z in the window puts it back.
      items.push(null,
        ["Rotate left", () => rotatePicture(hit, 270)],
        ["Rotate right", () => rotatePicture(hit, 90)],
        ["Flip horizontally", () => rotatePicture(hit, 0, "horizontal")],
        ["Flip vertically", () => rotatePicture(hit, 0, "vertical")],
        ["Crop, resize, format…", () => { state.selection = hit.path; render(); toggleBig(); }]);
    }
    if (MEDIA.has(hit.kind)) items.push(null, ["Find similar", () => findSimilar(hit)]);
    if (fileTargets.length) {
      items.push(null, ["Move To…", () => moveOrCopy("move", fileTargets)],
                 ["Copy To…", () => moveOrCopy("copy", fileTargets)],
                 ["Delete (Recycle Bin)", () => confirmDelete(fileTargets)]);
    }
    showMenu(event.clientX, event.clientY, items);
  };
}

/// "Find similar": the clicked file's own vector becomes the query, ranked by cosine. The field names what the
/// results are; typing anything in it goes back to ordinary searches.
function findSimilar(hit) {
  state.like = hit.path;
  setQuery(`similar: ${nameOf(hit.path)}`);
}

function select(path) {
  state.selection = path;
  state.navigated = true;
  // The results grow without a cap, so a key press must not walk every cell: drop the old mark, set the new one.
  for (const item of $content.querySelectorAll("[data-path].selected")) {
    if (item.dataset.path !== path) item.classList.remove("selected");
  }
  $content.querySelector(`[data-path="${CSS.escape(path)}"]`)?.classList.add("selected");
  syncActiveDescendant();
  // With the keyboard already on the results (Tab, a click, an arrow), the focus follows the cursor, so Del and the
  // F-keys always name the highlighted file.
  const active = document.activeElement;
  if (active instanceof Element && active.closest("[data-path]")) {
    $content.querySelector(`[data-path="${CSS.escape(path)}"]`)?.focus({ preventScroll: true });
  }
  $content.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  renderSide();
  if (!$big.hidden) renderBig();
}

/// The result the field's arrows are on, for a screen reader. The field keeps the keyboard (as on the Mac), so it names
/// the chosen option rather than the option taking focus itself.
function syncActiveDescendant() {
  const list = $content.querySelector('[role="listbox"], [role="grid"]');
  if (!list) {
    $query.removeAttribute("aria-activedescendant");
    $query.removeAttribute("aria-controls");
    return;
  }
  if (!list.id) list.id = "results";
  $query.setAttribute("aria-controls", list.id);
  const option = list.querySelector('[role="option"].selected, [role="row"].selected');
  if (!option) {
    $query.removeAttribute("aria-activedescendant");
    return;
  }
  if (!option.id) option.id = `result-${++resultSeq}`;
  $query.setAttribute("aria-activedescendant", option.id);
}

/// Arrows move through the grid: ↑ ↓ by a row, ← → by one.
function move(step) {
  const shown = rows();
  if (!shown.length) return;
  const index = shown.findIndex((hit) => hit.path === state.selection);
  select(shown[Math.max(0, Math.min(shown.length - 1, (index < 0 ? -1 : index) + step))].path);
}

// MARK: Choosing files

/// The file results on show, once each: what Select All and the ranges go through (the whole list, not the part on
/// screen). Code results aren't among them.
function operable() {
  const seen = new Set();
  return rows().filter((hit) => {
    if (!isWindows || !MEDIA.has(hit.kind) || seen.has(hit.path)) return false;
    seen.add(hit.path);
    return true;
  });
}

/// The chosen results, in the order they're shown (a path chosen and since gone is left out). Folded copies count:
/// an operation on a group acts on all of it, not only on the representative left in sight.
function selectedHits() {
  const known = [...state.ranked, ...(state.showWeaker ? state.weaker : []), ...(state.showHidden ? state.hidden : [])];
  const byPath = new Map(known.map((hit) => [hit.path, hit]));
  return [...state.selected].map((path) => byPath.get(path)).filter(Boolean);
}

/// What Delete works on: the ticked files, or — when nothing is ticked — the one under the cursor, as file managers do.
function deletableHits() {
  const hits = selectedHits();
  if (hits.length) return hits;
  const hit = selectedHit();
  return hit && isWindows && MEDIA.has(hit.kind) ? [hit] : [];
}

/// Puts the keyboard on the results, at the active file (the first one when there is none yet). False when there are
/// no results to point at.
function focusActiveRow() {
  if (!rows().length) return false;
  if (!state.selection) select(rows()[0].path);
  const row = $content.querySelector(`[data-path="${CSS.escape(state.selection)}"]`);
  if (!row) return false;
  row.focus({ preventScroll: true });
  return true;
}

/// The keyboard sits on a result rather than in the search field: Tab puts it there, and the arrows and Space act on it
/// before the first move (the flag `navigated` only rises once something has moved).
function onResult() {
  return document.activeElement instanceof Element && document.activeElement.closest("[data-path]") !== null;
}

function selectedSize(hits) {
  return hits.reduce((sum, hit) => sum + (Number(hit.size) || 0), 0);
}

function clearSelection(paint = true) {
  if (!state.selected.size && state.anchor == null) return;
  state.selected.clear();
  state.anchor = null;
  if (paint) paintSelection();
}

function selectAll() {
  state.selected = new Set(operable().map((hit) => hit.path));
  state.anchor = state.selection;
  paintSelection();
}

function toggleSelected(path) {
  const group = groupingActive() ? groupOf(path) : null;
  if (group && group[0] === path) {
    // The representative is a three-step switch: all → the copies alone (grey tick) → none → all.
    if (state.selected.has(path)) {
      state.selected.delete(path);
    } else if (group.some((member) => state.selected.has(member))) {
      for (const member of group) state.selected.delete(member);
    } else {
      for (const member of group) state.selected.add(member);
      state.anchor = path;
    }
  } else if (state.selected.has(path)) {
    // Off one file only, even for a copy: "keep this one and drop the rest" stays one click.
    state.selected.delete(path);
  } else {
    state.selected.add(path);
    state.anchor = path;
  }
  state.navigated = true;
  paintSelection();
}

/// A representative taken as a whole: its copies come with it. Ticking a copy takes only that copy.
function selectWholeGroup(path) {
  const group = groupingActive() ? groupOf(path) : null;
  if (group && group[0] === path) for (const member of group) state.selected.add(member);
}

/// A click on a result: one picks it (and only it), Ctrl adds or takes it away, Shift takes the range from the last
/// one picked. A document or a piece of code can't be moved, copied or deleted: clicking one clears what was chosen.
/// A click on a result moves the cursor (the blue frame and the side preview) and nothing else: ticking is deliberate —
/// the checkbox, Ctrl/Shift+click, Insert or Ctrl+A — so browsing can't choose a file, or a whole look-alike group, by
/// accident. A document can't be ticked at all.
function pick(hit, event) {
  // Alt+click: let go of this picture's look-alike group, and only it — the fast way out of a whole group being
  // ticked. The badge keeps its one job (folding); an empty group or no grouping leaves the gesture unused.
  if (event.altKey && isWindows && MEDIA.has(hit.kind)) {
    const group = groupingActive() ? groupOf(hit.path) : null;
    if (!group) return;
    let cleared = false;
    for (const path of group) if (state.selected.delete(path)) cleared = true;
    if (cleared) {
      state.anchor = hit.path;
      select(hit.path);
      paintSelection();
    }
    return;
  }
  if (!isWindows || !MEDIA.has(hit.kind)) {
    select(hit.path);
    return;
  }
  const list = operable().map((item) => item.path);
  if (event.shiftKey) {
    if (state.anchor && list.includes(state.anchor) && list.includes(hit.path)) {
      const from = list.indexOf(state.anchor), to = list.indexOf(hit.path);
      if (!event.ctrlKey && !event.metaKey) state.selected.clear();
      for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) state.selected.add(list[index]);
    } else {
      state.selected.add(hit.path);
      selectWholeGroup(hit.path);
      state.anchor = hit.path;
    }
  } else if (event.ctrlKey || event.metaKey) {
    if (state.selected.has(hit.path)) state.selected.delete(hit.path);
    else {
      state.selected.add(hit.path);
      selectWholeGroup(hit.path);
    }
    state.anchor = hit.path;
  } else {
    state.anchor = hit.path;   // where a Shift+click would start from; no file is chosen by it
  }
  select(hit.path);
  paintSelection();
}

/// Shift+arrows: the range from where choosing started to the focus now. `step` counts results, so the caller passes
/// a row's worth of columns in the grid and one in the table.
function extendSelection(step) {
  const list = operable().map((hit) => hit.path);
  if (!list.length) return;
  const at = list.indexOf(state.selection);
  if (at < 0) return;   // the focus is on something that can't be moved: no range to take yet
  const to = Math.max(0, Math.min(list.length - 1, at + step));
  state.anchor = state.anchor && list.includes(state.anchor) ? state.anchor : list[to];
  const from = Math.max(0, list.indexOf(state.anchor));
  state.selected.clear();
  for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) state.selected.add(list[index]);
  select(list[to]);
  paintSelection();
}

/// The chosen files' checkboxes and the panel, without rebuilding the grid (which would lose the scroll place).
function paintSelection() {
  const paint = (item) => {
    const path = item.dataset.path;
    const chosen = state.selected.has(path);
    item.classList.toggle("checked", chosen);
    item.setAttribute("aria-selected", String(chosen));
    const box = item.querySelector(".checkbox");
    if (box) {
      const mixed = mixedChoice(path);
      box.classList.toggle("mixed", mixed);
      box.setAttribute("aria-checked", mixed ? "mixed" : String(chosen));
    }
  };
  // Only the cells whose state can have changed (what was chosen before, and what is now); a big change, or a first
  // paint, goes over all of them. A copy's change can flip its group head's grey tick, so the heads come along.
  const touched = new Set([...(painted ?? []), ...state.selected]);
  if (groupingActive()) {
    for (const path of [...touched]) {
      const group = groupOf(path);
      if (group && group[0] !== path) touched.add(group[0]);
    }
  }
  if (painted && touched.size <= 64) {
    for (const path of touched) {
      const item = $content.querySelector(`[data-path="${CSS.escape(path)}"]`);
      if (item) paint(item);
    }
  } else {
    for (const item of $content.querySelectorAll("[data-path]")) paint(item);
  }
  painted = new Set(state.selected);
  paintGroupBadges();
  renderGroups();
  renderBatch();
  renderSide();
  renderStatus();
}

/// A group's badge says when some of its files are chosen — folded copies included, so a hidden selection is visible.
function paintGroupBadges() {
  for (const badge of $content.querySelectorAll(".group-badge")) {
    const group = groupOf(badge.dataset.group);
    if (group) decorateGroupBadge(badge, group);
  }
}

function copyPaths(chosen = null) {
  const hits = chosen ?? selectedHits();
  const paths = hits.length ? hits.map((hit) => hit.path) : [state.selection].filter(Boolean);
  if (!paths.length) return;
  navigator.clipboard.writeText(paths.join("\n"))
    .then(() => setNote(paths.length === 1 ? "Copied the path" : `Copied ${paths.length.toLocaleString()} paths`))
    .catch((error) => failed(`The paths couldn't be copied: ${error}`));
}

/// One file alone isn't worth a panel (DigUp handles it faster): two is the smallest list.
const TC_MIN = 2;

/// The results in Total Commander's panel: the chosen ones, or the ones shown when nothing is chosen; `every` asks the
/// helper for the whole ranking of this search instead (loaded or not, the Images filter's hidden layer included), in
/// the order the window shows them. The panel holds the real files, so operations there are the usual ones and the
/// watcher takes the changes.
async function toTotalCommander(every) {
  if (!state.tc || !state.query.trim()) return;
  let paths;
  if (!every) {
    const chosen = selectedHits();
    paths = (chosen.length ? chosen : rows()).map((hit) => hit.path);
  } else {
    setNote("Collecting the results…");
    const filter = pageFilter();
    try {
      const reply = await ask({ op: "search", q: state.text, code: isCode(),
                                meaning: state.meaning,
                                limit: 20000,
                                ...(state.like && !isCode() ? { like: state.like } : {}),
                                ...(filter?.kinds ? { kinds: filter.kinds } : {}),
                                ...(filter?.section ? { section: filter.section } : {}),
                                // The panel shows the Images layers by cosine: the whole ranking, hidden tail too.
                                ...(state.tiered && !isCode() ? { by_cosine: true } : {}) });
      paths = sortedHits(reply.hits || []).map((hit) => hit.path);
    } catch (error) {
      failed(`The results couldn't be collected: ${error}`);
      return;
    }
  }
  if (paths.length < TC_MIN) {
    setNote("One file is quicker to handle here.");
    return;
  }
  try {
    const answer = await invoke("open_in_totalcmd", { paths });
    setNote(answer.opened === answer.total
      ? `Opened ${answer.opened.toLocaleString()} in Total Commander`
      : answer.capped ? `Opened the first ${answer.opened.toLocaleString()} of ${answer.total.toLocaleString()}`
      : `Opened ${answer.opened.toLocaleString()} of ${answer.total.toLocaleString()}: the rest are gone`);
  } catch (error) {
    failed(error);
  }
}

/// All · Media 14 · Screenshots 4 · …: the media count is the four kinds together.
/// The chips' numbers from a list of strong results: the fallback for a helper that doesn't send kind counts.
function countsOf(hits) {
  if (isCode()) return { code: hits.length };
  const counts = {};
  for (const hit of hits) {
    const key = FILTER_OF_KIND[hit.kind];
    if (key) counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/// The chips' numbers for the whole query: the helper's `section_totals` — how many files each filter's list holds,
/// one definition per filter, the same on every request, so switching filters can't rewrite them. A helper too old for
/// them gets its kind totals; the first versions' fallback is this page's strong hits.
function countsOfReply(reply, strongHits) {
  const sections = reply?.section_totals;
  if (sections && typeof sections === "object" && Object.keys(sections).length) {
    const counts = { code: Number(sections.all) || 0 };
    for (const key of ["images", "documents", "ocr", "video", "audio"]) {
      counts[key] = Number(sections[key]) || 0;
    }
    return counts;
  }
  const totals = reply?.kind_totals;
  const kinds = totals && Object.keys(totals).length ? totals : reply?.kind_counts;
  if (!kinds || typeof kinds !== "object" || !Object.keys(kinds).length) return countsOf(strongHits);
  if (isCode()) return { code: Number(kinds.code) || 0 };
  const counts = {};
  for (const [kind, count] of Object.entries(kinds)) {
    const key = FILTER_OF_KIND[kind];
    if (key) counts[key] = (counts[key] || 0) + (Number(count) || 0);
  }
  return counts;
}

// MARK: Moving, copying and deleting

let operationNumber = 0;   // the window's number for its operations, which cancel and the events go by
let operationView = null;  // the sheet's bar, line and Cancel while an operation runs
let sheetReturn = null;    // the control a sheet gives the keyboard back to, if it came from one
let operationSheet = null; // the timer that shows the sheet only if the work takes a moment
let noteTimer = null;

/// The bar between the results and the status bar: how much is chosen and what can be done with it.
function renderBatch() {
  const items = operable();
  // The bar is also Total Commander's when the results hold no files at all (a code search): its actions are the only
  // ones there.
  const tc = Boolean(state.tc) && rows().length > 0;
  $batch.hidden = !items.length && !tc;
  if ($batch.hidden) return;
  const chosen = selectedHits();
  $batchSummary.textContent = chosen.length
    ? `${chosen.length.toLocaleString()} selected · ${bytes(selectedSize(chosen))}`
    : items.length ? "Select files to copy, move, or delete · F5 copy · F6 move · F8 delete"
    : "Open these results in Total Commander";
  const any = chosen.length > 0;
  $batchToggle.hidden = !items.length;
  $batchToggle.textContent = any ? "Deselect All" : "Select All";
  $batchToggle.title = any ? "Deselect All (Ctrl+Shift+A)" : "Select All (Ctrl+A)";
  $batchToggle.setAttribute("aria-keyshortcuts", any ? "Control+Shift+A" : "Control+A");
  for (const id of ["batch-paths", "batch-copy", "batch-move", "batch-delete"]) {
    $(id).hidden = !items.length;
    $(id).disabled = !chosen.length;
  }
  $("batch-file-divider").hidden = !items.length;
  $("batch-tc-divider").hidden = !tc;
  for (const id of ["batch-tc", "batch-tc-all"]) {
    $(id).hidden = !tc;
    $(id).disabled = !tc;
  }
}

/// What `file_operation` takes: the size and date the search knew, so a file that changed since then is left alone.
function chosenItems(files) {
  return files.map((hit) => ({ path: hit.path, size: hit.size ?? null, mtime: hit.modified ?? null }));
}

/// Whether Settings asks first for this operation (`operation_confirmations`); asking is the safe way when it can't
/// be read.
async function asksFirst(kind) {
  try {
    const answer = await invoke("operation_confirmations");
    return kind === "delete" ? answer.delete !== false : answer.moveCopy !== false;
  } catch {
    return true;
  }
}

/// The names in `destination` that are taken (they'd get a number): the sheet says so only when there are any.
async function destinationConflicts(destination, files) {
  try {
    const answer = await invoke("destination_conflicts", {
      destination,
      paths: files.map((file) => file.path),
    });
    return { count: Number(answer.count) || 0, example: answer.example || null };
  } catch {
    return { count: 0, example: null };
  }
}

/// One picker or sheet at a time: the picker and the confirmations are awaited.
let choosing = false;

/// Move To… / Copy To…: the folder (the system's picker), then, for several files, a sheet saying what will happen.
async function moveOrCopy(kind, chosen = null) {
  const files = chosen ?? selectedHits();
  if (!isWindows || !files.length || state.busy || !$modal.hidden || choosing) return;
  choosing = true;
  try {
    let destination = null;
    try {
      destination = await invoke("pick_destination_folder", {
        title: kind === "move" ? "Move to Folder" : "Copy to Folder",
      });
    } catch (error) {
      failed(error);
      return;
    }
    if (!destination) return;
    // One file (the folder was the choice), or Settings turned the question off: the work starts now.
    if (files.length === 1 || !(await asksFirst(kind))) {
      operate(kind, destination, files);
      return;
    }
    const conflicts = await destinationConflicts(destination, files);
    const box = element("div", "modal-box");
    box.append(element("h2", "", `${kind === "move" ? "Move" : "Copy"} ${countOf(files.length, "file")}?`));
    box.append(element("div", "modal-path", destination));
    const taken = conflicts.count
      ? ` · ${countOf(conflicts.count, "name")} ${conflicts.count === 1 ? "is" : "are"} already there: `
        + `${conflicts.count === 1 ? "it gets" : "they get"} a number`
        + (conflicts.example ? ` (${conflicts.example})` : "") + "."
      : " · nothing is overwritten.";
    box.append(element("p", "", bytes(selectedSize(files)) + taken));
    const actions = element("div", "modal-actions");
    const cancel = element("button", "", "Cancel");
    cancel.onclick = closeModal;
    const go = element("button", "primary", kind === "move" ? "Move" : "Copy");
    go.onclick = () => operate(kind, destination, files);
    actions.append(cancel, go);
    box.append(actions);
    showModal(box);
  } finally {
    choosing = false;
  }
}

/// Delete: to the Recycle Bin, with this sheet in between unless Settings turned the question off.
async function confirmDelete(chosen = null) {
  const files = chosen ?? deletableHits();
  if (!isWindows || !files.length || state.busy || !$modal.hidden || choosing) return;
  choosing = true;
  try {
    if (!(await asksFirst("delete"))) {
      operate("delete", null, files);
      return;
    }
    const box = element("div", "modal-box");
    box.append(element("h2", "", `Move ${files.length === 1 ? "this file" : `${files.length} files`} to the Recycle Bin?`));
    box.append(element("p", "", `${bytes(selectedSize(files))}. You can put ${files.length === 1 ? "it" : "them"} back `
      + `from the Recycle Bin. A file too large for it may be deleted for good instead; Windows asks before that.`));
    // A group taken whole goes as a whole, folded copies included: say so, so a series is not deleted unaware.
    const byGroup = new Map();
    for (const hit of files) {
      const group = groupOf(hit.path);
      if (group) byGroup.set(group[0], (byGroup.get(group[0]) ?? 0) + 1);
    }
    const whole = [...byGroup.values()].filter((count) => count > 1).length;
    if (whole) {
      box.append(element("p", "", `${whole === 1 ? "One of them is a group" : `${whole} of them are groups`} of `
        + `look-alikes taken whole: every copy in ${whole === 1 ? "it" : "them"} goes as well.`));
    }
    const actions = element("div", "modal-actions");
    const cancel = element("button", "", "Cancel");
    cancel.onclick = closeModal;
    const go = element("button", "danger", "Move to Recycle Bin");
    go.setAttribute("data-default", "");   // Enter confirms: the Recycle Bin is reversible
    go.onclick = () => operate("delete", null, files);
    actions.append(cancel, go);
    box.append(actions);
    showModal(box);
  } finally {
    choosing = false;
  }
}

/// The second, explicit action after the Recycle Bin refused paths that are too long. It shows the scope by folder,
/// not thousands of names; the report behind it keeps the full list. The first button is Keep, so Enter is the safe way
/// out and Escape closes the sheet.
function confirmPermanent(files) {
  if (!isWindows || !files.length || state.busy || !$modal.hidden) return;
  const box = element("div", "modal-box");
  box.append(element("h2", "", `Delete ${countOf(files.length, "file")} permanently?`));
  const lengths = files.map((item) => item.from.length);
  const shortest = lengths.reduce((least, length) => Math.min(least, length), Infinity);
  const longest = lengths.reduce((most, length) => Math.max(most, length), 0);
  box.append(element("p", "", `${bytes(selectedSize(files))}. ${files.length === 1 ? "Its path is" : "Their paths are"} `
    + `${shortest === longest ? `${longest} characters` : `${shortest}–${longest} characters`}; the Recycle Bin limit is 260.`));
  const groups = new Map();
  for (const item of files) {
    const folder = folderOf({ path: item.from });
    groups.set(folder, (groups.get(folder) || 0) + 1);
  }
  const sorted = [...groups].sort((left, right) => right[1] - left[1]);
  for (const [folder, count] of sorted.slice(0, 5)) {
    box.append(element("div", "modal-path", `${folder} — ${countOf(count, "file")}`));
  }
  if (sorted.length > 5) box.append(element("p", "", `and ${sorted.length - 5} more folders.`));
  box.append(element("p", "", "Permanent deletion cannot be undone. The full list stays in the report below."));
  const actions = element("div", "modal-actions");
  const keep = element("button", "", "Keep Files");
  keep.setAttribute("data-default", "");   // the safe way out stays Enter's: this deletion cannot be undone
  keep.onclick = closeModal;
  const go = element("button", "danger", `Delete ${countOf(files.length, "file")} Permanently`);
  go.onclick = () => operate("delete_permanent", null,
    files.map((item) => ({ path: item.from, size: item.size ?? null, modified: item.mtime ?? null })));
  actions.append(keep, go);
  box.append(actions);
  showModal(box);
}

function countOf(count, one) {
  return `${count.toLocaleString()} ${count === 1 ? one : `${one}s`}`;
}

async function operate(kind, destination, files) {
  if (state.busy || !files.length) return;
  closeHover(true);   // the player holds the file open: a move, copy or delete of it must not meet that handle
  hideReport();   // this operation's report replaces the last one's
  const id = ++operationNumber;
  state.busy = { id, kind, done: 0, total: files.length, path: null, destination, bytes: null, size: null };
  // A single quick file shouldn't flash a sheet; a copy that takes a while gets its bar and Cancel.
  operationSheet = setTimeout(() => {
    operationSheet = null;
    if (state.busy?.id !== id) return;
    showModal(operationBox());
    renderOperation();
  }, 300);
  try {
    const report = await invoke("file_operation", {
      request: { kind, id, destination, items: chosenItems(files) },
    });
    finishOperation(report);
  } catch (error) {
    clearTimeout(operationSheet);
    operationSheet = null;
    state.busy = null;
    operationView = null;
    hideModal();
    failed(error);
  }
}

function operationBox() {
  const { kind, total, destination } = state.busy;
  const box = element("div", "modal-box");
  box.append(element("h2", "", `${verbOf(kind)} ${countOf(total, "file")}…`));
  if (destination) box.append(element("div", "modal-path", destination));
  const bar = element("div", "modal-progress");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", "Progress");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", "0");
  const fill = element("span");
  bar.append(fill);
  const line = element("div", "modal-line", `0 of ${total.toLocaleString()}`);
  const cancel = element("button", "", "Cancel");
  cancel.onclick = cancelOperation;
  const actions = element("div", "modal-actions");
  actions.append(cancel);
  box.append(bar, line, actions);
  operationView = { bar, fill, line, cancel };
  return box;
}

function renderOperation() {
  if (!state.busy || !operationView) return;
  const { done, total, path, bytes, size } = state.busy;
  const shown = Math.min(done, total);
  // A copy reports the file it's in by the byte, so the bar moves through a big one too.
  const partial = bytes != null && size ? Math.min(bytes / size, 1) : 0;
  const fraction = total ? Math.min((shown + partial) / total, 1) : 0;
  const percent = Math.round(fraction * 100);
  const text = `${shown.toLocaleString()} of ${total.toLocaleString()}`
    + (path ? ` — ${nameOf(path)}` : "") + (partial > 0 && partial < 1 ? ` (${Math.round(partial * 100)}%)` : "");
  operationView.fill.style.width = `${percent}%`;
  operationView.line.textContent = text;
  operationView.bar.setAttribute("aria-valuenow", String(percent));
  operationView.bar.setAttribute("aria-valuetext", text);
}

function cancelOperation() {
  if (!state.busy || !operationView || operationView.cancel.disabled) return;
  invoke("cancel_file_operation", { id: state.busy.id }).catch(() => {});
  operationView.cancel.disabled = true;
  operationView.cancel.textContent = "Cancelling…";
}

function verbOf(kind) {
  return kind === "move" ? "Moving" : kind === "copy" ? "Copying"
    : kind === "delete_permanent" ? "Deleting permanently" : "Moving to the Recycle Bin";
}

function finishOperation(report) {
  clearTimeout(operationSheet);
  operationSheet = null;
  const files = report.items.filter((item) => item.ok);
  state.busy = null;
  operationView = null;
  if (report.kind === "copy") {
    clearSelection();
    renderBatch();
  } else {
    // The rows of the files that left are gone; the ones that failed or were skipped stay, and stay chosen, so they can
    // be tried again.
    forget(files.map((item) => item.from), report.items.filter((item) => !item.ok).map((item) => item.from));
  }
  hideModal();
  renderReport(report);
  setNote(operationNote(report));
}

/// Moved 10 files · 2 renamed · 1 failed (or Stopped: moved 4 of 12).
function operationNote(report) {
  const verb = report.kind === "move" ? "Moved" : report.kind === "copy" ? "Copied"
    : report.kind === "delete_permanent" ? "Permanently deleted" : "Moved";
  let text = report.cancelled ? `Stopped: ${verb.toLowerCase()} ${report.done} of ${report.total}`
    : `${verb} ${countOf(report.done, "file")}`;
  if (report.kind === "delete") text += " to the Recycle Bin (or for good, if one was too large for it)";
  if (report.renamed) text += ` · ${report.renamed} renamed`;
  if (report.failed) text += ` · ${report.failed} failed`;
  if (report.skipped) text += ` · ${report.skipped} skipped`;
  if (report.index === false) text += " · index update failed; resyncing";
  return text;
}

/// How many lines of a list show before "Show all": a batch of thousands opens on its summary, not on a screen of
/// names, and the full list is one click away.
const REPORT_SHOWN = 8;

/// What happened, under the results rather than in a sheet: renamed names and files that didn't go stay here until the
/// next operation, without a click to put them away. A clean operation has only the status bar's line.
function renderReport(report) {
  const renamed = report.items.filter((item) => item.ok && item.renamed);
  const problems = report.items.filter((item) => !item.ok);
  const failedIndex = report.index === false;
  if (!renamed.length && !problems.length && !failedIndex) {
    hideReport();
    return;
  }
  $report.replaceChildren();
  $report.append(element("div", "report-head", operationNote(report)));
  if (failedIndex) {
    $report.append(element("div", "report-why",
      "The index couldn't follow the files that changed; DigUp Plus is rescanning your folders."));
  }
  if (renamed.length) {
    $report.append(element("div", "report-label", "Renamed"),
      element("div", "report-why", "The names were taken, so DigUp Plus added a number."));
    $report.append(reportList(renamed, (item) =>
      element("li", "name", `${nameOf(item.from)} → ${nameOf(item.to)}`)));
  }
  if (problems.length) {
    $report.append(element("div", "report-label", "Not done"));
    $report.append(reportList(problems, (item) => {
      const line = element("li");
      line.append(element("div", "name", nameOf(item.from)), element("div", "why", item.error || "it wasn't done"));
      return line;
    }));
  }
  const permanent = problems.filter((item) => item.reason === "path_too_long");
  if (permanent.length) {
    const retry = element("button", "report-more",
      `Delete ${countOf(permanent.length, "file")} Permanently…`);
    retry.onclick = () => confirmPermanent(permanent);
    $report.append(retry);
  }
  $report.hidden = false;
}

/// A report's list: the first few lines, and "Show all" for a batch too big to read at a glance. The full list is made
/// once, on the click, so a move of thousands doesn't put thousands of rows on the page for nothing.
function reportList(items, line) {
  const list = element("ul", "report-list");
  const fill = (count) => {
    for (const item of items.slice(list.childElementCount, count)) list.append(line(item));
  };
  fill(REPORT_SHOWN);
  if (items.length <= REPORT_SHOWN) return list;
  const wrap = element("div");
  const more = element("button", "report-more", `Show all ${items.length.toLocaleString()}`);
  let shown = REPORT_SHOWN;
  const CHUNK = 500;
  more.onclick = () => {
    // A batch of thousands is appended a few hundred at a time, so the click doesn't build the whole list in one task.
    shown = Math.min(items.length, shown + CHUNK);
    fill(shown);
    $report.classList.add("expanded");
    if (shown === items.length) more.remove();
    else more.textContent = `Show ${Math.min(CHUNK, items.length - shown).toLocaleString()} more`;
  };
  wrap.append(list, more);
  return wrap;
}

/// Puts the last operation's details away: a new search or operation starts clean.
function hideReport() {
  $report.hidden = true;
  $report.classList.remove("expanded");
  $report.replaceChildren();
}

/// Takes the files that moved or were deleted out of the results: their rows, the chips' numbers, the selection. The
/// place on screen stays where it was.
function forget(paths, stay = []) {
  if (!paths.length) return;
  const gone = new Set(paths);
  const before = rows();
  const at = before.findIndex((hit) => hit.path === state.selection);
  const scroll = $content.scrollTop;
  const goneStrong = state.ranked.filter((hit) => gone.has(hit.path)).length;
  const goneHidden = state.hidden.filter((hit) => gone.has(hit.path)).length;
  // Only rows this list actually has are in its ranking: a path that was already missing from the index (or outside
  // the filter) must not make the totals and the next offset count a file that was never there.
  const goneHits = new Map();
  for (const hit of [...state.ranked, ...state.weaker, ...state.hidden]) {
    if (gone.has(hit.path)) goneHits.set(hit.path, hit);
  }
  const removed = goneHits.size;
  // The engine's ranking shrinks by the rows the operation removed; the next page starts that much earlier. The
  // hidden fold's own count shrinks too.
  state.total = Math.max(0, state.total - removed);
  state.strongTotal = Math.max(0, state.strongTotal - goneStrong);
  state.hiddenTotal = Math.max(0, state.hiddenTotal - goneHidden);
  state.nextOffset = Math.max(0, state.nextOffset - removed);
  // The chips count the whole query: take the files that left out of their kind's number. Files still below the
  // loaded pages stay counted until a later page or a new search brings them.
  for (const hit of goneHits.values()) {
    const key = hit.kind === "code" ? "code" : FILTER_OF_KIND[hit.kind];
    if (key) state.counts[key] = Math.max(0, (state.counts[key] || 0) - 1);
  }
  const keep = (hit) => !gone.has(hit.path);
  state.ranked = state.ranked.filter(keep);
  state.weaker = state.weaker.filter(keep);
  state.hidden = state.hidden.filter(keep);
  // A group loses what the operation took; one left with a single picture isn't a group any more.
  if (state.groups) {
    const left = new Set([...state.ranked, ...state.weaker, ...state.hidden].map((hit) => hit.path));
    state.groups = state.groups.map((group) => group.filter((path) => left.has(path)))
      .filter((group) => group.length > 1);
    state.groupsByPath = new Map();
    for (const group of state.groups) for (const path of group) state.groupsByPath.set(path, group);
  }
  const after = rows();
  state.selected = new Set(stay.filter((path) => after.some((hit) => hit.path === path)));
  state.anchor = stay[stay.length - 1] ?? null;
  state.selection = state.selection && !gone.has(state.selection) ? state.selection
    : after[Math.min(Math.max(at, 0), after.length - 1)]?.path ?? null;
  renderBar();
  renderContent();
  $content.scrollTop = scroll;
  renderSide();
  renderStatus();
  renderBatch();
  renderPagination();
  if (!$big.hidden) renderBig();
  // The operation's own reload bumped the engine's generation. The totals and the offset above are already corrected
  // by exactly this operation's rows, and the next page's `seen` keeps it from repeating any: so the next page
  // accepts the new generation instead of restarting the whole query and throwing the person back to the first page.
  state.matchesGeneration = null;
}

/// For a moment after an operation, the status bar's right side says what happened.
function setNote(text) {
  announce(text);
  state.note = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    state.note = null;
    renderStatus();
  }, 10000);
  renderStatus();
}

/// Says a line once, for a screen reader: the status bar's note, an error. Empty first, so the same line twice is a
/// change again.
function announce(text) {
  $announce.textContent = "";
  requestAnimationFrame(() => { $announce.textContent = text; });
}

// MARK: Sheets

function showModal(box) {
  state.sheet = true;
  // Where the keyboard goes back to: a button in the report or the bar the sheet was opened from. The field is its home
  // anyway, and the option it points at keeps its place.
  if ($modal.hidden) {
    const at = document.activeElement;
    sheetReturn = at instanceof HTMLElement && at !== document.body && at !== $query ? at : null;
  }
  const title = box.querySelector("h2");
  if (title) title.id = "modal-title";
  $modal.replaceChildren(box);
  $modal.hidden = false;
  // The keyboard lands on the sheet's intended button (marked `data-default`, or the primary one), not on the first
  // in the row: Enter then confirms the action the sheet is about, Escape always puts it away.
  (box.querySelector("button.primary") ?? box.querySelector("[data-default]") ?? box.querySelector("button"))
    ?.focus({ preventScroll: true });
}

function hideModal() {
  const back = sheetReturn;
  sheetReturn = null;
  $modal.hidden = true;
  $modal.replaceChildren();
  state.sheet = false;
  // Once the caller has put the report back: its button may have been replaced under the sheet. A gone control
  // means the operation rebuilt the list — the keyboard stays with the results (Del works again), and only with
  // nothing to point at does it go back to the field.
  requestAnimationFrame(() => {
    if (back?.isConnected) back.focus({ preventScroll: true });
    else {
      const row = state.selection && $content.querySelector(`[data-path="${CSS.escape(state.selection)}"]`);
      (row ?? $query).focus({ preventScroll: true });
    }
  });
}

function closeModal() {
  if (state.busy) return;   // an operation under way closes its own sheet, with what happened
  hideModal();
}

/// The grid's columns right now (↑ ↓ move by a row); a list has one.
function columns() {
  const grid = $content.querySelector(".grid");
  return grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 1;
}

function open(hit) {
  openResult(hit).catch(failed);
}

function reveal(hit) {
  invoke("reveal", { path: hit.path }).catch(failed);
}

function failed(error) {
  announce(String(error));
  state.error = String(error);
  renderStatus();
}

// MARK: What shows instead of results

/// Nothing typed yet: the app's mark, a pointer to the field above, examples to click (each with the kind it finds),
/// what's indexed, and the shortcut. A click anywhere else puts the cursor in the field.
function home() {
  const box = element("div", "center home");
  const examples = element("div", "examples");
  const shown = [...EXAMPLES, ...(state.info.hasCode ? [["code: where the settings are saved", "code"]] : [])];
  for (const [text, kind] of shown) {
    const example = element("button", "example");
    example.innerHTML = ICONS[FILTERS.find((filter) => filter.key === kind)?.icon ?? kind];
    example.append(text);
    example.title = `Search for “${text}”`;
    example.onmousedown = (event) => event.preventDefault();
    example.onclick = () => setQuery(text);
    examples.append(example);
  }
  box.append(brandMark(), element("h1", "", "Describe it. Dig it up."),
             element("p", "", "Type what you remember in the search field above: what's in it, what it looks or sounds "
                     + "like, or words from it."),
             element("div", "try", "TRY"), examples, about());
  box.onmousedown = (event) => { if (!event.target.closest("button")) event.preventDefault(); };
  box.onclick = (event) => { if (!event.target.closest("button")) $query.focus(); };
  return box;
}

/// What's in the index ("104 pictures, 25 PDFs… in Pictures and Documents") and the shortcut.
function about() {
  const box = element("div", "about");
  // Pictures are one count for the home: the index still has image/screenshot kinds, but the user sees Images and OCR
  // as the two results, not kinds.
  const indexed = state.indexed && { ...state.indexed,
    pictures: (state.indexed.image || 0) + (state.indexed.screenshot || 0) };
  const kinds = indexed && KIND_ORDER.filter((kind) => indexed[kind] > 0);
  if (kinds?.length) {
    const line = element("div", "line");
    const counts = element("div", "kind-counts");
    for (const kind of kinds) {
      const item = element("span");
      item.innerHTML = ICONS[kind === "pictures" ? "image" : kind];
      item.append(indexed[kind].toLocaleString());
      counts.append(item);
    }
    counts.title = kinds.map((kind) => counted(kind, indexed[kind])).join(", ");
    line.append(counts, element("span", "", `in ${folderNames()}`));
    box.append(line);
  } else if (state.app.searchable > 0) {
    box.append(element("div", "line", `${state.app.searchable.toLocaleString()} files to search in ${folderNames()}`));
  }
  if (state.info.hotkey) {
    const line = element("div", "line");
    const caps = element("span", "keycaps");
    for (const key of keysOf(state.info.hotkey)) caps.append(element("span", "keycap", key));
    line.append(caps, element("span", "", "opens DigUp Plus from any app"));
    box.append(line);
  }
  return box;
}

/// "1 screenshot", "25 PDFs", "6 audio files"
function counted(kind, count) {
  const [one, many] = COUNTED[kind] || ["file", "files"];
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/// "Pictures, Documents and Videos", or "5 folders".
function folderNames() {
  const names = state.info.folders.map((folder) => folder.split(/[\\/]/).filter(Boolean).pop() || folder);
  return names.length <= 3 ? new Intl.ListFormat("en", { type: "conjunction" }).format(names) : `${names.length} folders`;
}

/// "Ctrl+Shift+Space" as keys; a Mac's "⇧⌘Space" too.
function keysOf(hotkey) {
  if (hotkey.includes("+")) return hotkey.split("+").filter(Boolean);
  const signs = [...hotkey.replace(/[^⌃⌥⇧⌘]/g, "")];
  return [...signs, hotkey.replace(/[⌃⌥⇧⌘]/g, "")].filter(Boolean);
}

function brandMark() {
  const mark = element("div", "mark");
  const icon = element("img");
  icon.src = "icon.png";
  icon.alt = "";
  mark.append(icon);
  return mark;
}

function chooseFolders() {
  const button = element("button", "button primary", "Choose Folders…");
  button.onclick = () => invoke("choose_folders").catch(failed);
  return centered(brandMark(), element("h2", "", "Choose folders to search"),
                  element("p", "", "DigUp Plus only looks where you tell it to."), button);
}

function nothingFound() {
  const icon = element("div", "quiet-icon");
  icon.innerHTML = isCode() ? ICONS.code : SEARCH_ICON;
  // The window opens on Images: when that filter has nothing but other views do, say where the results went.
  const elsewhere = FILTERS.filter((f) => f.key !== state.filter && (state.counts[f.key] || 0) > 0);
  const parts = [icon, element("h3", "", `No good matches for “${state.query.trim()}”`),
                 element("p", "", isCode() ? "Try saying what the code does, or a name that's in it."
                   : "Try describing what's in it: what you'd see or hear, or words you remember.")];
  if (!isCode() && elsewhere.length) {
    const line = element("p", "", "Nothing in this filter — the other views have:");
    for (const filter of elsewhere) {
      const button = element("button", "chip", `${filter.title} · ${(state.counts[filter.key] || 0).toLocaleString()}`);
      button.onclick = () => setFilter(filter.key);
      line.append(button);
    }
    parts.push(line);
  }
  return centered(...parts);
}

/// "code:" with nothing after it (what to type), or without code folders (what code search is).
function codeHintOrOff() {
  const icon = element("div", "brand-icon");
  icon.innerHTML = ICONS.code;
  if (state.codePhase === "off") {
    const actions = element("div", "actions");
    const choose = element("button", "primary", "Choose Code Folders…");
    choose.onclick = () => invoke("choose_code_folders").catch(failed);
    actions.append(choose);
    return centered(icon, element("h3", "", "Code search is off"),
                    element("p", "", "DigUp Plus can find code by what it does, in folders you choose for it. Code gets an "
                            + "index of its own and never shows up in other searches."), actions);
  }
  return centered(icon, element("h3", "", "Search your code"),
                  element("p", "", "Say what the code does, or type a name that's in it."));
}

function centered(...children) {
  const box = element("div", "center");
  box.append(...children);
  return box;
}

// MARK: The preview pane

let playing = null;   // the audio of the selected result, while it plays

function renderSide() {
  stopPlaying();
  const shown = state.hasResults && !state.codePhase && state.query.trim();
  const hit = shown ? selectedHit() : null;
  $side.hidden = !state.showsPreview || !hit;
  $splitter.hidden = $side.hidden;
  $side.replaceChildren();
  if (!hit) return;
  $side.append(previewPicture(hit), facts(hit));
  // The words OCR read on the picture (or the scanned page), under the facts: open in the OCR filter, behind a
  // one-line "show" everywhere else. Nothing for a file whose folder didn't ask for them.
  const words = ocrBlock(hit, state.filter === "ocr");
  if (words) $side.append(words);
  const chosen = shown && isWindows ? selectedHits() : [];
  if (chosen.length > 1) $side.append(selectionSummary(chosen));
  $side.append(why(hit), actions(hit));
  fitPreview();
}

/// The picture takes the room the facts and actions leave. Its max-height is set in pixels: a percentage of the frame's
/// own, content-sized height wouldn't limit it (the picture would be clipped by the frame).
function fitPreview() {
  const box = $side.querySelector(".preview-picture");
  if (!box || !$side.clientHeight) return;
  box.style.setProperty("--preview-height", `${box.clientHeight}px`);
}

// A taller or shorter window, or the pane hidden and shown again, gives the picture a different room.
new ResizeObserver(fitPreview).observe($side);

/// Several files chosen: under the active one's facts, how many, how much, and of what kinds. The files themselves
/// are ticked in the results, so the pane keeps showing the one being looked at.
function selectionSummary(hits) {
  const box = element("div", "selection-summary");
  const head = element("div", "selection-head");
  head.append(element("strong", "", `${hits.length} files`), element("span", "", bytes(selectedSize(hits))));
  const counts = new Map();
  for (const hit of hits) counts.set(hit.kind, (counts.get(hit.kind) || 0) + 1);
  const kinds = [...counts].sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]))
    .map(([kind, count]) => countOf(count, COUNTED[kind]?.[0] || "file"));
  box.append(head, element("div", "selection-kinds", kinds.join(" · ")));
  return box;
}

/// The big picture: the photo or screenshot, the frame at the moment (it plays from there), the page, the moment in a
/// recording, the passage that matched, or the lines of code.
function previewPicture(hit) {
  const box = element("div", "preview-picture");
  if (hit.kind === "audio") {
    // Read by its tags: nothing was listened to, so there is no moment to play from — the tags are the preview.
    if (hit.info?.tags === "1") {
      box.append(audioTagsCard(hit));
      return box;
    }
    box.append(audioMoment(hit));
    box.style.height = "150px";
    box.style.flex = "none";
    return box;
  }
  if (hit.kind === "code") {
    box.append(codeLines(hit));
    addPlace(box, span(hit));
    return box;
  }
  if (hit.segment === "chunk") {
    box.append(passage(hit));
    const parts = Number(hit.info?.chunks || 0);
    if (hit.loc != null && parts > 1) addPlace(box, `Part ${Math.trunc(hit.loc)} of ${parts}`);
    return box;
  }
  const what = renderOf(hit);
  if (!what) {
    const placeholder = element("div", "placeholder");
    placeholder.innerHTML = ICONS[hit.kind] || ICONS.doc;
    placeholder.ondblclick = () => open(hit);
    box.append(placeholder);
    return box;
  }
  const frame = element("div", "frame");
  const image = element("img");
  image.alt = "";
  frame.append(image);
  // The cell's picture first (already drawn), then the bigger one.
  const small = renders.get(`${hit.path}|${what[0]}|${what[1]}|${Math.round(240 * (window.devicePixelRatio || 1))}`);
  small?.then((file) => { if (!image.dataset.big) image.src = fileURL(file); }).catch(() => {});
  rendered(hit.path, what[0], what[1], Math.round(460 * (window.devicePixelRatio || 1)))
    .then((file) => { image.dataset.big = "1"; image.src = fileURL(file); })
    .catch(() => {});
  image.ondblclick = () => open(hit);
  const place = placeOf(hit);
  if (place) {
    const marks = element("div", "marks" + (hit.kind === "video" ? " dim" : ""));
    marks.append(element("span", "place on-image", place));
    const duration = Number(hit.info?.duration || 0);
    if (hit.kind === "video" && hit.loc != null && duration > 0) {
      marks.append(momentBar(hit.loc, hit.loc_end ?? hit.loc + 3, duration));
    }
    frame.append(marks);
  }
  if (hit.kind === "video") {
    // The matched frame is worth keeping before playing too: the button saves the moment, and ▶ plays from it.
    const wrap = element("div", "video-preview");
    const actions = element("div", "media-actions");
    const save = element("button", "", "Save frame");
    save.title = `Save the frame at ${clock(hit.loc ?? 0)}`;
    save.onclick = () => saveFrame(hit.path, "video", hit.loc ?? 0);
    const frames = element("button", "", "Frames…");
    frames.title = "Stills from this video, as JPEGs in a folder beside it";
    frames.onclick = () => framesDialog(hit, "sequence");
    const sheet = element("button", "", "Sheet…");
    sheet.title = "One contact sheet of this video's stills";
    sheet.onclick = () => framesDialog(hit, "sheet");
    actions.append(save, frames, sheet);
    const play = element("button", "play");
    play.innerHTML = ICONS.play;
    play.title = `Play from ${clock(hit.loc ?? 0)}`;
    play.onclick = () => {
      const video = element("video");
      video.src = `${fileURL(hit.path)}#t=${hit.loc ?? 0}`;
      video.controls = true;
      video.autoplay = true;
      // The frame on screen, not only the moment that matched: the person can stop anywhere and take this one.
      const playing = element("div", "media-actions");
      const take = element("button", "", "Save frame");
      take.onclick = () => saveFrame(hit.path, "video", video.currentTime);
      playing.append(take);
      const player = element("div", "video-preview");
      player.append(video, playing);
      box.replaceChildren(player);
    };
    frame.append(play);
    wrap.append(frame, actions);
    box.append(wrap);
    return box;
  }
  if (hit.kind === "image" || hit.kind === "screenshot") {
    // The picture's tools (turn, flip, resize, crop) live in the big preview, where the result is seen before it is
    // written: Space on the result. The side pane stays a preview.
    box.append(frame);
    return box;
  }
  box.append(frame);
  return box;
}

/// Puts text on the clipboard: the shell's own command (the web view's copy needs a user gesture the preview's button
/// may not carry), with the web view's own copy as the fallback where the shell has no command.
function copyPlainText(text) {
  invoke("copy_text", { text }).catch(() => {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.append(area);
    area.select();
    try {
      document.execCommand("copy");
    } finally {
      area.remove();
    }
  });
}

/// A video's frame at `at` saved at its own size: the helper renders it without the preview's 2048 px cap, the shell
/// asks where it goes and copies it. The folder chosen last is remembered (the web view's storage, beside the app's
/// data), and the next Save Frame starts there.
async function saveFrame(path, kind, at) {
  try {
    const reply = await invoke("save_frame", {
      path, kind, loc: at, defaultDir: localStorage.getItem("frameFolder") || null,
    });
    if (!reply?.saved) return;
    const folder = reply.saved.replace(/[\\/][^\\/]*$/, "");
    if (folder) localStorage.setItem("frameFolder", folder);
    setNote(`Saved ${reply.saved.split(/[\\/]/).pop()}`);
  } catch (error) {
    failed(`The frame couldn't be saved: ${error}`);
  }
}

/// The frame as a picture on the clipboard, so it pastes into a chat. The helper sends the JPEG's bytes inline (the
/// asset URL can't be fetched — another origin — and a canvas drawn from it can't be exported), the web view decodes
/// them into a clean bitmap and puts a PNG on the clipboard; the click that asked is the gesture it wants.
async function copyFrame(path, kind, at) {
  try {
    const reply = await ask({ op: "render", path, kind, loc: at, full: true, data: true });
    if (!reply.data) throw new Error("the helper sent no frame");
    const bytes = Uint8Array.from(atob(reply.data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    setNote("Frame copied");
  } catch (error) {
    failed(`The frame couldn't be copied: ${error}`);
  }
}

/// Frames… and Contact sheet…: the helper reads the stills (ffmpeg does, so a format the web view can't play is fine)
/// and the shell puts them beside the video under a name it reserved - nothing is overwritten. The sheet asks only what
/// a person would change: how many, from where, how often, how big.
function framesDialog(hit, mode) {
  if (!hit || hit.kind !== "video" || !$modal.hidden) return;
  const sheet = mode === "sheet";
  const duration = Number(hit.info?.duration || 0);
  const box = element("div", "modal-box frames-sheet");
  box.append(element("h2", "", sheet ? "Contact sheet" : "Extract frames"));
  box.append(element("div", "sheet-about",
    `${nameOf(hit.path)}${duration > 0 ? ` · ${clock(duration)}` : ""}`));

  const fields = element("div", "fields");
  const countField = element("label", "field");
  countField.append(element("span", "", sheet ? "Frames (up to 24)" : "How many (up to 120)"));
  const count = element("input");
  count.type = "number";
  count.min = "1";
  count.max = sheet ? "24" : "120";
  count.value = "12";
  countField.append(count);
  fields.append(countField);

  let from = null, stepSelect = null, sizeSelect = null;
  if (!sheet) {
    const fromField = element("label", "field");
    fromField.append(element("span", "", "From (seconds)"));
    from = element("input");
    from.type = "number";
    from.min = "0";
    from.step = "1";
    from.value = String(Math.floor(hit.loc ?? 0));
    fromField.append(from);
    fields.append(fromField);

    const stepField = element("label", "field");
    stepField.append(element("span", "", "Every"));
    stepSelect = element("select");
    for (const [value, label] of [["second", "1 second"], ["evenly", "Evenly across the clip"]]) {
      const option = element("option", "", label);
      option.value = value;
      stepSelect.append(option);
    }
    stepField.append(stepSelect);
    fields.append(stepField);

    const sizeField = element("label", "field");
    sizeField.append(element("span", "", "Size"));
    sizeSelect = element("select");
    for (const [value, label] of [["0", "Original size"], ["1280", "1280 px (long side)"]]) {
      const option = element("option", "", label);
      option.value = value;
      sizeSelect.append(option);
    }
    sizeField.append(sizeSelect);
    fields.append(sizeField);
  }

  const note = element("div", "sheet-note");
  const updateNote = () => {
    if (sheet) note.textContent = "One JPEG, four tiles across, beside the video. Nothing is overwritten.";
    else if (stepSelect.value === "evenly" && duration > 600) {
      note.textContent = "Evenly reads the whole clip: minutes on a video this long.";
    } else {
      note.textContent = "JPEGs in a folder beside the video. Nothing is overwritten.";
    }
  };
  updateNote();
  stepSelect?.addEventListener("change", updateNote);
  const error = element("div", "sheet-error");
  error.hidden = true;

  // Escape must not hide the sheet while the extraction runs: the work goes on, and a closed sheet would read as a
  // cancel. The note reports the result when it lands.
  let running = false;
  box.addEventListener("keydown", (event) => {
    if (running && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  const actions = element("div", "modal-actions");
  const cancel = element("button", "", "Cancel");
  cancel.onclick = closeModal;
  const go = element("button", "primary", sheet ? "Make sheet" : "Extract");
  go.onclick = async () => {
    const asked = Math.round(Number(count.value));
    if (!Number.isFinite(asked) || asked < 1) { count.focus(); return; }
    const controls = [count, from, stepSelect, sizeSelect, go, cancel].filter(Boolean);
    for (const control of controls) control.disabled = true;
    running = true;
    error.hidden = true;
    go.textContent = sheet ? "Making…" : "Extracting…";
    try {
      const reply = await invoke("extract_frames", {
        path: hit.path, mode, start: from ? Math.max(0, Number(from.value)) : 0, count: asked,
        step: stepSelect ? stepSelect.value : "second", pixels: sizeSelect ? Number(sizeSelect.value) : 0,
      });
      closeModal();
      if (reply?.folder) setNote(`Saved ${countOf(reply.files?.length ?? 0, "frame")} in ${reply.folder}`);
      else if (reply?.file) setNote(`Saved ${reply.file.split(/[\\/]/).pop()}`);
    } catch (failure) {
      running = false;
      for (const control of controls) control.disabled = false;
      go.textContent = sheet ? "Make sheet" : "Extract";
      error.textContent = String(failure);
      error.hidden = false;
    }
  };
  actions.append(cancel, go);
  box.append(fields, note, error, actions);
  showModal(box);
}

/// Rotate or flip the picture itself (the menu's entries), then show it again as it now is. The index follows on its
/// own: the watcher sees the new size and time.
async function rotatePicture(hit, degrees, flip = null) {
  try {
    const reply = await invoke("rotate_image", { path: hit.path, degrees, flip });
    const what = flip ? "Flipped" : degrees === 180 ? "Turned" : "Rotated";
    // A JPEG whose blocks align is turned by moving its DCT coefficients: said out loud, since it costs no generation.
    const how = reply.lossless ? " (lossless)" : "";
    setNote(`${what} ${nameOf(hit.path)} — Ctrl+Z to undo (${reply.width}×${reply.height})${how}`);
    rememberSize(hit.path, reply.width, reply.height);
    refreshPicture(hit.path);
  } catch (error) {
    failed(`The picture couldn't be edited: ${error}`);
  }
}

/// Puts the last edited picture back.
async function undoPicture() {
  try {
    const reply = await invoke("undo_image_edit");
    if (!reply?.path) { setNote("Nothing to undo"); return; }
    setNote(`Edit undone: ${nameOf(reply.path)}`);
    rememberSize(reply.path, reply.width, reply.height);
    if (bigOverride) {
      closeBig();           // a converted file has a new name, so what was on screen is gone
      afterConversion();    // and the list still shows the name that no longer exists
      return;
    }
    refreshPicture(reply.path);   // and the big preview re-reads the file it is showing
  } catch (error) {
    failed(`The edit couldn't be undone: ${error}`);
  }
}

/// The edited file's previews are stale (the page caches renders by path): forget them, ask again, and set what is on
/// screen - the side pane and any visible card of that file.
function refreshPicture(path) {  forgetRendersOf(path);
  for (const cell of $content.querySelectorAll("[data-path]")) {
    if (cell.dataset.path !== path) continue;
    const image = cell.querySelector("img[data-render]");
    if (!image) continue;
    const [kind, loc, pixels] = JSON.parse(image.dataset.render);
    loadRenderedImage(image, path, kind, loc, pixels,
      (file) => { if (cell.isConnected) cell.dataset.thumb = file; }, () => {});
  }
  if (state.selection === path) renderSide();
  // The big preview, if it is showing this picture, shows it as it now is.
  if (!$big.hidden && (bigHit?.path === path || bigOverride?.path === path)) renderBig();
}

/// The size this window just wrote: the row's `info` is the index's, and the index sees the write a little later, so
/// the editor and the side pane would otherwise measure the picture as it was.
function rememberSize(path, width, height) {
  const hit = hitForPath(path);
  if (!hit || !width || !height) return;
  hit.info = { ...hit.info, width, height };
}

let ocrToken = 0;   // the preview whose words are being fetched: a late reply for an older one is dropped

/// The recognized text of a result, under its facts in the side pane. Open in the OCR filter (that mode is about the
/// words); elsewhere one line — "Recognized text · 1 497 characters · show" — opens the same block. Fetched once, when
/// the preview opens; a file without an OCR reading gets nothing.
function ocrBlock(hit, open) {
  if (!["image", "screenshot", "pdf"].includes(hit.kind)) return null;
  const slot = element("div", "ocr-slot");
  const token = ++ocrToken;
  const page = hit.kind === "pdf" && hit.loc != null ? Math.trunc(hit.loc) : null;
  ask({ op: "text", path: hit.path, ocr: true, ...(page != null ? { loc: page } : {}) })
    .then((reply) => {
      if (token !== ocrToken || !reply?.text) return;
      const text = String(reply.text);
      const box = element("div", "ocr-text" + (open ? " open" : ""));
      const head = element("div", "ocr-head");
      head.append(element("span", "ocr-label",
        `Recognized text · ${text.length.toLocaleString()} characters`));
      const copy = element("button", "link", "Copy all");
      copy.title = "Put all of it on the clipboard";
      copy.onclick = () => {
        copyPlainText(text);
        setNote("Copied the recognized text");
      };
      head.append(copy);
      const body = element("pre", "ocr-body", text);
      box.append(head);
      if (!open) {
        // Closed: the line names what there is, and "show" opens it in place (one block, not a second copy).
        const show = element("button", "link", "show");
        show.onclick = () => {
          body.hidden = !body.hidden;
          show.textContent = body.hidden ? "show" : "hide";
          fitPreview();
        };
        head.append(show);
        body.hidden = true;
      }
      box.append(body);
      slot.replaceChildren(box);
      fitPreview();
    })
    .catch(() => {});
  return slot;
}

// MARK: The big preview (Space, as Quick Look on the Mac)


/// How many pages a PDF has, or passages a document, as the index counted them; 0 when it isn't that kind of file.
/// A document still being read offers only the passages that are in the index (`read_to`), not the whole plan:
/// the wheel must not turn to a passage nobody has read yet.
function partsOf(hit) {
  const count = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
  };
  if (hit.kind === "pdf") return count(hit.info?.pages);
  if (hit.kind !== "doc") return 0;
  const chunks = count(hit.info?.chunks);
  const read = count(hit.info?.read_to);
  return read > 0 ? Math.min(chunks || read, read) : chunks;
}

/// The page or passage a result points at, from 1.
function partOf(hit) {
  return Math.max(1, Math.trunc(hit.loc ?? 1));
}

function clampPart(part, total) {
  return total > 0 ? Math.min(total, Math.max(1, part)) : Math.max(1, part);
}

/// "Page 3 of 321", "Part 35 of 576": the one place the preview says where it is.
function partLabel(hit, part, total) {
  if (total < 1) return "";
  const what = hit.kind === "pdf" ? "Page" : "Part";
  return total > 1 ? `${what} ${part} of ${total}` : `${what} ${part}`;
}

const $big = element("div", "big");
$big.hidden = true;
$big.onclick = (event) => { if (event.target === $big) closeBig(); };
document.body.append($big);

let bigHit = null;    // the result the sheet shows
let bigAt = 0;        // its page or passage on screen
let bigTotal = 0;     // how many it has
let bigWheel = 0;     // wheel travel kept, so a touchpad's trickle is one turn

/// Space shows the selected result over the window, big; Space, Esc or a click beside it puts it away. The arrows move
/// through the results under it, and ↩ opens the one shown.
function toggleBig() {
  if (!$big.hidden) return closeBig();
  stopPlaying();
  closeHover(true);   // the big preview is the one player while it is up
  bigOverride = null;
  $big.hidden = false;
  renderBig();
}

function closeBig() {
  $big.hidden = true;
  closeBigCropper();
  $big.replaceChildren();   // its video or sound stops with it
  bigHit = null;
  bigAt = 0;
  bigTotal = 0;
  bigWheel = 0;
  bigEditorState = null;
  bigOverride = null;
  bigPendingTool = null;
}

/// The editor owns the keyboard while it is up: one Escape per level, Space leaves, Enter finishes the panel or the
/// crop, Tab stays inside, and the window's own shortcuts (arrows, Enter, Delete, letters) do not run underneath.
function bigKey(event) {
  const target = event.target instanceof Element ? event.target : null;
  const field = target?.closest("input, select, textarea");
  const editor = bigEditorState;
  const modifier = isMac ? event.metaKey : event.ctrlKey;
  if (modifier && !event.altKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoPicture();
    return;
  }
  if (event.key === "Tab") {
    const focusable = [...$big.querySelectorAll("button:not([disabled]):not([hidden]), input:not([hidden]), select")]
      .filter((item) => item.offsetParent !== null);
    if (!focusable.length) return;
    event.preventDefault();
    const at = focusable.indexOf(document.activeElement);
    const next = event.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : (at + 1) % focusable.length;
    focusable[next].focus();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (!editor) return closeBig();
    editor.onEscape();
    return;
  }
  if (event.key === " ") {
    // A space in a field is the field's (number fields ignore it); a question on screen takes no answer from it.
    if (field) return;
    event.preventDefault();
    if (!editor) return closeBig();
    editor.onSpace();
    return;
  }
  if (event.key === "Enter") {
    if (target?.closest("button")) return;   // a focused button answers Enter itself
    if (!editor) return;
    if (editor.confirm || editor.panel || editor.cropping || field) {
      event.preventDefault();
      editor.onEnter();
    }
    return;
  }
  if (event.key.startsWith("Arrow")) {
    if (field) return;   // the field's own step; the results must not move
    event.preventDefault();
    return;
  }
  // Everything else belongs to the field, or to nothing while the editor is open.
}

function renderBig() {
  const hit = bigOverride ?? (state.hasResults && state.query.trim() ? selectedHit() : null);
  if (!hit) return closeBig();
  // The index catching up, a watcher redraw or a click on the same result must not rebuild the sheet under the hands
  // of someone with unsaved changes or a crop box open.
  if (bigEditorState && bigHit?.path === hit.path && (bigEditorState.cropping || bigEditorState.isDirty())) {
    return;
  }
  bigHit = hit;
  // A page or passage is what the wheel turns through; other kinds have nothing to turn.
  bigTotal = hit.kind === "pdf" || hit.segment === "chunk" ? partsOf(hit) : 0;
  bigAt = clampPart(partOf(hit), bigTotal);
  bigWheel = 0;
  const sheet = element("div", "sheet");
  const head = element("div", "head");
  const title = element("div", "title");
  const dims = element("span", "dims");
  title.append(element("span", "name", nameOf(hit.path)), dims);
  const place = bigLabel();
  if (place) title.append(element("span", "place", place));
  const opening = element("button", "primary", "Open");
  opening.onclick = () => { closeBig(); open(hit); };
  const close = element("button", "close", "×");
  close.title = "Close (Space)";
  close.onclick = closeBig;
  head.append(title);
  let editor = null;
  if (editablePicture(hit)) {
    // The picture's own tools, with the result on screen before it is written.
    editor = bigEditor(hit, dims);
    head.append(...editor.headActions);
  }
  head.append(opening, close);
  sheet.append(head);
  if (editor) {
    sheet.append(editor.confirm, editor.body);
    // A cross or a click beside the sheet asks the editor first, so closing never throws work away silently.
    close.onclick = () => editor.headActions[0].click();
    $big.onclick = (event) => { if (event.target === $big) editor.headActions[0].click(); };
  } else {
    sheet.append(bigView(hit));
    $big.onclick = (event) => { if (event.target === $big) closeBig(); };
  }
  $big.replaceChildren(sheet);
}

function bigLabel() {
  if (!bigHit) return null;
  if (bigTotal > 0 && (bigHit.kind === "pdf" || bigHit.segment === "chunk")) {
    return partLabel(bigHit, bigAt, bigTotal);
  }
  return placeOf(bigHit);
}

/// One wheel notch over the big preview: the next page of a PDF or passage of a document. The arrows still move
/// through the results: they are the window's, not the sheet's.
function bigFlip(step) {
  if ($big.hidden || !bigHit || bigTotal < 2) return;
  const next = Math.min(bigTotal, Math.max(1, bigAt + step));
  if (next === bigAt) return;
  bigAt = next;
  const view = $big.querySelector(".view");
  const place = $big.querySelector(".head .place");
  if (place) place.textContent = bigLabel();
  if (bigHit.kind === "pdf") {
    const image = view?.querySelector("img");
    if (!image) return;
    const pixels = Math.round(Math.max(innerWidth, innerHeight) * (window.devicePixelRatio || 1));
    rendered(bigHit.path, "pdf", bigAt, pixels).then((file) => { image.src = fileURL(file); }).catch(() => {});
    // The next notch should be a cache hit: 90 ms of raster otherwise.
    for (const page of [bigAt + 1, bigAt - 1]) {
      if (page >= 1 && page <= bigTotal) rendered(bigHit.path, "pdf", page, pixels).catch(() => {});
    }
  } else if (bigHit.segment === "chunk") {
    const box = view?.querySelector(".passage");
    if (!box) return;
    ask({ op: "text", path: bigHit.path, loc: bigAt, code: false })
      .then((reply) => { if (reply.text) fillPassage(box, reply.text); })
      .catch(() => {});
  }
}

$big.addEventListener("wheel", (event) => {
  if (!event.deltaY || !bigHit || bigTotal < 2) return;
  if (bigHit.kind !== "pdf" && bigHit.segment !== "chunk") return;   // a recording keeps its own wheel
  event.preventDefault();
  event.stopPropagation();
  if (Math.sign(bigWheel) !== Math.sign(event.deltaY)) bigWheel = 0;
  bigWheel += event.deltaY;
  if (Math.abs(bigWheel) < 60) return;
  bigWheel = 0;
  bigFlip(event.deltaY > 0 ? 1 : -1);
}, { passive: false });

/// A picture the editor can write back: the helper's writer is JPEG and PNG only, and the other formats stay a preview.
function editablePicture(hit) {
  return (hit.kind === "image" || hit.kind === "screenshot") && /\.(jpe?g|png)$/i.test(hit.path);
}

/// 24-grid strokes, drawn at 16 px and coloured by the button.
const EDIT_ICONS = {
  left: '<polyline points="3 5 3 10 8 10"/><path d="M4.6 15a8.5 8.5 0 1 0 1.9-8.9L3 10"/>',
  right: '<polyline points="21 5 21 10 16 10"/><path d="M19.4 15a8.5 8.5 0 1 1-1.9-8.9L21 10"/>',
  flipH: '<path d="M12 3v18"/><path d="M9 7 4 12l5 5"/><path d="m15 7 5 5-5 5"/>',
  flipV: '<path d="M3 12h18"/><path d="M7 9l5-5 5 5"/><path d="m7 15 5 5 5-5"/>',
  resize: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/>' +
        '<path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  format: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15l5-5 4 4 3-3 6 6"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  cancel: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function editButton(icon, title, text = "") {
  const button = element("button", "edit-button", text);
  const svg = `<svg viewBox="0 0 24 24" aria-hidden="true">${EDIT_ICONS[icon]}</svg>`;
  button.insertAdjacentHTML("afterbegin", svg);
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

let bigEditorState = null;   // the operation on screen: at most one is pending; nothing is written until Save
let bigCropper = null;       // Crop mode's box, on the big canvas itself
let bigOverride = null;      // a converted file's own result, before the index has seen the new name
let bigPendingTool = null;   // the tool clicked while a save stood in the way: opened once the saved file is back

function closeBigCropper() {
  if (!bigCropper) return;
  try { bigCropper.destroy(); } catch {}
  bigCropper = null;
}

/// After a conversion the row is new; the search that showed the old name is still up, so refresh it in a moment.
function afterConversion() {
  setTimeout(() => { if (state.hasResults && !state.busy) setQuery(state.text); }, 2500);
}

/// The big preview's picture tools, in a rail down the left side: a portrait picture leaves its room to the sides, so
/// the picture keeps the window's height. One operation at a time: turn/flip, crop, size or format - Save writes it,
/// Discard drops it, and asking to leave or to use another tool while it is pending asks first.
function bigEditor(hit, dims) {
  closeBigCropper();
  const state = {
    angle: 0, fx: false, fy: false,
    crop: null,                         // in the turned picture's own pixels: { x, y, width, height }
    width: 0, height: 0,                // the size Save writes; the crop's own until Resize changes it
    format: "keep", quality: 92,
    sourceW: 0, sourceH: 0, ready: false, image: new Image(),
    panel: null,                        // "resize" | "format"
    cropping: false,
    confirm: null,                      // the question on screen, if any
  };
  bigEditorState = state;

  const body = element("div", "edit-body");
  const rail = element("div", "edit-rail");
  const stage = element("div", "edit-stage");
  const frame = element("div", "edit-frame");
  const canvas = element("canvas", "edit-canvas");
  frame.append(canvas);
  stage.append(frame);
  const confirmBar = element("div", "edit-confirm");
  confirmBar.hidden = true;

  const turned = () => state.angle % 180 !== 0;
  const base = () => turned() ? { width: state.sourceH, height: state.sourceW }
                              : { width: state.sourceW, height: state.sourceH };
  const uncropped = () => state.crop ? { width: state.crop.width, height: state.crop.height } : base();
  const target = () => state.width && state.height ? { width: state.width, height: state.height } : uncropped();
  const pendingKind = () => {
    if (!state.ready) return null;
    if (state.angle !== 0 || state.fx || state.fy) return "turn";
    if (state.crop) return "crop";
    const own = uncropped();
    const now = target();
    if (now.width !== own.width || now.height !== own.height) return "size";
    if (state.format !== "keep") return "format";
    return null;
  };
  const dirty = () => pendingKind() !== null;
  state.isDirty = dirty;
  const KIND = { turn: "turn", crop: "crop", size: "size", format: "format" };

  // The turned, flipped picture at the preview's own resolution; the crop and the size are then cut out of it, so the
  // screen shows exactly what Save writes.
  const draw = () => {
    if (!state.ready) return;
    const own = base();
    const scale = Math.min(1, 1800 / Math.max(own.width, own.height));
    const turnedCanvas = document.createElement("canvas");
    turnedCanvas.width = Math.max(1, Math.round(own.width * scale));
    turnedCanvas.height = Math.max(1, Math.round(own.height * scale));
    const paint = turnedCanvas.getContext("2d");
    paint.imageSmoothingQuality = "high";
    paint.translate(turnedCanvas.width / 2, turnedCanvas.height / 2);
    paint.scale(state.fx ? -1 : 1, state.fy ? -1 : 1);
    paint.rotate((state.angle * Math.PI) / 180);
    const drawWidth = turned() ? turnedCanvas.height : turnedCanvas.width;
    const drawHeight = turned() ? turnedCanvas.width : turnedCanvas.height;
    paint.drawImage(state.image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);

    const { width, height } = target();
    const fit = Math.min(1, 1800 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * fit));
    canvas.height = Math.max(1, Math.round(height * fit));
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    const cut = state.crop || { x: 0, y: 0, width: own.width, height: own.height };
    context.drawImage(turnedCanvas,
      cut.x * scale, cut.y * scale, cut.width * scale, cut.height * scale,
      0, 0, canvas.width, canvas.height);
    update();
  };

  // A turn carries the crop box with it (the box is of the picture), and the size goes back to the picture's own.
  const turn = (step) => {
    if (state.crop) {
      const before = base();
      const crop = state.crop;
      state.crop = step === 90
        ? { x: before.height - (crop.y + crop.height), y: crop.x, width: crop.height, height: crop.width }
        : { x: crop.y, y: before.width - (crop.x + crop.width), width: crop.height, height: crop.width };
    }
    state.angle = (state.angle + step + 360) % 360;
    const own = uncropped();
    state.width = own.width;
    state.height = own.height;
    showSize();
    draw();
  };
  const flip = (axis) => {
    if (state.crop) {
      const own = base();
      state.crop = axis === "x"
        ? { ...state.crop, x: own.width - (state.crop.x + state.crop.width) }
        : { ...state.crop, y: own.height - (state.crop.y + state.crop.height) };
    }
    if (axis === "x") state.fx = !state.fx; else state.fy = !state.fy;
    (axis === "x" ? flipH : flipV).classList.toggle("on", axis === "x" ? state.fx : state.fy);
    draw();
  };

  const left = editButton("left", "Rotate left");
  left.onclick = () => turn(-90);
  const right = editButton("right", "Rotate right");
  right.onclick = () => turn(90);
  const flipH = editButton("flipH", "Flip horizontally");
  flipH.onclick = () => flip("x");
  const flipV = editButton("flipV", "Flip vertically");
  flipV.onclick = () => flip("y");
  const sizeButton = editButton("resize", "Resize…");
  sizeButton.onclick = () => { if (state.panel === "resize") donePanel(); else requestTool("resize"); };
  const cropButton = editButton("crop", "Crop…");
  cropButton.onclick = () => requestTool("crop");
  const formatButton = editButton("format", "Format…");
  formatButton.onclick = () => { if (state.panel === "format") donePanel(); else requestTool("format"); };
  const resetButton = editButton("reset", "Discard the changes in this preview");
  resetButton.onclick = discardPending;
  const undoButton = editButton("undo", "Undo the last saved edit (Ctrl+Z)");
  undoButton.onclick = () => { undoPicture(); };
  const cancel = element("button", "", "Cancel");
  cancel.onclick = () => requestClose();
  const save = element("button", "primary", "Save");
  save.onclick = () => savePicture(null, false);
  save.disabled = true;
  undoButton.disabled = true;

  // Crop mode: the rail becomes Apply/Cancel, and the box is drawn on the same canvas, at the same size as the
  // picture - no second, smaller window to aim in.
  const cropApply = editButton("check", "Apply the crop");
  cropApply.onclick = () => applyCrop();
  const cropCancel = editButton("cancel", "Leave the picture uncropped");
  cropCancel.onclick = () => cancelCrop();
  const tools = [left, right, flipH, flipV, sizeButton, cropButton, formatButton, resetButton, undoButton];

  function showCropRail(on) {
    for (const button of tools) button.hidden = on;
    cropApply.hidden = !on;
    cropCancel.hidden = !on;
    if (on) { sizePop.hidden = true; formatPop.hidden = true; }
  }

  // One question, used by both the tool switch and the exit: Save, Discard, or stay.
  function askChoice({ title, saveLabel, discardLabel, onSave, onDiscard }) {
    state.confirm = { onSave, onDiscard };
    confirmBar.replaceChildren(element("span", "confirm-title", title));
    const yes = element("button", "text primary", saveLabel);
    yes.onclick = () => { hideConfirm(); onSave(); };
    const no = element("button", "text", discardLabel);
    no.onclick = () => { hideConfirm(); onDiscard(); };
    const stay = element("button", "text", "Keep editing");
    stay.onclick = hideConfirm;
    confirmBar.append(yes, no, stay);
    confirmBar.hidden = false;
    yes.focus({ preventScroll: true });
  }
  function hideConfirm() {
    state.confirm = null;
    confirmBar.hidden = true;
    confirmBar.replaceChildren();
  }

  function requestTool(tool) {
    if (!state.ready || state.cropping) return;
    const kind = pendingKind();
    if (!kind) return beginTool(tool);
    if (state.confirm) return;
    askChoice({
      title: `The ${KIND[kind]} isn't saved`,
      saveLabel: "Save and continue",
      discardLabel: "Discard and continue",
      onSave: () => savePicture(tool, false),
      onDiscard: () => { discardPending(); beginTool(tool); },
    });
  }
  function beginTool(tool) {
    if (tool === "crop") beginCrop();
    else if (tool === "resize") openResize();
    else if (tool === "format") openFormat();
  }
  function requestClose() {
    if (state.confirm) return hideConfirm();
    if (!state.ready || !dirty()) return closeBig();
    askChoice({
      title: "Save changes?",
      saveLabel: "Save",
      discardLabel: "Don't save",
      onSave: () => savePicture(null, true),
      onDiscard: closeBig,
    });
  }
  function discardPending() {
    state.angle = 0;
    state.fx = state.fy = false;
    state.crop = null;
    state.format = "keep";
    state.quality = 92;
    flipH.classList.remove("on");
    flipV.classList.remove("on");
    if (formatSelect) { formatSelect.value = "keep"; qualityInput.value = "92"; qualityRow.hidden = true; }
    state.width = 0;
    state.height = 0;
    state.panel = null;
    sizePop.hidden = true;
    formatPop.hidden = true;
    showSize();
    draw();
  }

  // Resize: pixels on either side, the chain keeping the ratio, Done keeps the size as the pending operation.
  const sizePop = element("div", "size-pop");
  sizePop.hidden = true;
  const widthRow = element("label", "row");
  widthRow.append(element("span", "", "Width"));
  const widthInput = element("input");
  widthInput.type = "number";
  widthInput.min = "1";
  widthInput.max = "16384";
  widthRow.append(widthInput, element("span", "unit", "px"));
  const heightRow = element("label", "row");
  heightRow.append(element("span", "", "Height"));
  const heightInput = element("input");
  heightInput.type = "number";
  heightInput.min = "1";
  heightInput.max = "16384";
  heightRow.append(heightInput, element("span", "unit", "px"));
  const lock = editButton("link", "Keep the aspect ratio");
  lock.classList.add("on", "lock");
  const summary = element("div", "summary");
  let resizeSnapshot = null;
  const resizeActions = element("div", "panel-actions");
  const resizeCancel = element("button", "text", "Cancel");
  resizeCancel.onclick = () => cancelPanel();
  const resizeDone = element("button", "text primary", "Done");
  resizeDone.onclick = () => donePanel();
  resizeActions.append(resizeCancel, resizeDone);
  sizePop.append(widthRow, heightRow, lock, summary, resizeActions);

  let linked = true;
  lock.onclick = () => {
    linked = !linked;
    lock.classList.toggle("on", linked);
    lock.title = linked ? "Keep the aspect ratio" : "Let width and height move on their own";
    lock.setAttribute("aria-label", lock.title);
  };
  const showSize = () => {
    if (!state.ready) return;
    const own = uncropped();
    const now = target();
    widthInput.value = String(now.width);
    heightInput.value = String(now.height);
    summary.textContent = "";
    summary.append(`Size ${own.width} × ${own.height} → `, element("b", "", `${now.width} × ${now.height}`));
  };
  const typed = (side) => {
    if (!state.ready) return;
    const own = uncropped();
    let width = Math.min(16384, Math.max(1, Math.round(Number(widthInput.value) || own.width)));
    let height = Math.min(16384, Math.max(1, Math.round(Number(heightInput.value) || own.height)));
    if (linked) {
      if (side === "width") height = Math.max(1, Math.min(16384, Math.round(width * own.height / own.width)));
      else width = Math.max(1, Math.min(16384, Math.round(height * own.width / own.height)));
    }
    state.width = width;
    state.height = height;
    widthInput.value = String(width);
    heightInput.value = String(height);
    showSize();
    draw();
  };
  widthInput.oninput = () => typed("width");
  heightInput.oninput = () => typed("height");

  // Format: the same panel, not a sheet of its own. JPEG asks for its quality.
  const formatPop = element("div", "size-pop format-pop");
  formatPop.hidden = true;
  const formatRow = element("label", "row");
  formatRow.append(element("span", "", "Format"));
  const formatSelect = element("select");
  for (const [value, label] of [["keep", "Keep"], ["jpeg", "JPEG"], ["png", "PNG"]]) {
    const option = element("option", "", label);
    option.value = value;
    formatSelect.append(option);
  }
  formatRow.append(formatSelect);
  const qualityRow = element("label", "row");
  qualityRow.append(element("span", "", "Quality"));
  const qualityInput = element("input");
  qualityInput.type = "number";
  qualityInput.min = "60";
  qualityInput.max = "100";
  qualityInput.value = "92";
  qualityInput.hidden = true;
  qualityRow.append(qualityInput);
  qualityRow.hidden = true;
  let formatSnapshot = null;
  const formatActions = element("div", "panel-actions");
  const formatCancel = element("button", "text", "Cancel");
  formatCancel.onclick = () => cancelPanel();
  const formatDone = element("button", "text primary", "Done");
  formatDone.onclick = () => donePanel();
  formatActions.append(formatCancel, formatDone);
  formatPop.append(formatRow, qualityRow, formatActions);
  const syncFormat = () => {
    const jpeg = formatSelect.value === "jpeg"
      || (formatSelect.value === "keep" && /\.(jpe?g|jpe|jfif|jfi|jif)$/i.test(hit.path));
    qualityRow.hidden = !jpeg;
    qualityInput.hidden = !jpeg;
    state.format = formatSelect.value;
    state.quality = Math.round(Number(qualityInput.value) || 92);
    update();
  };
  formatSelect.onchange = syncFormat;
  qualityInput.oninput = syncFormat;

  function openResize() {
    resizeSnapshot = { width: state.width, height: state.height };
    state.panel = "resize";
    sizePop.hidden = false;
    formatPop.hidden = true;
    showSize();
    widthInput.focus({ preventScroll: true });
    widthInput.select?.();
  }
  function openFormat() {
    formatSnapshot = { format: state.format, quality: state.quality };
    state.panel = "format";
    formatPop.hidden = false;
    sizePop.hidden = true;
    syncFormat();
    formatSelect.focus({ preventScroll: true });
  }
  function closePanel() {
    state.panel = null;
    // The focus must not stay in a field the panel took away: a hidden input would keep swallowing Space and Enter.
    const active = document.activeElement;
    if (active instanceof Element && (sizePop.contains(active) || formatPop.contains(active))) active.blur();
    sizePop.hidden = true;
    formatPop.hidden = true;
  }
  function cancelPanel() {
    if (state.panel === "resize" && resizeSnapshot) {
      state.width = resizeSnapshot.width;
      state.height = resizeSnapshot.height;
    } else if (state.panel === "format" && formatSnapshot) {
      state.format = formatSnapshot.format;
      state.quality = formatSnapshot.quality;
      formatSelect.value = formatSnapshot.format;
      qualityInput.value = String(formatSnapshot.quality);
      syncFormat();
    }
    closePanel();
    draw();
  }
  function donePanel() {
    closePanel();
    update();
  }

  function beginCrop() {
    if (!state.ready || state.cropping) return;
    closePanel();
    state.crop = null;
    const own = base();
    state.width = own.width;
    state.height = own.height;
    showSize();
    draw();
    state.cropping = true;
    showCropRail(true);
    update();
    closeBigCropper();
    bigCropper = new window.Cropper(canvas, {
      viewMode: 1, autoCrop: true, autoCropArea: 0.85, background: false, responsive: true,
      guides: false, toggleDragModeOnDblclick: false, checkOrientation: false,
      crop: () => {
        if (!bigCropper?.ready) return;
        const data = bigCropper.getData(true);
        if (!data.width || !data.height) return;
        const own = base();
        const factor = own.width / canvas.width;
        dims.textContent = `${own.width} × ${own.height} → `;
        dims.append(element("b", "",
          `${Math.max(1, Math.round(data.width * factor))} × ${Math.max(1, Math.round(data.height * factor))}`));
      },
    });
  }
  function applyCrop() {
    if (!bigCropper) return;
    const data = bigCropper.getData(true);
    const own = base();
    const factor = own.width / canvas.width;
    if (data.width > 2 && data.height > 2) {
      const x = Math.max(0, Math.min(own.width - 1, Math.round(data.x * factor)));
      const y = Math.max(0, Math.min(own.height - 1, Math.round(data.y * factor)));
      state.crop = {
        x, y,
        width: Math.max(1, Math.min(own.width - x, Math.round(data.width * factor))),
        height: Math.max(1, Math.min(own.height - y, Math.round(data.height * factor))),
      };
      state.width = state.crop.width;
      state.height = state.crop.height;
    }
    endCrop();
    draw();
  }
  function cancelCrop() {
    endCrop();
    draw();
  }
  function endCrop() {
    state.cropping = false;
    showCropRail(false);
    closeBigCropper();
    update();
  }

  let undoCount = 0;
  const syncUndo = () => { undoButton.disabled = !state.ready || dirty() || undoCount === 0; };
  const refreshUndo = async () => {
    try {
      const reply = await invoke("undo_state");
      undoCount = Number(reply?.count) || 0;
    } catch {
      undoCount = 0;
    }
    if (bigEditorState === state) syncUndo();
  };

  const update = () => {
    const now = target();
    save.disabled = !state.ready || !dirty();
    resetButton.disabled = !state.ready || !dirty();
    cropButton.disabled = state.cropping;
    cancel.disabled = state.cropping;
    syncUndo();
    // The head tells the whole story: what the picture is, and what Save will leave.
    const own = base();
    const changed = now.width !== own.width || now.height !== own.height;
    dims.textContent = changed ? `${own.width} × ${own.height} → ` : `${own.width} × ${own.height}`;
    if (changed) dims.append(element("b", "", `${now.width} × ${now.height}`));
  };

  async function savePicture(then = null, closeAfter = false) {
    if (!state.ready || state.cropping) return;
    const own = uncropped();
    const wanted = target();
    const resize = wanted.width === own.width && wanted.height === own.height
      ? null : { width: wanted.width, height: wanted.height };
    let angle = state.angle;
    let which = null;
    // Two flips make a half turn; the helper takes one axis at a time.
    if (state.fx && state.fy) angle = (angle + 180) % 360;
    else if (state.fx) which = "horizontal";
    else if (state.fy) which = "vertical";
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const reply = await invoke("edit_picture", {
        path: hit.path, rotate: angle, flip: which, crop: state.crop, resize,
        format: state.format === "keep" ? null : state.format,
        quality: Math.round(Number(qualityInput.value) || 92),
      });
      rememberSize(reply.path, reply.width, reply.height);
      bigEditorState = null;                 // what is on screen is the written picture now
      if (reply?.converted) {
        setNote(`Converted to ${nameOf(reply.path)} (${reply.width}×${reply.height})`);
        afterConversion();
        if (closeAfter) { closeBig(); return; }
        // The index has not seen the new name yet: the editor opens on the answer's own path.
        bigOverride = { ...hit, path: reply.path, info: { ...hit.info, width: reply.width, height: reply.height } };
        bigPendingTool = then;
        renderBig();
      } else {
        setNote(`Saved ${nameOf(reply.path)} (${reply.width}×${reply.height})${reply.lossless ? " (lossless)" : ""} — Ctrl+Z to undo`);
        if (closeAfter) { closeBig(); return; }
        bigPendingTool = then;
        refreshPicture(reply.path);
      }
      refreshUndo();
    } catch (failure) {
      save.disabled = false;
      save.textContent = "Save";
      failed(`The picture couldn't be saved: ${failure}`);
    }
  }

  // The editor owns the keyboard: Escape climbs one level, Space leaves when there is nothing pending, Enter finishes
  // the panel or the crop, and the window's own shortcuts do not run underneath.
  state.onEscape = () => {
    if (state.confirm) return hideConfirm();
    if (state.panel) return cancelPanel();
    if (state.cropping) return cancelCrop();
    requestClose();
  };
  state.onSpace = () => {
    if (state.confirm || state.panel || state.cropping) return;
    requestClose();
  };
  state.onEnter = () => {
    if (state.confirm) {
      const action = state.confirm.onSave;
      hideConfirm();
      return action();
    }
    if (state.panel) return donePanel();
    if (state.cropping) return applyCrop();
  };

  rail.append(left, right, flipH, flipV, sizeButton, cropButton, formatButton, resetButton, undoButton);
  rail.append(cropApply, cropCancel, sizePop, formatPop);
  cropApply.hidden = true;
  cropCancel.hidden = true;
  body.append(rail, stage);

  state.image.onload = () => {
    state.sourceW = Number(hit.info?.width) || state.image.naturalWidth;
    state.sourceH = Number(hit.info?.height) || state.image.naturalHeight;
    state.width = state.sourceW;
    state.height = state.sourceH;
    state.ready = true;
    showSize();
    draw();
    refreshUndo();
    if (bigPendingTool) {
      const tool = bigPendingTool;
      bigPendingTool = null;
      requestTool(tool);
    }
  };
  state.image.onerror = () => { dims.textContent = "the picture couldn't be read"; };
  // The helper's render is orientation-baked and keyed by the file's time, so the preview after a save is the picture
  // as it now is (the window's asset cache would happily show the one from before).
  ask({ op: "render", kind: "image", path: hit.path, pixels: 1800, data: true }).then((reply) => {
    if (!reply?.data) throw new Error("the helper sent no picture");
    state.image.src = `data:image/jpeg;base64,${reply.data}`;
  }).catch((failure) => { dims.textContent = String(failure); });
  return { body, headActions: [cancel, save], confirm: confirmBar };
}

/// The result as big as the window allows: the picture or the page, the video or the recording from the moment, the
/// passage or the lines of code.
function bigView(hit) {
  const view = element("div", "view");
  if (hit.kind === "code" || hit.segment === "chunk") {
    view.classList.add("text");
    view.append(hit.kind === "code" ? codeLines(hit) : passage(hit));
    return view;
  }
  if (hit.kind === "video" || hit.kind === "audio") {
    const media = element(hit.kind === "video" ? "video" : "audio");
    media.src = `${fileURL(hit.path)}#t=${hit.loc ?? 0}`;
    media.controls = true;
    media.autoplay = true;
    view.append(media);
    if (hit.kind === "video") {
      // The frame the player is on: seek to the number plate, then save exactly that.
      const actions = element("div", "media-actions");
      const save = element("button", "", "Save frame");
      save.onclick = () => saveFrame(hit.path, "video", media.currentTime);
      actions.append(save);
      view.append(actions);
    }
    return view;
  }
  const what = renderOf(hit);
  if (!what) {
    const placeholder = element("div", "placeholder");
    placeholder.innerHTML = ICONS[hit.kind] || ICONS.doc;
    view.append(placeholder);
    return view;
  }
  const image = element("img");
  image.alt = "";
  const extension = hit.path.split(".").pop().toLowerCase();
  if (what[0] === "image" && SHOWN_AS_IS.has(extension)) {
    image.src = fileURL(hit.path);
  } else {
    const pixels = Math.round(Math.max(innerWidth, innerHeight) * (window.devicePixelRatio || 1));
    rendered(hit.path, what[0], what[0] === "pdf" ? bigAt : what[1], pixels)
      .then((file) => { image.src = fileURL(file); }).catch(() => {});
  }
  image.ondblclick = () => { closeBig(); open(hit); };
  view.append(image);
  return view;
}

function addPlace(box, text) {
  if (!text) return;
  box.style.position = "relative";
  box.append(element("span", "place on-image", text));
}

// MARK: The peek (hover a picture to see it large, without touching the selection)

/// Imagus's timing: the timer restarts on every move, so the picture comes up when the pointer rests rather than while
/// it sweeps the grid. The popup is sized to the window and never past the picture's own size, and takes no click.
const PEEK_DELAY = 300;
const PEEK_GAP = 24;   // the room the picture keeps from the window's edges

const $peek = element("div", "peek");
$peek.hidden = true;
const $peekPicture = element("img");
$peekPicture.alt = "";
// The strip along the top: the pointer rests at the picture's bottom-right corner, so the top is the one part of it the
// pointer never covers. A document's text sits under it, so the strip is in the flow there (see .peek.text).
const $peekCaption = element("div", "peek-caption");
const $peekName = element("div", "peek-name");
const $peekFacts = element("div", "peek-facts");
const $peekPlace = element("div", "peek-place");
$peekCaption.append($peekName, $peekFacts, $peekPlace);
const $peekText = element("div", "peek-text");
$peekText.hidden = true;
$peek.append($peekCaption, $peekPicture, $peekText);
document.body.append($peek);

let peekHit = null;                     // the result the pointer rests on
let peekCell = null;                    // its element: the wheel belongs to the peek only while it is on this one
let peekTimer = 0;                      // the 300 ms before its picture comes up
let peekPoint = { x: 0, y: 0 };         // where the pointer stopped: the picture's bottom-right corner
let peekHits = [];                      // the group's results (or just the one), in album order
let peekIndex = 0;                      // which of them is on screen
let peekShown = null;                   // the path asked for last, so a late answer for another is dropped
let peekShowing = null;                 // the result on screen: the caption is its
let peekWant = null;                    // the render asked for, for forgetting a preview the helper has since deleted
let peekWheel = 0;                      // wheel travel kept, so a touchpad's trickle is one picture per notch
let peekAt = 0;                         // a document's page or passage on screen
let peekTotal = 0;                      // how many it has (0 for a picture)
let peekTurn = 0;                       // the page or passage asked for last, so a late answer is dropped

/// The result a group's path names, from everything the window has loaded (folded copies aren't in `rows()`).
function hitForPath(path) {
  for (const list of [state.ranked, state.weaker, state.hidden]) {
    const found = list.find((hit) => hit.path === path);
    if (found) return found;
  }
  return null;
}

function peekOnHover(cell, hit) {
  if (hit.kind === "video") return hoverVideoOn(cell, hit);   // a recording plays; the rest is a picture to look at
  if (!["image", "screenshot", "pdf", "doc"].includes(hit.kind)) return;
  cell.addEventListener("pointermove", (event) => {
    if (event.buttons) return hidePeek();               // a drag: nobody is looking at the picture
    if (peekHit === hit && !$peek.hidden) { peekCell = cell; return; }   // up already, still on this one
    if (peekHit !== hit) hidePeek();
    peekHit = hit;
    peekCell = cell;
    peekPoint = { x: event.clientX, y: event.clientY };
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => showPeek(hit), PEEK_DELAY);
  });
  // Like Imagus: the picture stays while the pointer is on the one it belongs to, and the next comes by the same rule.
  cell.addEventListener("pointerleave", () => { if (peekHit === hit) hidePeek(); });
}

/// Shows what the pointer rests on: a picture (and the group behind it), a PDF's page, or a book's passage. The wheel
/// turns through the album, the PDF's pages or the book's passages, without opening anything.
function showPeek(hit) {
  if (peekHit !== hit) return;
  const group = groupingActive() ? groupOf(hit.path) : null;
  // Only a folded group is an album: its one card stands for the series, so the wheel turns through it. An open
  // group's copies are cards of their own, and the wheel on one of them belongs to the list.
  const album = group && !groupOpen(group) ? group : null;
  peekHits = (album ?? [hit.path]).map(hitForPath).filter(Boolean);
  if (!peekHits.length) return;
  peekIndex = Math.max(0, peekHits.findIndex((one) => one.path === hit.path));
  peekWheel = 0;
  peekTotal = partsOf(hit);
  peekAt = clampPart(partOf(hit), peekTotal);
  peekTurn = 0;
  renderPeek(peekHits[peekIndex]);
}

function renderPeek(hit) {
  if (hit.kind === "pdf") return renderPeekPage(hit);
  if (hit.kind === "doc") return renderPeekPart(hit);
  const what = renderOf(hit);
  if (!what) return hidePeek();
  // A document's peek hid the picture and showed its text: the picture comes back for a picture (a PDF did this for
  // itself, so an image after a book stayed blank until a PDF was looked at).
  $peekPicture.hidden = false;
  $peekText.hidden = true;
  // The size Space asks for: one render serves both, and hovering warms what Space will show.
  const pixels = Math.round(Math.max(innerWidth, innerHeight) * (window.devicePixelRatio || 1));
  peekShown = hit.path;
  peekWant = { path: hit.path, kind: what[0], loc: what[1], pixels };
  rendered(hit.path, what[0], what[1], pixels).then((file) => {
    if (peekShown !== hit.path) return;
    peekShowing = hit;
    $peekPicture.onload = placePeek;
    $peekPicture.src = fileURL(file);
    if ($peekPicture.complete) placePeek();
  }).catch(hidePeek);
}

/// The page is rendered at 900 px: readable in the popup and about 90 ms of rasterizing, half the window's size. The
/// next and previous pages are asked for while this one shows, so a wheel notch finds them made.
function peekPixels() {
  return Math.round(900 * (window.devicePixelRatio || 1));
}

function renderPeekPage(hit) {
  const turn = ++peekTurn;
  peekShowing = hit;
  peekShown = hit.path;
  peekWant = { path: hit.path, kind: "pdf", loc: peekAt, pixels: peekPixels() };
  $peekText.hidden = true;
  $peekPicture.hidden = false;
  updatePeekCaption();
  rendered(hit.path, "pdf", peekAt, peekPixels()).then((file) => {
    if (turn !== peekTurn) return;
    $peekPicture.onload = placePeek;
    $peekPicture.src = fileURL(file);
    if ($peekPicture.complete) placePeek();
  }).catch(hidePeek);
  for (const page of [peekAt + 1, peekAt - 1]) {
    if (page >= 1 && (!peekTotal || page <= peekTotal)) rendered(hit.path, "pdf", page, peekPixels()).catch(() => {});
  }
}

function renderPeekPart(hit) {
  const turn = ++peekTurn;
  peekShowing = hit;
  peekShown = hit.path;
  peekWant = null;
  $peekPicture.hidden = true;
  $peekText.hidden = false;
  updatePeekCaption();
  ask({ op: "text", path: hit.path, loc: peekAt, code: false }).then((reply) => {
    if (turn !== peekTurn) return;
    const text = reply?.text ?? "";
    if (!text) $peekText.textContent = "No text in this part.";
    else fillPassage($peekText, text, peekAt === partOf(hit) ? foundWords(hit.excerpt) : []);
    placePeek();
  }).catch(hidePeek);
}

/// One wheel notch: the next page of a PDF or passage of a book, to the end and no further.
function turnPeek(step) {
  if (!peekShowing || peekTotal < 2) return;
  const next = clampPart(peekAt + step, peekTotal);
  if (next === peekAt) return;
  peekAt = next;
  if (peekShowing.kind === "pdf") renderPeekPage(peekShowing);
  else renderPeekPart(peekShowing);
}

/// One wheel notch: the next picture of the group, round the end.
function cyclePeek(step) {
  if (peekHits.length < 2) return;
  peekIndex = (peekIndex + step + peekHits.length) % peekHits.length;
  renderPeek(peekHits[peekIndex]);
}

/// The popup's bottom-right corner at the pointer, then inside the window; a picture is never larger than itself, and a
/// document takes the width its text reads at.
function placePeek() {
  if (!peekHit || !peekShowing) return hidePeek();
  const picture = peekShowing.kind !== "doc";
  if (picture) {
    const naturalWidth = $peekPicture.naturalWidth, naturalHeight = $peekPicture.naturalHeight;
    if (!naturalWidth || !naturalHeight) return hidePeek();
    const roomWidth = Math.max(320, innerWidth - PEEK_GAP * 2);
    const roomHeight = Math.max(240, innerHeight - PEEK_GAP * 2);
    const scale = Math.min(1, roomWidth / naturalWidth, roomHeight / naturalHeight);
    const width = Math.round(naturalWidth * scale), height = Math.round(naturalHeight * scale);
    $peekPicture.style.width = `${width}px`;
    $peekPicture.style.height = `${height}px`;
  }
  $peek.classList.toggle("text", !picture);
  $peek.hidden = false;
  const box = $peek.getBoundingClientRect();
  const width = Math.round(box.width) || 320, height = Math.round(box.height) || 240;
  $peek.style.left = `${Math.max(PEEK_GAP, Math.min(innerWidth - PEEK_GAP - width, peekPoint.x - width))}px`;
  $peek.style.top = `${Math.max(PEEK_GAP, Math.min(innerHeight - PEEK_GAP - height, peekPoint.y - height))}px`;
  updatePeekCaption();
  // What the file is: the side pane's line, so the two can't drift apart; a narrow picture drops the folder to keep
  // the strip from covering it.
  $peek.classList.toggle("small", width < 260);
}

/// The name, where the preview is (a page, a passage, a place in an album) and the file's facts.
function updatePeekCaption() {
  if (!peekShowing) return;
  const album = peekHits.length > 1 ? `${peekIndex + 1} of ${peekHits.length}` : "";
  const place = peekTotal > 0 ? partLabel(peekShowing, peekAt, peekTotal) : "";
  $peekName.textContent = nameOf(peekShowing.path);
  $peekFacts.textContent = (place || album ? `${place || album} · ` : "") + details(peekShowing);
  $peekPlace.textContent = folderOf(peekShowing);
}

function hidePeek() {
  clearTimeout(peekTimer);
  peekHit = null;
  peekCell = null;
  peekHits = [];
  peekIndex = 0;
  peekShown = null;
  peekShowing = null;
  peekWant = null;
  peekWheel = 0;
  peekAt = 0;
  peekTotal = 0;
  peekTurn += 1;
  $peekText.hidden = true;
  $peekText.replaceChildren();
  $peek.classList.remove("text");
  $peek.hidden = true;
}

/// A preview the helper has since deleted (it clears them on every start) would sit here as a broken picture: forget
/// the path, so the next hover asks again, and put it away.
$peekPicture.onerror = () => {
  const want = peekWant;
  if (want) forgetRender(want.path, want.kind, want.loc, want.pixels);
  hidePeek();
};

// Anything that means the pointer isn't just resting on a picture puts it away.
$content.addEventListener("scroll", hidePeek, { passive: true });
document.addEventListener("pointerdown", hidePeek, true);

/// The wheel over the peek turns through a PDF's pages or a book's passages, or through the group like an album (and
/// doesn't scroll the list under it); anywhere else it puts the peek away, as it always did. A mouse notch is ~100, a
/// touchpad's trickle a few pixels at a time, so the travel is added up: one turn per notch, however it arrives.
document.addEventListener("wheel", (event) => {
  if ($peek.hidden) return;
  const under = document.elementFromPoint(event.clientX, event.clientY);
  // The card and the list's row are both "the element the peek was opened on"; a cell of the row is inside it.
  const overIt = under instanceof Element && peekCell && peekCell.contains(under);
  if (!overIt || !event.deltaY) {
    hidePeek();
    return;
  }
  const turns = peekTotal > 1;
  if (!turns && peekHits.length < 2) {
    hidePeek();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (Math.sign(peekWheel) !== Math.sign(event.deltaY)) peekWheel = 0;
  peekWheel += event.deltaY;
  if (Math.abs(peekWheel) < 60) return;
  peekWheel = 0;
  if (turns) turnPeek(event.deltaY > 0 ? 1 : -1);
  else cyclePeek(event.deltaY > 0 ? 1 : -1);
}, { passive: false, capture: true });
document.addEventListener("keydown", hidePeek, true);
// A right-click inside the player is the long press that pins it, never the file's menu: its own handler stops the
// menu, and the player stays.
document.addEventListener("contextmenu", (event) => {
  hidePeek();
  if (!(event.target instanceof Element) || !event.target.closest(".hover-play")) closeHover(true);
}, true);
window.addEventListener("blur", hidePeek);
window.addEventListener("resize", hidePeek);

// MARK: The hover player (hover a video to watch it, without opening anything)

/// Taken from Imagus (`Imagus-Mass-Download-Mod/src-mv3-overlay`, `content/content.js`): 300 ms of stillness, the
/// pop-up's corner at the cursor growing into the free side (`placement: 0`, `fullspace`), never bigger than the
/// source, and hidden by a `pointerover` outside it or its card - not by leave timers. The video keeps the window's own
/// controls (the side pane's player); only Pin, Save frame and the close button float above them, always visible so
/// they never race the controls' own hiding.
const HOVER_DELAY = 300;       // idle, not travel: the timer restarts on every move, so a sweep opens nothing
const HOVER_GAP = 12;          // from the results area's edges
const HOVER_LOOP_UNDER = 60;   // seconds

const $hover = element("div", "hover-play");
$hover.hidden = true;
$hover.setAttribute("role", "dialog");
$hover.setAttribute("aria-label", "Video preview");
const $hoverVideo = element("video", "hp-video");
$hoverVideo.muted = true;
$hoverVideo.playsInline = true;
$hoverVideo.preload = "metadata";
$hoverVideo.controls = true;   // the side pane's player: auto-hiding controls, standard icons, the volume wheel
const $hoverChip = element("div", "hp-chip");
const $hoverPin = element("button", "hp-button", "Pin");
$hoverPin.type = "button";
const $hoverSave = element("button", "hp-button", "Save frame");
$hoverSave.type = "button";
const $hoverFrames = element("button", "hp-button", "Frames…");
$hoverFrames.type = "button";
$hoverFrames.title = "Stills from this video, as JPEGs in a folder beside it";
const $hoverClose = element("button", "hp-button hp-close", "×");
$hoverClose.type = "button";
$hoverClose.setAttribute("aria-label", "Close the player");
$hoverChip.append($hoverPin, $hoverSave, $hoverFrames, $hoverClose);
const $hoverFallback = element("div", "hp-fallback");
$hoverFallback.hidden = true;
const $hoverFrame = element("img");
$hoverFrame.alt = "";
const $hoverWhy = element("div", "hp-why", "Windows can't play this format.");
const $hoverOpen = element("button", "hp-button", "Open");
$hoverOpen.type = "button";
$hoverFallback.append($hoverFrame, $hoverWhy, $hoverOpen);
$hover.append($hoverVideo, $hoverChip, $hoverFallback);
document.body.append($hover);

let hoverHit = null;              // the result on screen
let hoverCell = null;             // its card: a pointerover on it keeps the player
let hoverPoint = { x: 0, y: 0 };  // where the pointer rested: the pop-up's corner
let hoverTimer = 0;               // the 300 ms of stillness before it opens
let hoverPinned = false;          // the Pin button's state
let hoverNatural = null;          // the source's own size, so the pop-up is never stretched past it
const hoverSaved = localStorage.getItem("hoverVolume");
let hoverVolume = hoverSaved === null ? 0.25 : Math.min(1, Math.max(0, Number(hoverSaved) || 0));
const hoverFailed = new Set();    // a format Windows can't play: the frame stands in, without a second try

/// A card's pointer rests on it: 300 ms of stillness open the player; every move restarts the timer.
function hoverVideoOn(cell, hit) {
  cell.addEventListener("pointermove", (event) => {
    if (event.buttons) return;                      // a drag, a selection: not a hover
    if (hoverHit === hit) return;                   // already open, or the timer is running for this one
    hoverPoint = { x: event.clientX, y: event.clientY };
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => openHover(hit, cell), HOVER_DELAY);
  });
  // The pointer left before the 300 ms ran out: nothing opens (the open player's own rule is the pointerover below).
  cell.addEventListener("pointerleave", () => clearTimeout(hoverTimer));
}

function openHover(hit, cell) {
  if (!hit || hit.kind !== "video" || !cell.isConnected) return;
  hoverHit = hit;
  hoverCell = cell;
  clearTimeout(hoverTimer);
  stopPlaying();   // one decoder in the window
  for (const video of document.querySelectorAll("video")) if (video !== $hoverVideo) video.pause();
  const failed = hoverFailed.has(hit.path);
  hoverNatural = sourceSize(hit);
  $hover.classList.toggle("failed", failed);
  $hoverFallback.hidden = !failed;
  $hoverVideo.hidden = failed;
  // Whatever was playing goes now: a switched-to file that can't play must not leave the last one running behind a
  // hidden element (its sound included).
  $hoverVideo.pause();
  if (failed) {
    $hoverVideo.removeAttribute("src");
    $hoverVideo.load();
  }
  $hover.hidden = false;
  sizeHover();
  placeHover();
  $hoverVideo.muted = true;                // a hover never makes noise; the native button turns it on
  $hoverVideo.volume = hoverVolume;
  if (failed) showHoverFrame(hit);
  else startHoverVideo(hit);
}

/// The source's own pixels: what the index knows (else the video's metadata once it arrives).
function sourceSize(hit) {
  const width = Number(hit?.info?.width) || 0;
  const height = Number(hit?.info?.height) || 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

function startHoverVideo(hit) {
  $hoverVideo.loop = false;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  $hoverVideo.onloadedmetadata = () => {
    if (hoverHit !== hit) return;
    if ($hoverVideo.videoWidth > 0 && $hoverVideo.videoHeight > 0) {
      hoverNatural = { width: $hoverVideo.videoWidth, height: $hoverVideo.videoHeight };
      sizeHover();
      placeHover();
    }
    // The matched moment with two seconds of lead-in; a name hit has none, so it starts at the start.
    const start = Math.max(0, (hit.loc ?? 0) - 2);
    if (Number.isFinite($hoverVideo.duration) && start < $hoverVideo.duration) $hoverVideo.currentTime = start;
    $hoverVideo.loop = $hoverVideo.duration > 0 && $hoverVideo.duration < HOVER_LOOP_UNDER;
    // A person who asked the system for less motion gets the frame; Play is in the controls.
    if (!still) $hoverVideo.play().catch(() => {});
  };
  $hoverVideo.onerror = () => {
    if (hoverHit !== hit) return;
    hoverFailed.add(hit.path);
    $hover.classList.add("failed");
    $hoverFallback.hidden = false;
    $hoverVideo.hidden = true;
    $hoverVideo.pause();
    $hoverVideo.removeAttribute("src");
    showHoverFrame(hit);
  };
  $hoverVideo.src = fileURL(hit.path);
  $hoverVideo.load();
}

/// The frame at the matched moment through the helper, for a format Windows can't play.
function showHoverFrame(hit) {
  const pixels = Math.round(1024 * (window.devicePixelRatio || 1));
  rendered(hit.path, "video", hit.loc ?? 0.5, pixels).then((file) => {
    if (hoverHit !== hit) return;
    $hoverFrame.src = fileURL(file);
    $hoverFrame.onload = () => {
      if (!hoverNatural && $hoverFrame.naturalWidth && $hoverFrame.naturalHeight) {
        hoverNatural = { width: $hoverFrame.naturalWidth, height: $hoverFrame.naturalHeight };
        sizeHover();
        placeHover();
      }
    };
  }).catch(() => {});   // no frame either: the line under it still says what this is
}

/// The box: the source's own size, shrunk to the results area if it doesn't fit - never stretched past the source.
function sizeHover() {
  const area = $content.getBoundingClientRect();
  const maxWidth = Math.max(16, area.width - HOVER_GAP * 2);
  const maxHeight = Math.max(9, area.height - HOVER_GAP * 2);
  const natural = hoverNatural ?? { width: maxWidth, height: Math.round(maxWidth * 9 / 16) };
  const scale = Math.min(1, maxWidth / natural.width, maxHeight / natural.height);
  const width = Math.max(1, Math.round(natural.width * scale));
  const height = Math.max(1, Math.round(natural.height * scale));
  $hover.style.width = `${width}px`;
  $hover.style.height = `${height}px`;
}

/// Imagus's placement 0: the corner at the cursor, growing into the free side; clamped inside the results area.
function placeHover() {
  if (!hoverCell || !hoverCell.isConnected || $hover.hidden) return;
  const area = $content.getBoundingClientRect();
  const width = $hover.offsetWidth, height = $hover.offsetHeight;
  const minLeft = area.left + HOVER_GAP, minTop = area.top + HOVER_GAP;
  const maxLeft = Math.max(minLeft, area.right - HOVER_GAP - width);
  const maxTop = Math.max(minTop, area.bottom - HOVER_GAP - height);
  let left = hoverPoint.x, top = hoverPoint.y;
  if (left + width > area.right - HOVER_GAP) left = hoverPoint.x - width;
  if (top + height > area.bottom - HOVER_GAP) top = hoverPoint.y - height;
  left = Math.max(minLeft, Math.min(maxLeft, left));
  top = Math.max(minTop, Math.min(maxTop, top));
  $hover.style.left = `${Math.round(left)}px`;
  $hover.style.top = `${Math.round(top)}px`;
}

function closeHover(force = false) {
  if (!force && hoverPinned) return;
  clearTimeout(hoverTimer);
  hoverHit = null;
  hoverCell = null;
  setHoverPinned(false);
  $hoverVideo.onloadedmetadata = null;
  $hoverVideo.onerror = null;
  $hoverVideo.pause();
  $hoverVideo.removeAttribute("src");
  $hoverVideo.load();
  $hoverFrame.removeAttribute("src");
  $hoverFallback.hidden = true;
  $hover.classList.remove("failed");
  $hover.hidden = true;
}

function setHoverPinned(on) {
  hoverPinned = on;
  $hoverPin.setAttribute("aria-pressed", String(on));
  $hoverPin.title = on ? "Pinned: stays when the pointer leaves (click to unpin)"
                       : "Keep the player while the pointer moves away";
}
setHoverPinned(false);

/// Where the window's own controls last left the volume; muted is per show, so it isn't stored.
$hoverVideo.addEventListener("volumechange", () => {
  if ($hoverVideo.muted) return;
  hoverVolume = Math.min(1, Math.max(0, $hoverVideo.volume));
  localStorage.setItem("hoverVolume", String(hoverVolume));
});

/// The moment on screen, for Save frame: where playback is, or the moment matched when nothing plays.
function hoverMoment() {
  const time = $hoverVideo.currentTime;
  return Number.isFinite(time) && time > 0 ? time : (hoverHit?.loc ?? 0);
}

$hoverSave.onclick = () => { if (hoverHit) saveFrame(hoverHit.path, "video", hoverMoment()); };
$hoverFrames.onclick = () => { if (hoverHit) framesDialog(hoverHit, "sequence"); };$hoverOpen.onclick = () => { if (hoverHit) open(hoverHit); };
$hoverClose.onclick = () => closeHover(true);
$hoverPin.onclick = () => setHoverPinned(!hoverPinned);

// Imagus's hide rule: any pointerover outside the player and its card hides it at once - no leave timers, so a grid
// full of videos cannot keep an old player playing while the pointer travels across it.
document.addEventListener("pointerover", (event) => {
  if ($hover.hidden || hoverPinned) return;
  const target = event.target;
  if (target instanceof Element
      && (target.closest(".hover-play") || (hoverCell && target.closest("[data-path]") === hoverCell))) return;
  closeHover(true);
}, true);

// The pointer left the page, or the window went to the background: an unpinned player goes; a pinned one only stops.
document.documentElement.addEventListener("mouseleave", () => { if (!hoverPinned) closeHover(true); });
window.addEventListener("blur", () => { if (hoverPinned) $hoverVideo.pause(); else closeHover(true); });

// Keys: the native controls answer Space and the arrows while the player has the focus; ours is Esc.
$hover.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeHover(true);
});

// The player doesn't scroll the list under it; the native volume slider's own wheel still runs (this only takes the
// page's scroll away).
$hover.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
$content.addEventListener("scroll", () => { if (!hoverPinned) closeHover(true); }, { passive: true });
window.addEventListener("resize", () => { if (!hoverPinned) closeHover(true); });

/// Where a moment sits in a recording: a track with the matched stretch lit (and where playback is).
function momentBar(start, end, duration, playhead) {
  const bar = element("div", "moment-bar");
  const from = Math.max(0, Math.min(1, start / duration)), to = Math.max(from, Math.min(1, end / duration));
  const lit = element("div", "lit");
  lit.style.left = `${from * 100}%`;
  lit.style.width = `${(to - from) * 100}%`;
  bar.append(lit);
  if (playhead != null) {
    const head = element("div", "head");
    head.style.left = `${Math.max(0, Math.min(1, playhead / duration)) * 100}%`;
    bar.append(head);
  }
  bar.title = `At ${clock(start)} of ${clock(duration)}`;
  return bar;
}

/// A recording read by its tags alone: it plays like any other recording, and the fields read from it are what the
/// index knows about it. Rows written before 0.1.7 carried only the marker, no fields: the tag line the search matched
/// stands in until they are read again.
function audioTagsCard(hit) {
  const card = element("div", "tags-card");
  const player = document.createElement("audio");
  player.controls = true;
  player.preload = "metadata";
  player.src = fileURL(hit.path);
  card.append(player);
  const lines = element("div", "tags-lines");
  const fields = [["title", "Title"], ["artist", "Artist"], ["album", "Album"], ["genre", "Genre"],
                  ["date", "Year"], ["track", "Track"]];
  for (const [key, label] of fields) {
    if (hit.info?.[key]) lines.append(element("div", "tag-line", `${label}: ${hit.info[key]}`));
  }
  if (!lines.childElementCount) {
    const matched = (hit.excerpt || "").replace(/[<>]/g, "").trim();
    lines.append(element("div", "tag-line", matched || "No tags in the file: found by its name."));
  }
  card.append(lines, element("div", "tags-note", "Read by its tags"));
  return card;
}

/// An audio result: the stretch that matched on the file's timeline, and ▶ to hear it from there.
function audioMoment(hit) {
  const box = element("div", "audio-moment");
  const start = hit.loc ?? 0, end = hit.loc_end ?? start + 30;
  const duration = Number(hit.info?.duration || 0);
  const controls = element("div", "controls");
  const wave = element("div", "wave");
  wave.innerHTML = ICONS.audio;
  const toggle = element("button", "toggle play-icon");
  toggle.innerHTML = ICONS.play;
  toggle.title = `Play from ${clock(start)}`;
  controls.append(wave, toggle);
  const line = element("div", "span", `${clock(start)} – ${clock(end)}` + (duration ? ` of ${clock(duration)}` : ""));
  let bar = duration > 0 ? momentBar(start, end, duration) : null;
  box.append(controls, ...(bar ? [bar] : []), line);
  const showPlaying = () => {
    const on = playing != null && !playing.paused;
    toggle.innerHTML = on ? ICONS.pause : ICONS.play;
    toggle.classList.toggle("play-icon", !on);
  };
  toggle.onclick = () => {
    if (!playing) {
      const audio = new Audio(`${fileURL(hit.path)}#t=${start}`);
      audio.ontimeupdate = () => {
        line.textContent = `${clock(audio.currentTime)} – playing from ${clock(start)}`;
        if (bar) {
          const moved = momentBar(start, end, duration, audio.currentTime);
          bar.replaceWith(moved);
          bar = moved;
        }
      };
      audio.onplay = audio.onpause = showPlaying;
      audio.onended = () => {
        stopPlaying();
        showPlaying();
      };
      playing = audio;
    }
    if (playing.paused) playing.play().catch(() => {});
    else playing.pause();
  };
  return box;
}

function stopPlaying() {
  if (!playing) return;
  playing.pause();
  playing.removeAttribute("src");
  playing = null;
}

/// A passage's text, centred just before the query's first word and with its words marked.
function fillPassage(box, text, found = []) {
  box.dir = isRightToLeft(text) ? "rtl" : "ltr";
  box.innerHTML = highlighted(passageAround(text, [...found, ...queryWords(state.text)]), state.text, found);
}

/// The part of a document that matched, on a page, the words marked.
function passage(hit) {
  const page = element("div", "passage");
  const found = foundWords(hit.excerpt);
  const show = (text) => fillPassage(page, text, found);
  show((hit.excerpt ?? "").replace(/[«»]/g, ""));
  ask({ op: "text", segment: hit.segment_id, code: false })
    .then((reply) => { if (reply.text) show(reply.text); })
    .catch(() => {});
  page.ondblclick = () => open(hit);
  return page;
}

/// The lines of code that matched, numbered as in the file: the query's words marked, the line it opens at lit, and
/// scrolled to it. A notebook's cells have no line numbers of their own, so theirs count from 1.
function codeLines(hit) {
  const box = element("div", "code-lines");
  const first = hit.segment === "lines" ? Math.max(1, Math.trunc(hit.loc ?? 1)) : 1;
  const focus = hit.segment === "lines" && hit.focus != null ? Math.trunc(hit.focus) - first : null;
  const found = foundWords(hit.excerpt);
  const show = (text) => {
    const lines = text.split(/\r?\n/).map((line) => line.replaceAll("\t", "    "));
    const width = String(first + Math.max(lines.length, 1)).length;
    box.replaceChildren();
    let firstMarked = null;
    lines.forEach((line, offset) => {
      const row = element("div", "line" + (offset === focus ? " focus" : ""));
      const number = element("span", "number", String(first + offset));
      number.style.width = `${width}ch`;
      const code = element("span");
      code.innerHTML = highlighted(line || " ", state.text, found);
      if (firstMarked == null && code.querySelector("mark")) firstMarked = offset;
      row.append(number, code);
      box.append(row);
    });
    const target = focus ?? firstMarked;
    if (target != null && target > 3) box.children[target - 2]?.scrollIntoView({ block: "start" });
  };
  ask({ op: "text", segment: hit.segment_id, code: true })
    .then((reply) => show(reply.text || (hit.excerpt ?? "").replace(/[«»]/g, "")))
    .catch(() => show((hit.excerpt ?? "").replace(/[«»]/g, "")));
  box.ondblclick = () => open(hit);
  return box;
}

function facts(hit) {
  const box = element("div", "facts");
  const title = element("div", "title", "‎" + nameOf(hit.path));
  title.title = nameOf(hit.path);
  const folder = folderLine(folderOf(hit), "button");
  folder.title = `Show in ${FILE_MANAGER}`;
  folder.onclick = () => reveal(hit);
  box.append(title, folder, element("div", "details", details(hit)));
  return box;
}

/// "Matches the frame at 0:06", and the words it has, if any.
function why(hit) {
  const box = element("div", "why");
  const reason = element("div", "reason" + (matchedMeaning(hit) ? "" : " words"));
  reason.innerHTML = matchedMeaning(hit) ? ICONS.found : ICONS.words;
  reason.append(element("span", "", reasonOf(hit)));
  box.append(reason);
  // Code shows its lines above, the words marked there.
  if (hit.excerpt && hit.kind !== "code") {
    const excerpt = element("div", "excerpt");
    excerpt.dir = "auto";
    excerpt.innerHTML = marked(hit.excerpt);
    box.append(excerpt);
  }
  return box;
}

function actions(hit) {
  const box = element("div", "actions");
  const openButton = element("button", "primary", "Open");
  openButton.onclick = () => open(hit);
  const revealButton = element("button", "", `Show in ${FILE_MANAGER}`);
  revealButton.onclick = () => reveal(hit);
  box.append(openButton, revealButton);
  return box;
}

// MARK: The status bar

function renderStatus() {
  const app = state.app;
  // How old the index is, beside what it holds: "306 files indexed · synced 2 min ago". While indexing it's saying that
  // already. Redrawn every half minute, since the age grows without an event.
  const age = app.activity === "idle" ? indexAge(app.asOf) : "";
  $("status-line").textContent = (app.line || "") + (age ? ` · synced ${age}` : "");
  const ring = $("ring");
  ring.hidden = app.progress == null;
  if (app.progress != null) {
    const length = 2 * Math.PI * 4.6;
    ring.innerHTML = `<svg viewBox="0 0 12 12"><circle class="track" cx="6" cy="6" r="4.6"/><circle class="done" cx="6" `
      + `cy="6" r="4.6" stroke-dasharray="${(length * Math.max(0.02, app.progress)).toFixed(2)} ${length.toFixed(2)}"/></svg>`;
  }
  let count = "";
  const chosen = isWindows && state.hasResults && state.query.trim() ? selectedHits() : [];
  if (state.error) count = `DigUp Plus's helper: ${state.error}`;
  else if (state.note) count = state.note;
  else if (chosen.length) count = `${chosen.length.toLocaleString()} selected · ${bytes(selectedSize(chosen))}`;
  else if (state.hasResults && state.query.trim()) {
    const strong = state.ranked.length, weaker = state.weaker.length;
    const remaining = remainingResults();
    if (state.total > strong + weaker && remaining > 0) {
      count = `${(strong + weaker).toLocaleString()} of ${state.total.toLocaleString()}`
        + (weaker ? ` · ${weaker.toLocaleString()} weaker` : "");
    } else if (state.total > strong + weaker) {
      count = `All ${state.total.toLocaleString()} results shown` + (weaker ? ` · ${weaker.toLocaleString()} weaker` : "");
    } else {
      count = state.warming ? "The model is loading: meaning follows in a moment"
        : app.caveat || (!state.meaning ? "Words only: meaning search isn't available"
        : `${strong} ${strong === 1 ? "result" : "results"}` + (weaker ? ` · ${weaker} weaker` : ""));
    }
  }
  $("count").textContent = count;
}

// MARK: Menus

/// A small menu at (x, y): [title, action, shortcut?, enabled?] items, null for a line between them.
function showMenu(x, y, items) {
  $menu.replaceChildren();
  for (const item of items) {
    if (!item) {
      $menu.append(element("hr"));
      continue;
    }
    const [title, action, shortcut, enabled = true] = item;
    const button = element("button", "", title);
    button.setAttribute("role", "menuitem");
    button.disabled = !enabled;
    if (shortcut) button.append(element("span", "shortcut", shortcut));
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = () => {
      hideMenu();
      action();
    };
    $menu.append(button);
  }
  $menu.hidden = false;
  const { width, height } = $menu.getBoundingClientRect();
  $menu.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  $menu.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
}

function hideMenu() {
  $menu.hidden = true;
}

/// ⋯: what the tray's menu has, for desktops without a tray.
function showMainMenu() {
  const button = $("more").getBoundingClientRect();
  const folders = state.info.folders.length > 0, paused = state.app.paused === true;
  showMenu(button.right - 200, button.bottom + 4, [
    ["Choose Folders…", () => invoke("choose_folders").catch(failed)],
    ["Index Now", () => invoke("index_now").catch(failed), null, state.app.canIndexNow === true],
    [paused ? "Resume Indexing" : "Pause Indexing", () => invoke("pause_indexing", { paused: !paused }).catch(failed),
     null, folders],
    null,
    ["Settings…", () => invoke("open_settings").catch(failed), `${MOD},`],
    ["Download New Version…", () => invoke("open_releases").catch(failed)],
    null,
    ["Quit DigUp Plus", () => invoke("quit_app").catch(failed)],
  ]);
}

document.addEventListener("mousedown", (event) => {
  if (!$menu.hidden && !$menu.contains(event.target)) hideMenu();
});
window.addEventListener("blur", hideMenu);

// MARK: Keys and events

$query.addEventListener("input", () => { state.like = null; queryChanged(); });
// A click back in the field: ← → move the cursor again (after picking a result, they moved the selection).
$query.addEventListener("mousedown", () => { state.navigated = false; });
$("clear").onmousedown = (event) => event.preventDefault();
$("clear").onclick = () => setQuery("");
$("toggle-view").onmousedown = (event) => event.preventDefault();
$("toggle-view").onclick = () => {
  state.view = state.view === "grid" ? "table" : "grid";
  updateViewButton();
  settleSelection();
  renderContent();
  renderGroups();
};
$("toggle-preview").onmousedown = (event) => event.preventDefault();
$("toggle-preview").onclick = () => {
  state.showsPreview = !state.showsPreview;
  updatePreviewButton();
  renderSide();
};
$("settings").onmousedown = (event) => event.preventDefault();
$("settings").onclick = () => invoke("open_settings").catch(failed);
$("settings").title = `Settings (${MOD},)`;
$("more").onmousedown = (event) => event.preventDefault();
$("more").onclick = () => ($menu.hidden ? showMainMenu() : hideMenu());
$("status-line").onclick = () => invoke("choose_folders").catch(failed);
$more.onmousedown = (event) => event.preventDefault();
$more.onclick = () => loadMore(false);
$content.addEventListener("scroll", maybeLoadMore, { passive: true });
$kinds.onmousedown = (event) => event.preventDefault();
// The chosen files' bar: its buttons take the clicks but not the keyboard (typing stays in the field).
$batch.onmousedown = (event) => { if (event.target.closest("button")) event.preventDefault(); };
$batchToggle.onclick = () => {
  if (selectedHits().length) clearSelection();
  else selectAll();
};
$("batch-paths").onclick = () => copyPaths();
$("batch-copy").onclick = () => moveOrCopy("copy");
$("batch-move").onclick = () => moveOrCopy("move");
$("batch-delete").onclick = () => confirmDelete();
$("batch-tc").onclick = () => toTotalCommander(false);
$("batch-tc-all").onclick = () => toTotalCommander(true);

// Find similar's look-alike line: everything it does sits on it, in plain sight.
$("groups-expand").onclick = toggleAllGroups;
$("group-on").onchange = () => {
  // The line's switch belongs to the mode: Find similar's own, or the "every search" one from Settings.
  if (state.like) state.grouping = $("group-on").checked;
  else state.groupingEverywhere = $("group-on").checked;
  saveLookalike();
  applyGrouping();
};
// "Groups only" is a view of the list, not a setting: it leaves the pictures that look like nothing else out, so a
// series can be worked through without the singles in between.
$("group-only").onchange = () => {
  state.onlyGroups = $("group-only").checked;
  redrawGroups();
};
let groupTyping = null;   // ms after the last keystroke until the difference is applied
$("group-difference").oninput = () => {
  const field = $("group-difference");
  const value = Number(field.value);
  if (field.value.trim() === "" || !Number.isFinite(value) || value < 0 || value > 50) return;
  clearTimeout(groupTyping);
  groupTyping = setTimeout(() => setDifference(value), 250);
};
/// The line's presets, as measured on a real collection: 6% folds copies (a resize, a re-compression, a monochrome
/// save) and 33% a whole series of shots that differ in small details.
function setDifference(value) {
  state.groupDifference = value;
  $("group-difference").value = value;
  saveLookalike();
  refreshGroups();
}
$("group-preset-6").onclick = () => setDifference(6);
$("group-preset-33").onclick = () => setDifference(33);
// A click beside a confirmation puts it away; an operation under way has its own Cancel.
$modal.onmousedown = (event) => { if (event.target === $modal && !state.busy) closeModal(); };

function updatePreviewButton() {
  const button = $("toggle-preview");
  button.setAttribute("aria-pressed", String(state.showsPreview));
  button.title = state.showsPreview ? "Hide Preview" : "Show Preview";
  button.setAttribute("aria-label", button.title);
}

function updateViewButton() {
  const button = $("toggle-view");
  const table = state.view === "table";
  button.setAttribute("aria-pressed", String(table));
  button.title = table ? "Show as Grid" : "Show as Table";
  button.setAttribute("aria-label", button.title);
}

document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;   // an input method is composing: its keys
  const modifier = isMac ? event.metaKey : event.ctrlKey;
  const plain = !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey;
  if (!$modal.hidden) {
    // A sheet has the keyboard: its buttons answer Enter and Space; Tab goes round them; Escape puts it away (or asks
    // an operation to stop).
    if (event.key === "Tab") {
      const buttons = [...$modal.querySelectorAll("button:not(:disabled)")];
      event.preventDefault();
      if (!buttons.length) return;
      const at = buttons.indexOf(document.activeElement);
      const next = event.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
      buttons[next].focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (state.busy) cancelOperation();
      else closeModal();
    }
    return;
  }
  if (!$menu.hidden && event.key === "Escape") {
    event.preventDefault();
    hideMenu();
    return;
  }
  // The picture editor owns the keyboard while it is up: its own Escape/Space/Enter/Tab, and no window shortcut
  // underneath. The other big previews (a page, a video, a passage) keep the window's keys, as before.
  if (!$big.hidden) {
    if (bigEditorState) {
      bigKey(event);
      return;
    }
    if (event.key === "Escape" || event.key === " ") {
      event.preventDefault();
      closeBig();
      return;
    }
  }
  // A button with the keyboard answers Enter and Space itself (a checkbox's tick, a sheet's, the bar's).
  if (event.target instanceof Element && event.target.closest("button") && (event.key === "Enter" || event.key === " ")) {
    return;
  }
  // Select All: outside the field, where Ctrl+A is the text's (inside it, the field keeps its own).
  if (modifier && !event.altKey && event.key.toLowerCase() === "a") {
    if (!isWindows) return;
    // In the field Ctrl+A is the text's; Ctrl+Shift+A still clears what's chosen.
    if (document.activeElement === $query && !event.shiftKey) return;
    event.preventDefault();
    if (event.shiftKey) clearSelection();
    else selectAll();
    return;
  }
  if (modifier && !event.altKey && !event.shiftKey) {
    const number = Number(event.key);
    if (number >= 1 && number <= 6) {
      event.preventDefault();
      setFilter(number === 1 ? null : FILTERS[number - 2].key);
      return;
    }
    if (number === 7 && state.info.hasCode) {
      event.preventDefault();
      setFilter("code");
      return;
    }
    switch (event.key.toLowerCase()) {
      case ",":
        event.preventDefault();
        invoke("open_settings").catch(failed);
        return;
      case "w":
        event.preventDefault();
        invoke("hide_window").catch(() => {});
        return;
      case "c":
        // A selection in the pane (the recognized text of a picture) is what Ctrl+C copies; the file copies only when
        // nothing is selected.
        if (window.getSelection()?.toString()) return;
        copyResult(event, state.hasResults && state.query.trim() ? selectedHit() : null, state.navigated);
        return;
      case "f":
      case "l":
        event.preventDefault();
        $query.focus();
        $query.select();
        state.navigated = false;
        return;
      case "z":
        // The last picture edited (the menu's Rotate/Flip): undone only outside the field, where Ctrl+Z is the text's.
        if (document.activeElement instanceof HTMLElement
            && (document.activeElement.matches("input, textarea, select") || document.activeElement.isContentEditable)) return;
        event.preventDefault();
        undoPicture();
        return;
    }
  }
  switch (event.key) {
    case "Tab": {
      // The two domains the keyboard lives in — the field and the results — and Tab (either direction) is the switch
      // between them. Nothing moves the focus on its own; every other control keeps its natural Tab order.
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (!$menu.hidden) hideMenu();
      const at = document.activeElement;
      const onRow = at instanceof Element && at.closest("[data-path]");
      if (at === $query) {
        if (!focusActiveRow()) return;   // no results to point at: the natural order
        event.preventDefault();
      } else if (onRow) {
        event.preventDefault();
        $query.focus();
      }
      return;
    }
    case " ":
      // After the arrows, a click, or Tab into the results: the big preview. In the field: a space.
      if (!plain || document.activeElement === $query || !(state.navigated || !$big.hidden || onResult())
          || !state.hasResults || !state.query.trim() || !selectedHit()) return;
      event.preventDefault();
      toggleBig();
      return;
    case "g":
    case "G": {
      // Find similar's look-alikes under the cursor: g opens or folds that group, Shift+G does it to every group.
      if (!$big.hidden || !$modal.hidden || !$menu.hidden) return;
      if (!groupingActive() || !state.hasResults || document.activeElement === $query) return;
      if (event.shiftKey) {
        if (!state.groups?.length) return;
        event.preventDefault();
        toggleAllGroups();
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const hit = state.hasResults && state.query.trim() ? selectedHit() : null;
      const group = hit ? groupOf(hit.path) : null;
      if (!group) return;
      event.preventDefault();
      toggleGroup(group);
      return;
    }
    case "ArrowDown":
    case "ArrowUp": {
      // Shift takes the range from where choosing started to here (in the media list, a row at a time).
      const wasTyping = document.activeElement === $query;
      if (event.shiftKey) {
        if (event.altKey || event.ctrlKey || event.metaKey || !isWindows || !rows().length) return;
        event.preventDefault();
        // A row at a time in the grid, one result in the table (columns() is 1 there).
        extendSelection(event.key === "ArrowDown" ? columns() : -columns());
        if (wasTyping) focusActiveRow();   // the keyboard leaves the field with the selection
        return;
      }
      if (!plain || !rows().length) return;
      event.preventDefault();
      move(event.key === "ArrowDown" ? columns() : -columns());
      // Down or Up is how one leaves the field for the results: a letter typed next must not rewrite the query and
      // throw the ranking away. Tab (from a result) or a click on the field brings the caret back.
      if (wasTyping) focusActiveRow();
      return;
    }
    case "Insert": {
      // Add the one under the cursor to what's chosen (or take it away) and move on.
      const wasTyping = document.activeElement === $query;
      const hit = state.hasResults && state.query.trim() ? selectedHit() : null;
      if (!hit || !isWindows || !MEDIA.has(hit.kind)) return;
      event.preventDefault();
      toggleSelected(hit.path);
      move(1);
      if (wasTyping) focusActiveRow();
      return;
    }
    case "Delete":
      // Only outside the field: there it deletes text. Nothing ticked: the file under the cursor, as file managers do.
      if (!isWindows || document.activeElement === $query) return;
      event.preventDefault();
      if (!deletableHits().length) return;
      confirmDelete();
      return;
    case "F5":
    case "F6":
    case "F8":
      // Taken even with nothing chosen: the web view must not reload the window on them.
      if (!isWindows) return;
      event.preventDefault();
      if (event.key === "F8") {
        if (!deletableHits().length) return;
        confirmDelete();
      } else {
        if (!selectedHits().length) return;
        if (event.key === "F5") moveOrCopy("copy");
        else moveOrCopy("move");
      }
      return;
    case "ArrowLeft":
    case "ArrowRight": {
      const delta = event.key === "ArrowRight" ? 1 : -1;
      // Shift takes the range one picture at a time, whatever the arrow; in the field it is the text's.
      if (event.shiftKey) {
        if (event.altKey || event.ctrlKey || event.metaKey || !isWindows) return;
        if (document.activeElement === $query || !rows().length) return;
        event.preventDefault();
        extendSelection(delta);
        return;
      }
      // Tab into the results puts the keyboard on a picture; there the arrows are the grid's, not a text caret's.
      if (!plain || document.activeElement === $query || !rows().length) return;
      event.preventDefault();
      move(delta);
      return;
    }
    case "Enter": {
      const hit = state.hasResults && state.query.trim() ? selectedHit() : null;
      if (!hit) return;
      if (modifier && !event.altKey && !event.shiftKey) reveal(hit);
      else if (plain) open(hit);
      else return;
      closeBig();
      event.preventDefault();
      return;
    }
    case "Escape":
      // Escape puts the window away and touches nothing else: clearing the selection or the query is an explicit
      // action (Deselect All, the field's cross), never a side effect of putting the window down.
      event.preventDefault();
      invoke("hide_window").catch(() => {});
      return;
  }
});

tauri.event.listen("state", ({ payload }) => {
  const before = state.app;
  state.app = payload;
  // Code search turned on or off (Settings): the Code chip, the examples, a code: search.
  if (payload.hasCode != null && payload.hasCode !== state.info.hasCode) {
    state.info.hasCode = payload.hasCode;
    if (isCode() && state.query.trim()) run(); else render();
  }
  renderStatus();
  if (payload.searchable !== before.searchable || payload.files !== before.files) loadIndexed();
});

// Settings → General → Total Commander: the batch bar's buttons show or hide the moment a program is chosen there.
tauri.event.listen("totalcmd", ({ payload }) => {
  state.tc = payload || null;
  renderBatch();
});

// Settings → Search, look-alike groups: the window follows that change at once, without a new search.
tauri.event.listen("lookalike", ({ payload }) => {
  const groups = payload?.groups !== false;
  const everywhere = payload?.everywhere === true;
  const difference = Number(payload?.difference ?? 6);
  if (groups === state.grouping && everywhere === state.groupingEverywhere
      && difference === state.groupDifference) return;
  state.grouping = groups;
  state.groupingEverywhere = everywhere;
  state.groupDifference = difference;
  if (document.activeElement !== $("group-difference")) $("group-difference").value = difference;
  applyGrouping();
});

// The panel handed its search over (Ctrl+O, "Show all…"): this window was already open.
tauri.event.listen("window-search", ({ payload }) => {
  state.like = null;
  state.filter = knownFilter(payload.kind);
  setQuery(payload.query || "");
  $query.focus();
});

// The files being moved, copied or deleted: the sheet's line moves along. The report comes back from the command
// itself, so `done` here only closes the gap before it.
tauri.event.listen("file-op", ({ payload }) => {
  if (!state.busy || payload.id !== state.busy.id) return;
  if (payload.phase === "progress") {
    state.busy.done = payload.done;
    state.busy.path = payload.path;
    // A copy's byte-by-byte events carry bytes/size; the one after each file doesn't.
    state.busy.bytes = payload.bytes ?? null;
    state.busy.size = payload.size ?? null;
    renderOperation();
  }
});

// The helper loaded the vectors beside its requests (`prewarm`): a search answered meanwhile was words only, so it
// runs again now, with meaning this time.
tauri.event.listen("helper", ({ payload }) => {
  if (payload?.from !== "search") return;
  const event = payload.event || {};
  const arrived = (event.event === "vectors" && event.state === "ready")
    || (event.event === "encoder" && event.state === "ready");
  if (!arrived) return;
  state.ready += 1;
  if (state.warming && state.query.trim()) run();
});

window.addEventListener("focus", () => ask({ op: "prewarm" }).catch(() => {}));

// Its size, for the next time it opens (the shell keeps it when the window closes).
let sizeTimer = null;
function reportSize() {
  invoke("window_resized", { width: window.innerWidth, height: window.innerHeight }).catch(() => {});
}
window.addEventListener("resize", () => {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(reportSize, 300);
});

// The preview pane's width: drag its divider, or focus it and use the arrows. The width is remembered the way the
// window's size is (`preview_resized`; the shell keeps it with the window's place and hands it back on the next
// start), and the picture's proportions are the stylesheet's business (`object-fit: contain`).
const SIDE_MIN = 200, SIDE_MAX = 600;
function setSideWidth(width) {
  $side.style.width = `${Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, width)))}px`;
  fitPreview();
}
let sideTimer = null;
function reportSide() {
  clearTimeout(sideTimer);
  sideTimer = setTimeout(() => {
    invoke("preview_resized", { width: $side.getBoundingClientRect().width }).catch(() => {});
  }, 300);
}
$splitter.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();   // no text selection while dragging
  const right = $side.getBoundingClientRect().right;
  const move = (move) => setSideWidth(right - move.clientX);
  const done = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", done);
    reportSide();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", done);
});
$splitter.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.stopPropagation();   // the results' arrow navigation must not move the selection meanwhile
  event.preventDefault();
  setSideWidth($side.getBoundingClientRect().width + (event.key === "ArrowRight" ? 16 : -16));
  reportSide();
});
reportSize();

/// What's indexed of each kind under the chosen folders (the home's counts), at most every two seconds while indexing.
let indexedTimer = null;
function loadIndexed() {
  if (indexedTimer) return;
  indexedTimer = setTimeout(async () => {
    indexedTimer = null;
    try {
      const reply = await ask({ op: "summaries" });
      const kinds = {};
      for (const root of reply.roots || []) {
        for (const [kind, count] of Object.entries(root.kinds || {})) kinds[kind] = (kinds[kind] || 0) + count;
      }
      state.indexed = kinds;
      if (!state.query.trim() && state.info.folders.length) {
        $content.querySelector(".about")?.replaceWith(about());
      }
    } catch {
      // The home goes without the counts.
    }
  }, state.indexed ? 2000 : 0);
}

async function start() {
  const info = await invoke("window_info");
  state.info = { ...state.info, ...info };
  state.app = info.state || {};
  state.tc = info.totalcmd?.path || null;
  state.grouping = info.lookalike?.groups !== false;
  state.groupingEverywhere = info.lookalike?.everywhere === true;
  state.groupDifference = Number(info.lookalike?.difference ?? 6);
  // The index's age grows between events: the status bar's "synced 2 min ago" is redrawn without one.
  setInterval(renderStatus, 30000);
  if (info.search) {
    state.filter = knownFilter(info.search.kind);
    $query.value = info.search.query || "";
    state.query = $query.value;
    $("clear").hidden = !state.query;
  }
  updatePreviewButton();
  if (info.previewWidth) setSideWidth(info.previewWidth);
  render();
  loadIndexed();
  $query.focus();
  if (state.query) run();
  ask({ op: "prewarm" }).catch(() => {});
  if (info.debugQuery != null) debugSearch(info.debugQuery);
}

// Debug runs (--debug-window): type the query in, and once the results and their pictures are in, report what the
// window shows ("" reports the home).
function debugSearch(query) {
  if (!query) {
    setTimeout(report, 1500);
    return;
  }
  debugPending = true;
  setQuery(query);
}

function report() {
  debugPending = false;
  // With --debug-settings, Settings opens as its button opens it, and Settings reports once its page is up.
  if (state.info.debugSettings) {
    setTimeout(() => $("settings").click(), 500);
    return;
  }
  // --debug-copy: the selected result on the clipboard, as Ctrl+C puts it.
  if (state.info.debugCopy && selectedHit()) {
    invoke("copy_file", { path: selectedHit().path })
      .then(() => "copied", (error) => `not copied: ${error}`)
      .then((copied) => invoke("debug_report", { report: { copied, path: selectedHit()?.path } }));
  }
  // Dev snapshots (window.html?big): the selected result's big preview, as Space shows it.
  if (new URLSearchParams(location.search).has("big")) toggleBig();
  setTimeout(() => {
    const thumbs = [...$content.querySelectorAll(".cell img")];
    const big = $side.querySelector(".frame img, .passage, .code-lines, .audio-moment, .placeholder");
    invoke("debug_report", {
      report: {
        window: true,
        query: $query.value,
        filter: state.filter,
        kinds: [...$kinds.querySelectorAll(".chip")].map((chip) => chip.textContent + (chip.classList.contains("selected") ? " (selected)" : "")),
        results: state.ranked.map((hit) => nameOf(hit.path)),
        weaker: state.weaker.length,
        hidden: state.hidden.length,
        columns: columns(),
        selected: state.selection && nameOf(state.selection),
        thumbnails: `${thumbs.filter((image) => image.complete && image.naturalWidth > 0).length} of ${thumbs.length} drawn`,
        preview: big && {
          what: big.className || big.tagName.toLowerCase(),
          loaded: big.tagName === "IMG" ? big.complete && big.naturalWidth > 0 : null,
          size: big.tagName === "IMG" ? `${big.naturalWidth}x${big.naturalHeight}` : null,
          text: big.tagName === "IMG" ? null : big.textContent.slice(0, 80),
        },
        facts: [...$side.querySelectorAll(".facts .title, .facts .folder, .facts .details, .why .reason span")].map((node) => node.textContent),
        home: $content.querySelector(".home") && [...$content.querySelectorAll(".about .line")].map((line) => line.textContent),
        status: [$("status-line").textContent, $("count").textContent],
      },
    }).catch(() => {});
  }, 1500);
}

start();
