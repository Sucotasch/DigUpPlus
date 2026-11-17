// The fields of a folder's rule, shared by Settings and the setup's folders page. Kinds and their OCR reading are two
// independent results, as a recording's tags and sound are: Images (the look) and OCR (the words) for pictures;
// Documents (the document) and OCR Documents (scanned PDF pages) for documents. Either bit keeps the kind in the rule;
// neither leaves it out. Both pages build these here, so they can't drift.
"use strict";

/// A rule's picture bits. A rule saved before them looked at the pictures its kinds included; OCR was off before it
/// existed (the screenshots-only value of the 0.1.16 betas means OCR on, now for every picture).
function pictureBits(rule) {
  const kinds = rule.kinds || [];
  const included = kinds.length === 0 || kinds.includes("image") || kinds.includes("screenshot");
  return {
    images: rule.looksPictures ?? included,
    ocr: rule.ocrPictures != null && rule.ocrPictures !== "off",
  };
}

/// A rule's document bits. A rule saved before them had documents exactly when its kinds included pdf/doc.
function documentBits(rule) {
  const kinds = rule.kinds || [];
  const included = kinds.length === 0 || kinds.includes("pdf") || kinds.includes("doc");
  return {
    documents: rule.looksDocuments ?? included,
    ocrDocuments: rule.ocrScans === true,
  };
}

/// Appends a rule's fields to `box` and returns what the page needs to save or react to them. The caller keeps the
/// hint's text (it knows which audio types are missing); `values()` is exactly what both UIs save.
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
  const images = choice("Images", bits.images);
  const ocr = choice("OCR", bits.ocr);
  const wordsOnly = make("p", "note", "Pictures are kept as OCR results only: not shown in Images.");
  const refreshNote = () => { wordsOnly.hidden = images.checked || !ocr.checked; };
  refreshNote();
  box.append(wordsOnly);
  images.addEventListener("change", refreshNote);
  ocr.addEventListener("change", refreshNote);
  const docs = documentBits(rule);
  const documents = choice("Documents", docs.documents);
  const ocrDocuments = choice("OCR Documents", docs.ocrDocuments);
  const scansOnly = make("p", "note",
    "Only the text on scanned PDF pages is kept: no document results (text documents are not read).");
  const refreshScans = () => { scansOnly.hidden = documents.checked || !ocrDocuments.checked; };
  refreshScans();
  box.append(scansOnly);
  documents.addEventListener("change", refreshScans);
  ocrDocuments.addEventListener("change", refreshScans);
  // A rule from the Images/OCR split stores kinds for what no bit owns (video) alone; an older rule's empty list meant
  // every kind, and its bits are absent.
  const oldRule = rule.looksPictures == null && rule.ocrPictures == null;
  const videosOn = oldRule ? (rule.kinds || []).length === 0 || rule.kinds.includes("video")
                           : rule.kinds.includes("video");
  const videos = choice("Videos", videosOn, "video");
  const audioChoice = (label, checked) => choice(label, checked);
  const inKinds = (rule.kinds || []).length === 0 || (rule.kinds || []).includes("audio");
  // A rule saved before the bits existed read recordings exactly when its kinds included them.
  const tags = audioChoice("Recordings by their tags", rule.audioTags ?? inKinds);
  const content = audioChoice("Recordings by their sound", rule.audioContent ?? inKinds);
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
    // The bits decide image/screenshot/pdf/doc/audio; the kind list carries only what no bit owns (video). The shell
    // derives the rest from the bits in one place (clean_rule), so the two can't disagree — the reason three copies of
    // this mapping drifted before. An empty list is "every kind", which is how the shell reads it too.
    const any = images.checked || ocr.checked || documents.checked || ocrDocuments.checked || videos.checked
      || tags.checked || content.checked;
    return { kinds: videos.checked ? ["video"] : [], empty: !any,
             audioTags: tags.checked, audioContent: content.checked, shallow: !depth.checked,
             skipTypes: skip.value.split(",").map((type) => type.trim()).filter(Boolean),
             looksPictures: images.checked, ocrPictures: ocr.checked ? "all" : "off",
             looksDocuments: documents.checked, ocrScans: ocrDocuments.checked };
  };
  return { values, hint, images, ocr, documents, ocrDocuments, videos, tags, content, skip, depth };
}
