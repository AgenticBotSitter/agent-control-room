// A small XML well-formedness check.
//
// The generated launchd property list and Windows task definition are XML. Nothing else in
// this repository parses them, so without this a stray unescaped "&" in a path would ship a
// file that only fails on the operator's machine. The generator validates before writing,
// which turns that class of mistake into an immediate, local error.
//
// This checks structure only: balanced elements, one root, quoted attributes, and entity
// references. It does not validate a schema, and native validation (plutil, schtasks,
// systemd-analyze) still belongs to the target platform.

const NAME = /^[A-Za-z_][A-Za-z0-9._:-]*/;
const KNOWN_ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+)$/;

function hasBadEntity(text) {
  return (text.match(/&[^;\s<]*/g) ?? []).some(token => !KNOWN_ENTITY.test(token));
}

function tagEnd(text, from) {
  let quote = null;
  for (let index = from; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (character === "<") return -1;
    if (character === ">") return index;
  }
  return -1;
}

export function isWellFormedXml(source) {
  if (typeof source !== "string" || source.length === 0) return false;
  const stack = [];
  let roots = 0;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open === -1) {
      if (hasBadEntity(source.slice(index))) return false;
      break;
    }
    const text = source.slice(index, open);
    if (text.includes(">") || hasBadEntity(text)) return false;

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end === -1) return false;
      index = end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      if (end === -1) return false;
      index = end + 2;
      continue;
    }
    if (source.startsWith("<!", open)) {
      const end = source.indexOf(">", open + 2);
      if (end === -1) return false;
      index = end + 1;
      continue;
    }

    const end = tagEnd(source, open + 1);
    if (end === -1) return false;
    const raw = source.slice(open + 1, end).trim();
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      if (name === "" || stack.pop() !== name) return false;
    } else if (raw.endsWith("/")) {
      const body = raw.slice(0, -1);
      const name = body.split(/\s/u)[0];
      const matched = NAME.exec(name);
      if (!matched || matched[0] !== name) return false;
      if (hasBadEntity(body.slice(name.length))) return false;
      if (stack.length === 0) roots++;
    } else {
      const name = raw.split(/\s/u)[0];
      const matched = NAME.exec(name);
      if (!matched || matched[0] !== name) return false;
      if (hasBadEntity(raw.slice(name.length))) return false;
      if (stack.length === 0) roots++;
      stack.push(name);
    }
    index = end + 1;
  }
  return stack.length === 0 && roots === 1;
}
