// The fields of a folder's rule, shared by Settings and the setup's folders page. Pictures are two choices that work
// together, as a recording's tags and sound do: index the look (the Pictures box) and read the words (Text on pictures).
// Either one keeps the folder's pictures in the rule; Pictures off with Text on keeps only their words, never an Images
// result. Documents is one box for PDFs and text documents (one section in the window). Both pages used to build these
// on their own, and the setup's copy didn't know the OCR fields, so saving it wiped them.
"use strict";

// A rule's picture bits, with "not stored yet" read from its kinds: a rule saved before the bits existed looked at
// the pictures its kinds included, and read screenshots' words. A rule with an explicit look bit and no text choice
// reads screenshots' words (the text default).
function pictureBits(rule) {
  const kinds = rule.kinds || [];
  const included = kinds.length === 0 || kinds.includes("image") || kinds.includes("screenshot");
  const looks = rule.looksPictures ?? (rule.ocrPictures != null ? true : included);
  const text = rule.ocrPictures ?? (rule.looksPictures != null ? "screenshots" : included ? "screenshots" : "off");
  return { looks, text };
}

/// Appends a rule's fields to `box` and returns what the page needs to save or react to them. The caller keeps the
/// hint's text (it knows which kinds list or audio types are missing); `values()` is exactly what both UIs save.
function ruleControls(rule, box) {
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const choice = (label, checked, kind) => {
    const labelNode = make("label", "choice");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    if (kind) input.dataset.kind = kind;
    labelNode.append(input, label);
    box.append(labelNode);
    return input;
  };
  const bits = pictureBits(rule);
  const pictures = choice("Pictures", bits.looks);
  // Its words, for keyword search: screenshots alone (the default), every picture, or none. With Pictures off these
  // are the only thing kept of a picture, so it is found by its words and never among the pictures.
  const textLabel = make("label", "option");
  textLabel.append(make("span", "text", "Text on pictures"));
  const text = document.createElement("select");
  text.className = "field";
  text.title = "Reading words is the slow part of indexing a picture";
  for (const [value, label] of [["off", "Don't read it"], ["screenshots", "Screenshots only"],
                                ["all", "Every picture"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = bits.text === value;
    text.append(option);
  }
  textLabel.append(text);
  box.append(textLabel);
  const wordsOnly = make("p", "note");
  const refreshNote = () => {
    const kept = !pictures.checked && text.value !== "off";
    wordsOnly.hidden = !kept;
    if (kept) {
      wordsOnly.textContent = text.value === "screenshots"
        ? "Only screenshots are kept, for their words: not shown among Images or Screenshots."
        : "Pictures are kept for their words only: not shown among Images or Screenshots.";
    }
  };
  refreshNote();
  box.append(wordsOnly);
  pictures.addEventListener("change", refreshNote);
  text.addEventListener("change", refreshNote);
  // No kinds in the rule: everything. Documents covers PDFs and text documents (one section in the window).
  const documents = choice("Documents", (rule.kinds || []).length === 0
    || rule.kinds.includes("pdf") || rule.kinds.includes("doc"), "documents");
  const videos = choice("Videos", (rule.kinds || []).length === 0 || rule.kinds.includes("video"), "video");
  const audioChoice = (label, checked) => choice(label, checked);
  const inKinds = (rule.kinds || []).length === 0 || (rule.kinds || []).includes("audio");
  // A rule saved before the bits existed read recordings exactly when its kinds included them.
  const tags = audioChoice("Recordings by their tags", rule.audioTags ?? inKinds);
  const content = audioChoice("Recordings by their sound", rule.audioContent ?? inKinds);
  const scansChoice = make("label", "choice");
  const scans = document.createElement("input");
  scans.type = "checkbox";
  scans.checked = rule.ocrScans === true;
  scans.title = "A scanned page costs a render and an OCR each";
  scansChoice.append(scans, "Read text on scanned PDF pages");
  box.append(scansChoice);
  const hint = make("p", "note");
  hint.hidden = true;
  box.append(hint);
  // Types this folder leaves out on top of the ones skipped everywhere: "html, log".
  const skipLabel = make("label", "option");
  skipLabel.append(make("span", "text", "Skip types"));
  const skip = document.createElement("input");
  skip.type = "text";
  skip.className = "field";
  skip.placeholder = "html, log";
  skip.value = (rule.skipTypes || []).join(", ");
  skipLabel.append(skip);
  box.append(skipLabel);
  // Last, so a folder's subfolder list sits right under it: on, the subfolders are read; off, nothing below it is.
  const shallow = make("label", "choice");
  const depth = document.createElement("input");
  depth.type = "checkbox";
  depth.checked = !rule.shallow;
  shallow.append(depth, "Scan its subfolders");
  box.append(shallow);

  const values = () => {
    const all = [];
    // Documents is one box for the two kinds the window shows together.
    if (documents.checked) all.push("pdf", "doc");
    if (videos.checked) all.push("video");
    // Either picture choice keeps the pictures in the rule (each read as asked); neither leaves them out.
    if (pictures.checked || text.value !== "off") all.push("image", "screenshot");
    if (tags.checked || content.checked) all.push("audio");
    return { kinds: all, audioTags: tags.checked, audioContent: content.checked, shallow: !depth.checked,
             skipTypes: skip.value.split(",").map((type) => type.trim()).filter(Boolean),
             looksPictures: pictures.checked, ocrPictures: text.value, ocrScans: scans.checked };
  };
  return { values, hint, pictures, text, documents, videos, tags, content, skip, depth, scans };
}
