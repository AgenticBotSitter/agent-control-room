// Check object member names before native JSON conversion. Per-object sets also
// detect escaped spellings of the same key; a reviver cannot see duplicates.
export function parseStrictJsonV1(text, { maxBytes = 1024 * 1024, maxDepth = 128, maxNodes = 200000 } = {}) {
  const invalid = code => { throw new SyntaxError(code); };
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) invalid("json_size_refused");
  let index = 0, nodes = 0;
  const whitespace = () => { while (index < text.length && " \t\r\n".includes(text[index])) index++; };
  const expect = character => { if (text[index++] !== character) invalid("json_invalid"); };
  function string() {
    const start = index; expect('"');
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') return JSON.parse(text.slice(start, index));
      if (character === "\\") index++; // Native parsing below validates escape syntax.
    }
    invalid("json_invalid");
  }
  const primitive = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  function value(depth) {
    if (depth > maxDepth) invalid("json_depth_refused");
    if (++nodes > maxNodes) invalid("json_nodes_refused");
    whitespace();
    const character = text[index];
    if (character === '"') { string(); return; }
    if (character === "{" || character === "[") {
      index++; whitespace();
      const object = character === "{", end = object ? "}" : "]", keys = new Set();
      if (text[index] === end) { index++; return; }
      for (;;) {
        whitespace();
        if (object) {
          const key = string();
          if (keys.has(key)) invalid("json_duplicate_key");
          keys.add(key); whitespace(); expect(":");
        }
        value(depth + 1); whitespace();
        if (text[index] === end) { index++; return; }
        expect(",");
      }
    }
    primitive.lastIndex = index;
    if (!primitive.exec(text)) invalid("json_invalid");
    index = primitive.lastIndex;
  }
  value(0); whitespace();
  if (index !== text.length) invalid("json_invalid");
  return JSON.parse(text);
}
