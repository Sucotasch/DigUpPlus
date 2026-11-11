// DigUp Plus's Settings window, its tabs after the Mac app's (Sources/DigUpApp/SettingsWindow.swift). General: opening at
// login, centering the search panel where the desktop places windows itself (it costs memory, so it's a choice), where
// the shortcut lives, and updates. Folders: how indexing goes (with Pause), each folder searched and how far along it is, the
// folders and file types skipped, and the set hours. Code: code search's folders (added in setup's folder list for code),
// the editor its results open in, turning it off. Storage: the model, the index, privacy.
"use strict";

const tauri = window.__TAURI__;
const invoke = (command, args) => tauri.core.invoke(command, args);
const ask = (request) => invoke("ask", { request });
const isWindows = /Win/.test(navigator.platform);
const $ = (id) => document.getElementById(id);

/// How long ago the folders were last walked, from the shell's `asOf` (seconds since 1970): "2 min ago", "3 h ago".
function indexAge(asOf) {
  if (!asOf) return "";
  const minutes = Math.floor((Date.now() / 1000 - asOf) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

const notes = {
  gnome: "DigUp Plus added it to GNOME's keyboard shortcuts. To change it: Settings → Keyboard → View and Customize " +
    "Shortcuts → Custom Shortcuts.",
  kde: "DigUp Plus added it to KDE's shortcuts. To change it: System Settings → Shortcuts → DigUp Plus.",
  by_hand: "This desktop doesn't let apps set their own shortcuts. To open the panel with one, add a shortcut in its " +
    "keyboard settings that runs:",
};

let info = {};
let summaries = null;        // what's indexed under each folder (search-service's summaries)
let removing = null;         // the folder whose removal is being confirmed
let rereading = null;        // the folder whose re-read is being confirmed
let repicking = null;        // the folder whose re-pick is being confirmed ({ folder, target, rows, matched, ... })
let ruling = null;           // the folder whose rule (kinds, top level only) is being edited
let codeSummaries = null;    // what's indexed under each code folder
let removingCode = null;     // the code folder whose removal is being confirmed
let modelMessage = "";      // what the last model action said ("2 of 2 files verified", a failure)
let modelProblem = false;    // …and whether it was a failure
let modelConfirm = null;     // { run, alternate } for the model question on screen
let indexMessage = "";      // what the last index move said
let indexProblem = false;    // …and whether it was a failure
let indexBusy = false;       // the index is being copied to its new folder
let indexConfirm = null;     // the move waiting on its question

// MARK: Tabs

function showTab(name) {
  for (const button of document.querySelectorAll("#tabs button")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  }
  for (const tab of document.querySelectorAll(".tab")) tab.hidden = tab.id !== name;
  if (name === "folders") loadSummaries();
  if (name === "code") loadCodeSummaries();
}

for (const button of document.querySelectorAll("#tabs button")) button.onclick = () => showTab(button.dataset.tab);

/// How a search judges a match (Settings → Search): the meaning gate, and the Images filter's layer cutoffs.
function renderSearch() {
  // A refresh (indexing reports every two seconds) must not overwrite a number being typed.
  if (document.activeElement !== $("zgate")) $("zgate").value = info.zgate ?? 2;
  if (document.activeElement !== $("image-tiers")) $("image-tiers").value = info.imageTiers || "standard";
  $("search-note").hidden = true;
}

let searchSaving = null;   // the change in flight: the fields stay as typed, then take the saved numbers back
async function saveSearchSettings() {
  const field = $("zgate");
  const zgate = Number(field.value);
  const note = $("search-note");
  // While the field is empty or half-typed there's nothing to save: typing "1.5" passes through "" and "1.".
  if (field.value.trim() === "" || !Number.isFinite(zgate)) {
    note.hidden = false;
    note.textContent = "The threshold is a number, 0.5 to 5.";
    return;
  }
  note.hidden = true;
  clearTimeout(searchSaving);
  // Typing a number shouldn't send a settings write per keystroke.
  searchSaving = setTimeout(async () => {
    try {
      const saved = await invoke("set_search_settings", { zgate, imageTiers: $("image-tiers").value });
      info.zgate = saved.zgate;
      info.imageTiers = saved.imageTiers;
      if (document.activeElement !== field) field.value = saved.zgate;
    } catch (error) {
      fail(error);
    }
  }, 400);
}
$("zgate").addEventListener("input", saveSearchSettings);
$("zgate").addEventListener("change", saveSearchSettings);
$("image-tiers").addEventListener("change", saveSearchSettings);

// MARK: General

function renderGeneral() {
  $("login-option").hidden = !info.canOpenAtLogin;
  $("login").checked = info.openAtLogin;
  $("tray-click-option").hidden = !info.canChooseTrayClick;
  for (const choice of document.querySelectorAll('input[name="tray-click"]')) choice.checked = choice.value === info.trayClick;
  $("center-option").hidden = !info.canCenter;
  $("center").checked = info.centered;
  $("processor").checked = info.processorOnly;
  $("confirm-move-copy").checked = info.confirmMoveCopy;
  $("confirm-delete").checked = info.confirmDelete;
  $("include-datasets").checked = info.includeDatasets;
  $("keys").replaceChildren(...info.hotkey.split("+").filter(Boolean).map((key) => element("span", "key", key)));
  const note = notes[info.shortcut.method];
  $("shortcut-note").hidden = !note;
  $("shortcut-note").textContent = note || "";
  $("shortcut-command").hidden = info.shortcut.method !== "by_hand";
  $("shortcut-command").textContent = info.shortcut.command;
  $("change-shortcut").hidden = info.shortcut.method !== "grab" || recording;
  $("recording").hidden = !recording;
  renderUpdates();
  renderTotalCommander();
}

/// Total Commander (Settings → General): the program the window's results open in. A portable copy has no registry
/// entry, so the path is chosen by hand; the one the registry names is used until then.
function renderTotalCommander() {
  const tc = info.totalcmd || {};
  $("tc-info").textContent = tc.path
    ? `The window's results open in ${tc.path}.`
    : tc.chosen ? `That program isn't there any more: ${tc.chosen}`
    : "Not found. Choose its program — a portable copy's totalcmd.exe works too — and the window's results can open " +
      "in its panel as a list, in DigUp's order.";
  $("tc-new-tab").checked = tc.newTab !== false;
}

/// Updates: this version, and where a new one is downloaded from. DigUp Plus releases by hand, so nothing checks or
/// installs anything on its own.
function renderUpdates() {
  $("update-version").textContent = `DigUp Plus ${info.version}`;
}

$("licenses").onclick = () => invoke("open_licenses").catch(fail);

$("download-version").onclick = () => invoke("open_releases").catch(fail);

/// A switch: the shell does it, or the box goes back and says why.
function wire(box, command) {
  box.addEventListener("change", async () => {
    $("problem").hidden = true;
    try {
      await invoke(command, { on: box.checked });
    } catch (error) {
      box.checked = !box.checked;
      fail(error);
    }
  });
}

wire($("login"), "set_open_at_login");
wire($("center"), "set_center_panel");
wire($("processor"), "set_processor_only");
wire($("confirm-move-copy"), "set_confirm_move_copy");
wire($("confirm-delete"), "set_confirm_delete");
wire($("include-datasets"), "set_include_datasets");
wire($("tc-new-tab"), "set_totalcmd_new_tab");

/// Total Commander's program: the picker, then the row says where the results now open.
$("tc-choose").onclick = async () => {
  try {
    if (await invoke("pick_totalcmd")) await refresh();
  } catch (error) {
    fail(error);
  }
};
for (const choice of document.querySelectorAll('input[name="tray-click"]')) {
  choice.addEventListener("change", () => {
    $("problem").hidden = true;
    invoke("set_tray_click", { click: choice.value }).then(() => { info.trayClick = choice.value; }).catch(fail);
  });
}

// MARK: The shortcut (where DigUp Plus grabs it itself: Windows, X11; shortcut.js)

let recording = false;

$("change-shortcut").onclick = () => {
  recording = true;
  $("problem").hidden = true;
  renderGeneral();
  recordShortcut((text) => { $("recording").textContent = text; }, (shown, problem) => {
    recording = false;
    if (shown) info.hotkey = shown;
    if (problem) fail(problem);
    renderGeneral();
  });
};

// MARK: Folders

/// How indexing goes: the status line, a bar while something's under way, the counts, and Pause or Resume.
function renderStatus() {
  const state = info.state || {};
  $("status-line").textContent = state.line || "";
  $("status-bar").hidden = state.progress == null;
  $("status-fill").style.width = `${Math.round(100 * (state.progress || 0))}%`;
  const parts = [`${(state.searchable || 0).toLocaleString()} of ${(state.files || 0).toLocaleString()} files searchable`];
  if (state.pending) parts.push(`${state.pending.toLocaleString()} waiting`);
  if (state.unfinished) parts.push(`${state.unfinished.toLocaleString()} long ${state.unfinished === 1 ? "file" : "files"} to finish`);
  if (state.asOf) parts.push(`last sync ${indexAge(state.asOf)}`);
  $("status-detail").textContent = parts.join(" · ");
  $("pause").hidden = !info.folders?.length;
  $("pause").textContent = state.paused ? "Resume" : "Pause";
}

$("pause").onclick = () => invoke("pause_indexing", { paused: !(info.state || {}).paused }).catch(fail);

async function loadSummaries() {
  try {
    summaries = (await ask({ op: "summaries" })).roots || [];
  } catch {
    summaries = summaries || [];
  }
  renderFolders();
}

function renderFolders() {
  const rows = $("folder-rows");
  rows.replaceChildren();
  if (!info.folders?.length) rows.append(element("div", "empty", "No folders yet. Add the ones DigUp Plus should search."));
  for (const folder of info.folders || []) {
    const summary = (summaries || []).find((item) => samePath(item.path, folder)) || null;
    rows.append(folderRow(folder, summary));
    if (movedAway(folder)) rows.append(movedNote(folder));
    if (removing && samePath(removing, folder)) rows.append(confirmRemoval(folder, summary));
    if (rereading && samePath(rereading, folder)) rows.append(confirmReread(folder));
    if (repicking && samePath(repicking.folder, folder)) rows.append(confirmRepick(repicking));
    if (ruling && samePath(ruling, folder)) rows.append(ruleEditor(folder));
  }
  const skipped = $("skipped-rows");
  skipped.replaceChildren();
  if (!info.skipped?.length) {
    skipped.append(element("div", "empty", "None. Code projects, app bundles and caches are skipped anyway."));
  }
  for (const folder of info.skipped || []) {
    const row = element("div", "row");
    const text = element("div", "text");
    text.append(element("div", "path", shown(folder)));
    row.append(text, removeButton("Search this folder again", () => {
      setSkipped(info.skipped.filter((path) => path !== folder));
    }));
    skipped.append(row);
  }
}

/// The fields: set from the settings when the window opens or they change, never while you're editing them.
function renderFields() {
  if (document.activeElement !== $("types")) $("types").value = (info.skipTypes || []).join(", ");
  if (document.activeElement !== $("tag-types")) $("tag-types").value = (info.tagTypes || []).join(", ");
  const hours = info.indexHours || { on: false, start: 60, end: 420 };
  $("hours").checked = hours.on;
  $("times").hidden = !hours.on;
  $("hours-start").value = clock(hours.start);
  $("hours-end").value = clock(hours.end);
}

/// A folder searched (with `code`, a code folder): its name, where it is, what's in it, how much of it is indexed, and
/// Remove.
/// One line per reason: what the crawl never queued from the folder, then what was skipped once read.
function reasonLines(leftOut, skippedReasons) {
  const crawl = {
    "other type": "of types DigUp Plus doesn't read",
    "app or bundle": "inside apps or bundles",
    "Photos library": "in a Photos library",
    "link or special file": "links or special files",
    "in the cloud, not downloaded": "only in the cloud, not downloaded",
    "inside a code project": "inside code projects, where only screenshots count",
    "dataset": "in folders that look like datasets",
    "code or data file": "code or data files",
    "excluded type": "of the file types you skip",
    "of a kind this folder doesn't index": "of a kind this folder doesn't index",
    "beyond the top level": "below the top level you chose",
  };
  const byCount = (a, b) => b[1] - a[1];
  const left = Object.entries(leftOut).sort(byCount).map(([reason, count]) =>
    reason.startsWith("folders ") ? `${count.toLocaleString()} folders weren't opened (${reason.slice(8)})` : `${count.toLocaleString()} ${crawl[reason] || reason}`);
  const skipped = Object.entries(skippedReasons).sort(byCount).map(([reason, count]) => `${count.toLocaleString()} skipped: ${reason}`);
  return left.concat(skipped);
}

function folderRow(folder, summary, code = false) {
  const row = element("div", "row");
  const text = element("div", "text");
  const name = element("div", "name", nameOf(folder));
  if (summary?.missing || summary?.unreadable) name.append(element("span", "flag", summary.missing ? "Not connected" : "No access"));
  text.append(name, element("div", "path", shown(folder)));
  if (summary && Object.keys(summary.kinds || {}).length) text.append(element("div", "counts", countsText(summary.kinds)));
  // A rule of its own (Rules…): what it takes, so the folder's line says why it holds fewer files.
  const rule = Object.entries(info.rootRules || {}).find(([path]) => samePath(path, folder))?.[1];
  if (rule) text.append(element("div", "counts", ruleText(rule)));
  const side = element("div", "side");
  if (summary) {
    side.append(element("div", "indexed", summary.missing || summary.unreadable ? "Kept for when it's back"
      : `${summary.indexed.toLocaleString()} of ${summary.files.toLocaleString()} indexed`));
    // What the last sync never queued from this folder, by reason (the helper's left_out, through the status).
    const leftOutKey = Object.keys((info.state || {}).leftOut || {}).find((path) => samePath(path, folder));
    const leftOut = code || !leftOutKey ? {} : info.state.leftOut[leftOutKey];
    const notRead = Object.values(leftOut).reduce((sum, count) => sum + count, 0);
    const states = [
      summary.pending ? `${summary.pending.toLocaleString()} waiting` : null,
      summary.unfinished ? `${summary.unfinished.toLocaleString()} long ${summary.unfinished === 1 ? "file" : "files"} to finish` : null,
      summary.skipped ? `${summary.skipped.toLocaleString()} skipped` : null,
      summary.failed ? `${summary.failed.toLocaleString()} couldn't be read` : null,
      notRead ? `${notRead.toLocaleString()} not read` : null,
    ].filter(Boolean).join(" · ");
    if (states) {
      const line = element("div", "states", states);
      const reasons = reasonLines(leftOut, summary.skipped_reasons || {});
      if (reasons.length) {
        const why = element("button", "why", "why");
        why.title = "Why some files aren't searchable";
        const list = element("div", "reasons");
        list.hidden = true;
        for (const reason of reasons) list.append(element("div", null, reason));
        why.onclick = () => { list.hidden = !list.hidden; };
        line.append(" ", why);
        text.append(list);
      }
      side.append(line);
    }
  }
  row.append(text, side, ...(code ? [] : [rescanButton(folder), rereadButton(folder), repickButton(folder),
    ruleButton(folder)]),
    removeButton(code ? "Stop searching the code in this folder" : "Stop searching this folder", () => {
    if (code) {
      removingCode = folder;
      renderCode();
    } else {
      removing = folder;
      renderFolders();
    }
  }));
  return row;
}

/// "Rescan": walks this folder again — new, gone and changed files — without reading anything again.
function rescanButton(folder) {
  const button = element("button", "link", "Rescan");
  button.title = "Look through this folder again: new, gone and changed files";
  button.onclick = async () => {
    try {
      await invoke("rescan_folder", { folder });
    } catch (error) {
      fail(error);
    }
    await refresh();
  };
  return button;
}

/// "Re-read…": asks first, then queues every file in the folder.
function rereadButton(folder) {
  const button = element("button", "link", "Re-read…");
  button.title = "Read every file in this folder again";
  button.onclick = () => {
    rereading = rereading && samePath(rereading, folder) ? null : folder;
    renderFolders();
  };
  return button;
}

/// The question before a folder is read again: what it holds and roughly how long, because its files leave the index
/// while they are read (the estimate is the same one the folder list uses).
function confirmReread(folder) {
  const box = element("div", "confirm");
  box.append(element("p", "", `Read every file in “${nameOf(folder)}” again? They leave the index while they are read.`));
  const estimate = element("div", "note", "Looking at it…");
  box.append(estimate);
  invoke("estimate", { folders: [folder] }).then((answers) => {
    const answer = answers?.[0];
    const files = Object.values(answer?.files || {}).reduce((sum, count) => sum + count, 0);
    estimate.textContent = answer
      ? `${files.toLocaleString()} files · about ${Math.max(1, Math.round(answer.seconds || 0))} s to read`
      : "";
  }).catch(() => { estimate.textContent = ""; });
  const actions = element("div", "actions");
  const cancel = element("button", "", "Cancel");
  cancel.onclick = () => { rereading = null; renderFolders(); };
  const go = element("button", "danger", "Re-read");
  go.onclick = async () => {
    rereading = null;
    try {
      await invoke("reread_folder", { folder });
    } catch (error) {
      fail(error);
    }
    await refresh();
  };
  actions.append(cancel, go);
  box.append(actions);
  return box;
}

/// "Re-pick…": the folder moved to another place. The picker chooses it, then the confirmation says what the move means
/// for the rows: how many files are there unchanged, how many will be read again, how many are gone.
function repickButton(folder) {
  const button = element("button", "link", "Re-pick…");
  button.title = "The folder moved: choose where it is now";
  button.onclick = () => repickPreview(folder);
  return button;
}

async function repickPreview(folder) {
  try {
    const preview = await invoke("repick_preview", { folder });
    if (!preview) return;   // the picker was cancelled
    repicking = { folder, ...preview };
    renderFolders();
  } catch (error) {
    fail(error);
  }
}

function confirmRepick(repick) {
  const box = element("div", "confirm repick");
  box.append(element("p", "", `Move “${nameOf(repick.folder)}” to “${nameOf(repick.target)}”?`));
  box.append(element("div", "note",
    `${repick.matched.toLocaleString()} of ${repick.rows.toLocaleString()} files are there unchanged · ` +
    `${repick.changed.toLocaleString()} will be read again · ${repick.missing.toLocaleString()} aren't there`));
  const actions = element("div", "actions");
  const cancel = element("button", "", "Cancel");
  cancel.onclick = () => { repicking = null; renderFolders(); };
  const go = element("button", "primary", "Re-pick");
  go.onclick = async () => {
    const current = repicking;
    repicking = null;
    try {
      await invoke("repick_apply", { folder: current.folder, target: current.target });
    } catch (error) {
      fail(error);
    }
    await refresh();
  };
  actions.append(cancel, go);
  box.append(actions);
  return box;
}

/// A chosen folder that is there but empty while its rows are still in the index: its files moved out (or were
/// deleted). The rows stay until this is answered, so nothing read is lost.
function movedAway(folder) {
  return (info.state?.emptyRoots || []).some((path) => samePath(path, folder));
}

function movedNote(folder) {
  const box = element("div", "confirm");
  box.append(element("p", "",
    `“${nameOf(folder)}” is empty, but its files are still in the index. Did the folder move?`));
  const actions = element("div", "actions");
  const moved = element("button", "primary", "Moved…");
  moved.onclick = () => repickPreview(folder);
  const deleted = element("button", "", "Files deleted");
  deleted.onclick = async () => {
    try {
      await invoke("forget_folder", { folder });
    } catch (error) {
      fail(error);
    }
    await refresh();
  };
  const stop = element("button", "link", "Stop searching");
  stop.onclick = () => { removing = folder; renderFolders(); };
  actions.append(moved, deleted, stop);
  box.append(actions);
  return box;
}

/// "Rules": what this folder holds, and whether its subfolders are walked.
function ruleButton(folder) {
  const button = element("button", "link", "Rules");
  button.title = "Choose what this folder indexes, and how deep to look";
  button.onclick = () => {
    ruling = ruling && samePath(ruling, folder) ? null : folder;
    renderFolders();
  };
  return button;
}

// What a folder's rule offers: the file kinds, with screenshots counted as pictures (a screenshot is a picture with a
// kind of its own in the index, and "only pictures" must not drop them). Recordings are not a box here: their two bits
// decide whether they're in the rule at all (either one puts `audio` in the kinds).
const RULE_KINDS = [["image", "Pictures"], ["pdf", "PDFs"], ["doc", "Documents"], ["video", "Videos"]];

/// A folder's rule, in place under its row: the kinds it holds, how its recordings are read, and whether its
/// subfolders are.
function ruleEditor(folder) {
  const saved = Object.entries(info.rootRules || {}).find(([path]) => samePath(path, folder));
  const rule = saved ? saved[1] : { kinds: [], shallow: false };
  const inKinds = (rule.kinds || []).includes("audio");
  // A rule saved before the bits existed read recordings exactly when its kinds included them.
  const tags = rule.audioTags ?? inKinds;
  const content = rule.audioContent ?? inKinds;
  const box = element("div", "confirm rules");
  box.append(element("p", "", `What “${nameOf(folder)}” holds:`));
  const checks = RULE_KINDS.map(([kind, label]) => {
    const choice = element("label", "choice");
    const input = document.createElement("input");
    input.type = "checkbox";
    // No kinds in the rule: everything. Pictures send the screenshot kind too.
    input.checked = rule.kinds.length === 0 || rule.kinds.includes(kind);
    input.dataset.kind = kind;
    choice.append(input, label);
    box.append(choice);
    return input;
  });
  const audioChoice = (label, checked) => {
    const choice = element("label", "choice");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    choice.append(input, label);
    box.append(choice);
    return input;
  };
  const tagsBox = audioChoice("Recordings by their tags", tags);
  const contentBox = audioChoice("Recordings by their sound", content);
  const hint = element("p", "note", "No types are set in “Audio types read by tags” above: recordings will be skipped.");
  hint.hidden = !(tags && !info.tagTypes?.length);
  box.append(hint);
  tagsBox.onchange = contentBox.onchange = () => { hint.hidden = !(tagsBox.checked && !info.tagTypes?.length); };
  // Types this folder leaves out on top of the ones skipped everywhere: "html, log".
  const skipLabel = element("label", "option");
  skipLabel.append(element("span", "text", "Skip types"));
  const skip = document.createElement("input");
  skip.type = "text";
  skip.className = "field";
  skip.placeholder = "html, log";
  skip.value = (rule.skipTypes || []).join(", ");
  skipLabel.append(skip);
  box.append(skipLabel);
  const shallow = element("label", "choice");
  const depth = document.createElement("input");
  depth.type = "checkbox";
  // Same switch as the add-folders screen: on, the subfolders are read; off, nothing below this folder is.
  depth.checked = !rule.shallow;
  shallow.append(depth, "Scan its subfolders");
  box.append(shallow);
  const actions = element("div", "actions");
  const cancel = element("button", "", "Cancel");
  cancel.onclick = () => { ruling = null; renderFolders(); };
  const save = element("button", "", "Save");
  save.onclick = async () => {
    const chosen = checks.filter((input) => input.checked).map((input) => input.dataset.kind);
    // Pictures means pictures and screenshots; recordings join the kinds when either of their bits is on.
    let kinds = chosen.includes("image") ? [...chosen, "screenshot"] : chosen;
    if (tagsBox.checked || contentBox.checked) kinds = [...kinds, "audio"];
    if (!kinds.length) {
      hint.hidden = false;
      hint.textContent = "Choose at least one kind of file to search in this folder.";
      return;
    }
    try {
      const skipTypes = skip.value.split(",").map((type) => type.trim()).filter(Boolean);
      await invoke("set_root_rule", { folder, kinds, shallow: !depth.checked,
                                      audioTags: tagsBox.checked, audioContent: contentBox.checked, skipTypes });
      ruling = null;
      await refresh();
    } catch (error) {
      fail(error);
    }
  };
  actions.append(cancel, save);
  box.append(actions);
  return box;
}

/// A folder's rule in words, for its line: "pictures only · recordings by tags · top level only".
function ruleText(rule) {
  const names = { image: "pictures", pdf: "PDFs", doc: "documents", video: "videos" };
  const inKinds = (rule.kinds || []).includes("audio");
  const tags = rule.audioTags ?? inKinds;
  const content = rule.audioContent ?? inKinds;
  const kinds = (rule.kinds || []).filter((kind) => kind !== "screenshot" && kind !== "audio")
    .map((kind) => names[kind] || kind);
  const parts = [];
  if (kinds.length) parts.push(`${kinds.join(", ")} only`);
  if (tags && content) parts.push("recordings by tags and sound");
  else if (tags) parts.push("recordings by tags only");
  else if (content) parts.push("recordings by sound");
  if ((rule.skipTypes || []).length) parts.push(`skips ${rule.skipTypes.join(", ")}`);
  if (rule.shallow) parts.push("top level only");
  return parts.join(" · ");
}

/// "Stop searching “Pictures”?", in place, as the Mac app asks.
function confirmRemoval(folder, summary, code = false) {
  const box = element("div", "confirm");
  const files = summary ? `Its ${summary.files.toLocaleString()} ${summary.files === 1 ? "file leaves" : "files leave"}` : "Its files leave";
  const last = code && (info.code?.folders || []).length === 1;
  box.append(element("p", "", code
    ? `Stop searching the code in “${nameOf(folder)}”? ${files} the code index.${last ? " That turns code search off." : ""}`
    : `Stop searching “${nameOf(folder)}”? ${files} the index. Adding it back later indexes them again.`));
  const actions = element("div", "actions");
  const cancel = element("button", "", "Cancel");
  cancel.onclick = () => {
    removing = removingCode = null;
    renderFolders();
    renderCode();
  };
  const remove = element("button", "danger", "Remove");
  remove.onclick = async () => {
    removing = removingCode = null;
    if (!code) ruling = null;
    try {
      await invoke(code ? "remove_code_folder" : "remove_folder", { folder });
    } catch (error) {
      fail(error);
    }
    await refresh();
  };
  actions.append(cancel, remove);
  box.append(actions);
  return box;
}

function removeButton(title, action) {
  const button = element("button", "remove", "−");
  button.title = title;
  button.setAttribute("aria-label", title);
  button.onclick = action;
  return button;
}

async function setSkipped(skipped) {
  try {
    await invoke("set_skipped", { skipped });
  } catch (error) {
    fail(error);
  }
  await refresh();
}

$("add-folders").onclick = () => invoke("choose_folders").catch(fail);
$("skip-folder").onclick = async () => {
  const picked = await invoke("pick_folders");
  if (picked.length) setSkipped([...(info.skipped || []), ...picked.filter((path) => !info.skipped.includes(path))]);
};

// File types: applied on Return, and when the field is left.
async function applyTypes() {
  try {
    info.skipTypes = await invoke("set_skip_types", { types: $("types").value });
    $("types").value = info.skipTypes.join(", ");
  } catch (error) {
    fail(error);
  }
}
$("types").addEventListener("keydown", (event) => { if (event.key === "Enter") applyTypes(); });
$("types").addEventListener("blur", applyTypes);

// Recording types read by their tags alone: applied the same way.
async function applyTagTypes() {
  try {
    info.tagTypes = await invoke("set_tag_types", { types: $("tag-types").value });
    $("tag-types").value = info.tagTypes.join(", ");
  } catch (error) {
    fail(error);
  }
}
$("tag-types").addEventListener("keydown", (event) => { if (event.key === "Enter") applyTagTypes(); });
$("tag-types").addEventListener("blur", applyTagTypes);

async function applyHours() {
  const on = $("hours").checked;
  const hours = { on, start: minutes($("hours-start").value, 60), end: minutes($("hours-end").value, 420) };
  $("times").hidden = !on;
  try {
    await invoke("set_index_hours", hours);
    info.indexHours = hours;
  } catch (error) {
    fail(error);
  }
}
$("hours").addEventListener("change", applyHours);
$("hours-start").addEventListener("change", applyHours);
$("hours-end").addEventListener("change", applyHours);

// MARK: Code

async function loadCodeSummaries() {
  if (!(info.code?.folders || []).length) {
    codeSummaries = [];
  } else {
    try {
      codeSummaries = (await ask({ op: "summaries", code: true })).roots || [];
    } catch {
      codeSummaries = codeSummaries || [];
    }
  }
  renderCode();
}

function renderCode() {
  const code = info.code || { folders: [], editors: [], editor: "default" };
  const on = code.folders.length > 0;
  // How far the code index is, over all code folders.
  const total = { files: 0, indexed: 0, pending: 0 };
  for (const summary of codeSummaries || []) {
    for (const name of Object.keys(total)) total[name] += summary[name] || 0;
  }
  $("code-status").hidden = !on || codeSummaries == null;
  $("code-status-line").textContent = total.pending
    ? `Reading code: ${total.indexed.toLocaleString()} of ${total.files.toLocaleString()} files`
    : `${total.indexed.toLocaleString()} ${total.indexed === 1 ? "file" : "files"} of code searchable`;
  const size = info.storage?.codeBytes;
  $("code-status-detail").textContent = size ? `The code index takes ${bytes(size)}` : "";

  const rows = $("code-rows");
  rows.replaceChildren();
  if (!on) rows.append(element("div", "empty", "Code search is off. Choose the folders that hold your code to turn it on."));
  for (const folder of code.folders) {
    const summary = (codeSummaries || []).find((item) => samePath(item.path, folder)) || null;
    rows.append(folderRow(folder, summary, true));
    if (removingCode && samePath(removingCode, folder)) rows.append(confirmRemoval(folder, summary, true));
  }
  $("add-code").textContent = on ? "Add Folders…" : "Choose Code Folders…";

  const select = $("code-editor");
  const options = [...code.editors, { id: "default", name: "The file's default app" }];
  select.replaceChildren(...options.map((editor) => {
    const option = element("option", "", editor.name);
    option.value = editor.id;
    return option;
  }));
  select.value = code.editor;
  $("code-off").hidden = !on || !$("code-off-confirm").hidden;
}

$("add-code").onclick = () => invoke("choose_code_folders").catch(fail);
$("code-editor").addEventListener("change", async () => {
  try {
    await invoke("set_code_editor", { editor: $("code-editor").value });
    info.code.editor = $("code-editor").value;
  } catch (error) {
    fail(error);
  }
});
$("code-off").onclick = () => {
  const size = info.storage?.codeBytes;
  $("code-off-text").textContent = "Turn off code search? Its index" + (size ? ` (${bytes(size)})` : "")
    + " is deleted, and turning it on again reads the code again.";
  $("code-off-confirm").hidden = false;
  $("code-off").hidden = true;
};
$("code-off-cancel").onclick = () => {
  $("code-off-confirm").hidden = true;
  renderCode();
};
$("code-off-go").onclick = async () => {
  $("code-off-confirm").hidden = true;
  try {
    await invoke("turn_off_code");
  } catch (error) {
    fail(error);
  }
  await refresh();
};

// MARK: Storage

function renderStorage() {
  const storage = info.storage || {}, model = (info.state || {}).model || {};
  const transfer = info.transfer || storage.transfer || { state: "idle" };
  const states = {
    ready: "Downloaded", checking: "Checking…", waiting: "Waiting for the network", failed: "The download stopped",
    missing: "Not installed", unavailable: "The model folder is unavailable", verifying: "Checking files…",
  };
  $("model-status").textContent = model.state === "downloading"
    ? `Downloading · ${model.total ? Math.floor((100 * model.bytes) / model.total) : 0}%` : states[model.state] || "";
  pathButton($("model-path"), storage.models);
  const busy = ["working", "verifying", "waiting"].includes(transfer.state);
  const downloading = model.state === "downloading";
  // The speed check holds the model: changing the folder or deleting the files waits for it (the shell refuses too).
  // Checking the files only reads them, so it may go on.
  const measuring = (info.state || {}).measuring === true;
  for (const id of ["model-change", "model-files", "model-download", "model-delete", "model-cleanup-delete"]) {
    $(id).disabled = busy || downloading || measuring;
  }
  $("index-use").disabled = indexBusy;
  $("index-change").disabled = indexBusy || measuring;
  // The speed check blocks only the move (the shell refuses while it runs); the switch just writes a path and may go
  // on — which is exactly what a person wants while indexing starts over on a folder that lost its index.
  $("index-use").title = "Use an index you already have, where it is";
  $("index-change").title = measuring
    ? "The speed check is running; the move waits for it to end."
    : "Move the index to another folder";
  $("model-check").disabled = busy || downloading;
  $("model-download").hidden = !(storage.modelRemoved || ["missing", "failed"].includes(model.state));
  $("model-delete").hidden = ["missing", "unavailable"].includes(model.state);
  $("model-transfer-row").hidden = ["idle", "done"].includes(transfer.state);
  $("model-transfer").textContent = transferText(transfer);
  const cleanup = storage.modelCleanup;
  $("model-cleanup").hidden = !cleanup;
  $("model-cleanup-text").textContent = cleanup
    ? `Old model files: ${shown(cleanup)} · ${bytes(storage.modelCleanupBytes || 0)}` : "";
  const note = transfer.state === "working" && transfer.problem ? transfer.problem
    : model.state === "failed" ? model.message : transfer.state === "failed" ? transfer.message : modelMessage;
  const problem = model.state === "failed" || transfer.state === "failed" || modelProblem;
  $("model-note").hidden = !note;
  $("model-note").textContent = note || "";
  $("model-note").className = "note" + (problem ? " problem" : "");
  $("index-size").textContent = bytes(storage.indexBytes || 0) + (storage.codeBytes ? ` (code ${bytes(storage.codeBytes)})` : "");
  pathButton($("index-path"), storage.index);
  $("data-row").hidden = !storage.data;
  pathButton($("data-path"), storage.data);
  $("index-change").disabled = indexBusy || measuring;
  $("index-note").hidden = !indexMessage;
  $("index-note").textContent = indexMessage;
  $("index-note").className = "note" + (indexProblem ? " problem" : "");
  $("version").textContent = `DigUp Plus ${info.version || ""} · EmbeddingGemma 2 by Google (Apache 2.0), run by llama.cpp (MIT).`;
  $("licenses").hidden = !info.licenses;
}

function transferText(transfer) {
  if (transfer.state === "waiting") return "Waiting for the network";
  if (transfer.state === "verifying") return `Checking ${transfer.name || "the model files"}…`;
  if (transfer.state === "working") {
    const percent = transfer.allTotal ? Math.floor((100 * (transfer.allBytes || 0)) / transfer.allTotal) : null;
    return percent != null ? `${percent}%` : transfer.name ? `Working on ${transfer.name}…` : "Working…";
  }
  if (transfer.state === "failed") return "It didn't finish";
  return "";
}

/// The model question under the facts: `go` is the button, `alternate` the second choice (a download instead of a
/// move), and `danger` paints the main button red.
function askModel(text, go, run, alternate, alternateLabel, danger) {
  modelConfirm = { run, alternate };
  $("model-confirm-text").textContent = text;
  $("model-confirm-go").textContent = go;
  $("model-confirm-go").className = danger ? "danger" : "";
  $("model-confirm-alt").hidden = !alternate;
  $("model-confirm-alt").textContent = alternate ? alternateLabel : "";
  $("model-confirm").hidden = false;
}

function closeModelConfirm() {
  modelConfirm = null;
  $("model-confirm").hidden = true;
}

function modelNote(text, problem = false) {
  modelMessage = text || "";
  modelProblem = problem;
  renderStorage();
}

async function changeModelFolder() {
  try {
    const picked = await invoke("pick_model_folder");
    if (!picked) return;
    const plan = await invoke("model_folder_plan", { target: picked });
    if (plan.kind === "invalid") {
      modelNote(plan.problem || "That folder can't be used.", true);
      return;
    }
    const target = plan.target;
    if (plan.kind === "use") {
      askModel(`Use the model files in ${shown(target)}? They're checked before DigUp Plus switches; nothing is copied.`,
               "Use Files", () => applyModelFolder(target, "use"));
    } else if (plan.kind === "move") {
      askModel(`Move the model files to ${shown(target)}? They're copied and checked, and the old folder stays until the new
        copy is ready.${plan.canDownload ? " You can download a second copy instead." : ""}`,
               "Move", () => applyModelFolder(target, "move"),
               plan.canDownload ? () => applyModelFolder(target, "download") : null,
               "Download a Copy");
    } else {
      askModel(`Download the model (865 MB) to ${shown(target)}? The current model stays usable until it's ready.`,
               "Download", () => applyModelFolder(target, "download"));
    }
  } catch (error) {
    modelNote(String(error), true);
  }
}

async function applyModelFolder(target, action) {
  modelMessage = "";
  modelProblem = false;
  // The first event comes once the helper starts; until then the buttons must already know it's busy.
  info.transfer = { state: "working" };
  renderStorage();
  try {
    await invoke("model_folder_apply", { target, action });
  } catch (error) {
    info.transfer = { state: "idle" };
    modelNote(String(error), true);
    await refresh();
  }
  // A finished or failed transfer sends `model-files`, which asks the settings again.
}

async function useModelFiles() {
  try {
    const files = await invoke("pick_model_files");
    if (!files.length) return;
    if (files.length !== 2) {
      modelNote("Choose both model files: embeddinggemma-2-Q8_0.gguf and mmproj-embeddinggemma-2-Q8_0.gguf.", true);
      return;
    }
    const folders = files.map((file) => file.replace(/[\\/][^\\/]*$/, ""));
    if (folders.every((folder) => samePath(folder, folders[0]))) {
      const plan = await invoke("model_folder_plan", { target: folders[0] });
      if (plan.kind !== "use") {
        modelNote(plan.problem || "Those files aren't both the right size for this model.", true);
        return;
      }
      askModel(`Use the model files in ${shown(plan.target)}? They're checked before DigUp Plus switches.`,
               "Use Files", () => applyModelFolder(plan.target, "use"));
      return;
    }
    const target = (info.storage || {}).models;
    if (!target) {
      modelNote("DigUp Plus has no model folder to copy them into.", true);
      return;
    }
    askModel(`Copy the model files into ${shown(target)}? Each is checked before it replaces anything.`,
             "Copy Files", async () => {
               modelMessage = "";
               modelProblem = false;
               info.transfer = { state: "working" };
               renderStorage();
               try {
                 await invoke("model_import", { files });
               } catch (error) {
                 info.transfer = { state: "idle" };
                 modelNote(String(error), true);
                 await refresh();
               }
             });
  } catch (error) {
    modelNote(String(error), true);
  }
}

async function checkModelFiles() {
  try {
    const result = await invoke("model_check");
    if (result.ok) {
      modelNote(`${result.files.length} of ${result.files.length} files verified.`);
    } else {
      const bad = (result.files || []).find((file) => !file.ok);
      modelNote(bad ? `${bad.name}: ${bad.problem || "not usable"}` : "The model files aren't usable.", true);
    }
  } catch (error) {
    modelNote(String(error), true);
  }
}

async function downloadModelFiles() {
  try {
    await invoke("download_model");
    modelMessage = "";
    modelProblem = false;
  } catch (error) {
    modelNote(String(error), true);
  }
  await refresh();
}

function askDeleteModelFiles() {
  const storage = info.storage || {};
  const files = (storage.modelFiles || []).map((file) => `${file.name} (${file.bytes ? bytes(file.bytes) : ""})`).join("\n");
  askModel(`Delete the model files from ${shown(storage.models || "")}?\n${files}\n\nSearch keeps finding files by name, but
    indexing stops until the model is downloaded again. The index stays, so nothing is read again.`,
           "Delete Files", async () => {
             try {
               await invoke("delete_model_files");
               modelMessage = "";
               modelProblem = false;
             } catch (error) {
               modelNote(String(error), true);
             }
             await refresh();
           }, null, null, true);
}

function askDeleteOldModelFiles() {
  const storage = info.storage || {};
  askModel(`Delete the old model files in ${shown(storage.modelCleanup || "")} (${bytes(storage.modelCleanupBytes || 0)})?`,
           "Delete Old Files", async () => {
             try {
               await invoke("delete_old_model_files");
               modelMessage = "";
               modelProblem = false;
             } catch (error) {
               modelNote(String(error), true);
             }
             await refresh();
           }, null, null, true);
}

async function copyModelLinks() {
  try {
    const manifest = await invoke("model_manifest");
    const links = (manifest.files || []).map((file) => file.url).join("\n");
    await navigator.clipboard.writeText(links);
    modelNote("The two download links are on the clipboard.");
  } catch (error) {
    modelNote(String(error), true);
  }
}

// MARK: Index actions

function indexNote(text, problem = false) {
  indexMessage = text || "";
  indexProblem = problem;
  renderStorage();
}

function askIndex(text, run) {
  indexConfirm = run;
  $("index-confirm-text").textContent = text;
  $("index-confirm-go").textContent = "Move Index";
  $("index-confirm").hidden = false;
}

function closeIndexConfirm() {
  indexConfirm = null;
  $("index-confirm").hidden = true;
}

/// Storage → Use Existing Index…: the index in the folder the person picks is used where it is (nothing is copied). The
/// helpers stop and come back on it, so search and indexing use it from now on.
async function useExistingIndex() {
  try {
    const picked = await invoke("pick_destination_folder", { title: "Choose the Folder with the Index" });
    if (!picked) return;
    indexBusy = true;
    indexMessage = "Using the index in that folder…";
    indexProblem = false;
    renderStorage();
    try {
      const result = await invoke("index_folder_use", { folder: picked });
      indexMessage = result.existing
        ? `Using the index in ${shown(result.index)}. Nothing was copied.`
        : `${shown(result.index)} is empty: a new index will be kept there.`;
    } catch (error) {
      indexMessage = String(error);
      indexProblem = true;
    }
  } catch (error) {
    indexMessage = String(error);
    indexProblem = true;
  } finally {
    indexBusy = false;
  }
  await refresh().catch(() => {});
  renderStorage();
}

async function changeIndexFolder() {
  try {
    const picked = await invoke("pick_destination_folder", { title: "Move the Index to…" });
    if (!picked) return;
    const plan = await invoke("index_folder_plan", { target: picked });
    if (plan.kind === "same") {
      indexNote("The index is already in this folder.");
      return;
    }
    if (plan.kind !== "move") {
      indexNote(plan.problem || "That folder can't take the index.", true);
      return;
    }
    askIndex(`Move the index (${bytes(plan.bytes || 0)}) to ${shown(plan.target)}?\n\nIndexing pauses while the files are
      copied. They are checked before DigUp Plus switches; the old files are removed only after that.`,
             () => moveIndex(plan.target));
  } catch (error) {
    indexNote(String(error), true);
  }
}

async function moveIndex(target) {
  indexBusy = true;
  indexMessage = "Moving the index…";
  indexProblem = false;
  renderStorage();
  try {
    const result = await invoke("move_index", { target });
    if (result.cleanup === false) {
      indexMessage = `The index is now in ${shown(result.target)}, but the old files couldn't be removed: `
        + (result.left || []).join(", ");
      indexProblem = true;
    } else {
      indexMessage = `The index is now in ${shown(result.target)}.`;
    }
  } catch (error) {
    indexMessage = String(error);
    indexProblem = true;
  } finally {
    indexBusy = false;
  }
  await refresh().catch(() => {});
  renderStorage();
}

$("index-use").onclick = () => useExistingIndex();
$("done").onclick = () => invoke("close_window").catch(() => {});
$("index-change").onclick = () => changeIndexFolder();
$("index-confirm-cancel").onclick = () => closeIndexConfirm();
$("index-confirm-go").onclick = () => {
  const run = indexConfirm;
  closeIndexConfirm();
  run?.();
};

/// A folder's path; a click shows it in the file manager.
function pathButton(button, path) {
  button.replaceChildren();
  if (!path) return;
  const inner = document.createElement("bdi");
  inner.textContent = shown(path);
  button.append(inner);
  button.title = isWindows ? "Show in Explorer" : "Show in Files";
  button.onclick = () => invoke("reveal", { path }).catch(fail);
}

// MARK: Words

function countsText(kinds) {
  const part = (count, one, many) => (count > 0 ? `${count.toLocaleString()} ${count === 1 ? one : many}` : null);
  return [
    part((kinds.image || 0) + (kinds.screenshot || 0), "picture", "pictures"),
    part(kinds.pdf, "PDF", "PDFs"),
    part(kinds.doc, "document", "documents"),
    part(kinds.audio, "recording", "recordings"),
    part(kinds.video, "video", "videos"),
    part(kinds.code, "file of code", "files of code"),
  ].filter(Boolean).join(" · ");
}

/// Sizes the way file managers count them: "62 KB", "2.1 MB".
function bytes(count) {
  if (count < 1000) return `${count} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = count / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function clock(minute) {
  return `${String(Math.trunc(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function minutes(text, fallback) {
  const match = /^(\d{1,2}):(\d{2})/.exec(text || "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

function nameOf(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function shown(path) {
  return isWindows ? path.replaceAll("/", "\\") : path;
}

function samePath(a, b) {
  const plain = (path) => (path || "").replaceAll("\\", "/").replace(/\/$/, "");
  return isWindows ? plain(a).toLowerCase() === plain(b).toLowerCase() : plain(a) === plain(b);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fail(error) {
  $("problem").textContent = String(error);
  $("problem").hidden = false;
}

// MARK: Model actions

$("model-change").onclick = () => changeModelFolder();
$("model-files").onclick = () => useModelFiles();
$("model-check").onclick = () => checkModelFiles();
$("model-download").onclick = () => downloadModelFiles();
$("model-delete").onclick = () => askDeleteModelFiles();
$("model-cleanup-delete").onclick = () => askDeleteOldModelFiles();
$("model-links").onclick = () => copyModelLinks();

/// The MCP config, as the agent apps take it: copied, with its file named, since nothing writes into their settings.
$("agent-config").onclick = async () => {
  const note = $("agent-note");
  try {
    const config = await invoke("mcp_config");
    await navigator.clipboard.writeText(config);
    note.textContent = "On the clipboard. Merge it into the “mcpServers” object of claude_desktop_config.json "
      + "(Claude Desktop), .mcp.json (Claude Code) or ~/.cursor/mcp.json (Cursor), then restart that app.";
    note.hidden = false;
  } catch (error) {
    note.textContent = String(error);
    note.hidden = false;
  }
};
$("model-confirm-cancel").onclick = () => closeModelConfirm();
$("model-confirm-go").onclick = () => {
  const action = modelConfirm;
  closeModelConfirm();
  action?.run();
};
$("model-confirm-alt").onclick = () => {
  const action = modelConfirm;
  closeModelConfirm();
  action?.alternate?.();
};

// The move copies the databases through temporary names, so the destination fills only at the end: the running
// total comes from the shell, or a big index would look stuck.
tauri.event.listen("index-move", ({ payload }) => {
  if (!indexBusy || !payload.total) return;
  indexMessage = `Moving the index… ${Math.floor((100 * payload.bytes) / payload.total)}%`;
  renderStorage();
});

tauri.event.listen("model-transfer", ({ payload }) => {
  info.transfer = payload;
  renderStorage();
});

// The folder or its files changed (a transfer finished, old files went): the facts and buttons are asked again.
tauri.event.listen("model-files", () => { refresh().catch(() => {}); });

// MARK: Start

async function refresh() {
  info = await invoke("settings_info");
  renderGeneral();
  renderStatus();
  renderFolders();
  renderFields();
  renderSearch();
  renderStorage();
  renderCode();
  if (!$("folders").hidden) loadSummaries();
  if (!$("code").hidden) loadCodeSummaries();
}

// Back from the code folders window (or anything else that changed the settings): shown as they are now.
window.addEventListener("focus", () => { refresh().catch(() => {}); });

// Indexing as it goes, and what's indexed under each folder at most every two seconds.
let summariesTimer = null;
// The index's age grows between events: "last sync 2 min ago" is redrawn without one.
setInterval(() => { if (info.state) renderStatus(); }, 30000);
tauri.event.listen("state", ({ payload }) => {
  const before = info.state || {};
  info.state = payload;
  renderStatus();
  renderStorage();
  renderUpdates();
  // The code index's progress isn't in the state: its folders are asked again while the tab is up.
  const counts = payload.searchable !== before.searchable || payload.pending !== before.pending;
  const load = !$("folders").hidden && counts ? loadSummaries : !$("code").hidden ? loadCodeSummaries : null;
  if (load && !summariesTimer) {
    summariesTimer = setTimeout(() => { summariesTimer = null; load(); }, 2000);
  }
});

async function start() {
  await refresh();
  // Debug runs (--debug-settings): the page is up.
  if (info.debug) {
    invoke("debug_report", { report: { settings: true, hotkey: info.hotkey, openAtLogin: info.openAtLogin,
                                       canOpenAtLogin: info.canOpenAtLogin, folders: info.folders } }).catch(() => {});
  }
  const asked = new URLSearchParams(location.search).get("tab");   // dev snapshots: ?tab=folders
  showTab(asked || "general");
}

start();
