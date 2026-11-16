// The fields of a folder's rule, shared by Settings and the setup's folders page: the kinds it holds, how its
// recordings are read, the types it skips, how deep it is read, and the text on its pictures and scans. Both pages
// used to build these on their own, and the setup's copy didn't know the OCR fields, so saving it wiped them.
"use strict";

const RULE_KINDS = [["image", "Pictures"], ["pdf", "PDFs"], ["doc", "Documents"], ["video", "Videos"]];

/// Appends a rule's fields to `box` and returns what the page needs to save or react to them. The caller keeps the
/// hint's text (it knows which kinds list or audio types are missing); `values()` is exactly what both UIs save.
function ruleControls(rule, box) {
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const kinds = RULE_KINDS.map(([kind, label]) => {
    const choice = make("label", "choice");
    const input = document.createElement("input");
    input.type = "checkbox";
    // No kinds in the rule: everything.
    input.checked = (rule.kinds || []).length === 0 || rule.kinds.includes(kind);
    input.dataset.kind = kind;
    choice.append(input, label);
    box.append(choice);
    return input;
  });
  const audioChoice = (label, checked) => {
    const choice = make("label", "choice");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    choice.append(input, label);
    box.append(choice);
    return input;
  };
  const inKinds = (rule.kinds || []).includes("audio");
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
  // Text on pictures, and on a PDF's scanned pages: reading words is the costly part of a picture.
  const textLabel = make("label", "option");
  textLabel.append(make("span", "text", "Text on pictures"));
  const pictures = document.createElement("select");
  pictures.className = "field";
  pictures.title = "Reading words is the slow part of indexing a picture";
  for (const [value, label] of [["off", "Don't read it"], ["screenshots", "Screenshots only"],
                                ["all", "Every picture"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = (rule.ocrPictures || "screenshots") === value;
    pictures.append(option);
  }
  textLabel.append(pictures);
  box.append(textLabel);
  const scansChoice = make("label", "choice");
  const scans = document.createElement("input");
  scans.type = "checkbox";
  scans.checked = rule.ocrScans === true;
  scans.title = "A scanned page costs a render and an OCR each";
  scansChoice.append(scans, "Read text on scanned PDF pages");
  box.append(scansChoice);
  // Last, so a folder's subfolder list sits right under it: on, the subfolders are read; off, nothing below it is.
  const shallow = make("label", "choice");
  const depth = document.createElement("input");
  depth.type = "checkbox";
  depth.checked = !rule.shallow;
  shallow.append(depth, "Scan its subfolders");
  box.append(shallow);

  const values = () => {
    const chosen = kinds.filter((input) => input.checked).map((input) => input.dataset.kind);
    // Pictures means pictures and screenshots; recordings join the kinds when either of their bits is on.
    let all = chosen.includes("image") ? [...chosen, "screenshot"] : chosen;
    if (tags.checked || content.checked) all = [...all, "audio"];
    return { kinds: all, audioTags: tags.checked, audioContent: content.checked, shallow: !depth.checked,
             skipTypes: skip.value.split(",").map((type) => type.trim()).filter(Boolean),
             ocrPictures: pictures.value, ocrScans: scans.checked };
  };
  return { values, hint, kinds, tags, content, skip, depth, pictures, scans };
}
