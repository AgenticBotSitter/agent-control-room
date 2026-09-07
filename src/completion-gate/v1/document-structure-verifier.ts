import { documentStructureRulesSchema, type DocumentStructureRules, type DocumentStructureVerdict } from "./document-structure-contract";

const MAX_EVALUATED_UTF8_BYTES = 65_536;
const MAX_INPUT_CODE_UNITS = 262_144;

function validateText(text: unknown): asserts text is string {
  if (typeof text !== "string") throw new TypeError("document_text_invalid");
  if (text.length > MAX_INPUT_CODE_UNITS) throw new RangeError("document_text_refused");
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("document_text_invalid_utf16");
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError("document_text_invalid_utf16");
  }
}

function marker(line: string): { character: "`" | "~"; length: number; rest: string } | undefined {
  let offset = 0;
  while (offset < 3 && line.charCodeAt(offset) === 32) offset++;
  const character = line[offset];
  if (character !== "`" && character !== "~") return undefined;
  let end = offset;
  while (line[end] === character) end++;
  return end - offset >= 3 ? { character, length: end - offset, rest: line.slice(end) } : undefined;
}

function structure(text: string) {
  const found = new Set<string>();
  let fence: { character: "`" | "~"; length: number } | undefined;
  let hiddenMarkup: "comment" | string | undefined, unsupportedMarkup = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const candidate = marker(line);
    if (fence) {
      if (candidate?.character === fence.character && candidate.length >= fence.length && candidate.rest.trim() === "") fence = undefined;
      continue;
    }
    if (candidate) { fence = { character: candidate.character, length: candidate.length }; continue; }
    if (hiddenMarkup) {
      if (hiddenMarkup === "comment" ? line.includes("-->") : line.toLowerCase().includes(`</${hiddenMarkup}`)) hiddenMarkup = undefined;
      continue;
    }
    const angleOpener = /<\/?[A-Za-z!?]/.exec(line);
    if (angleOpener) {
      unsupportedMarkup = true;
      const suffix = line.slice(angleOpener.index);
      if (suffix.startsWith("<!--") && !suffix.includes("-->")) hiddenMarkup = "comment";
      else if (!suffix.startsWith("</")) {
        const tag = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(suffix)?.[1]?.toLowerCase();
        if (tag && !suffix.toLowerCase().includes(`</${tag}`) && !suffix.trimEnd().endsWith("/>")) hiddenMarkup = tag;
      }
      continue;
    }
    const match = /^ {0,3}(?:#{1,6}) +(.+)$/.exec(line);
    if (match) {
      const normalized = match[1]!.trim().replace(/ +#+$/, "").trim();
      if (normalized) found.add(normalized);
    }
  }
  return { found, unsupportedMarkup };
}

export function verifyDocumentStructure(text: string, input: DocumentStructureRules): DocumentStructureVerdict {
  const rules = documentStructureRulesSchema.parse(input);
  validateText(text);
  const utf8Bytes = new TextEncoder().encode(text).byteLength;
  if (utf8Bytes > MAX_EVALUATED_UTF8_BYTES) return { outcome: "failed", reasonCodes: ["too_long"] };

  const scanned = structure(text);
  const tooShort = utf8Bytes < rules.minUtf8Bytes;
  const tooLong = utf8Bytes > rules.maxUtf8Bytes;
  const missingHeading = rules.requiredHeadings.some(required => !scanned.found.has(required));
  const forbiddenTerm = rules.forbiddenTerms.some(term => text.includes(term));
  const reasonCodes: DocumentStructureVerdict["reasonCodes"] = [];
  if (tooShort) reasonCodes.push("too_short");
  if (tooLong) reasonCodes.push("too_long");
  if (missingHeading) reasonCodes.push("missing_heading");
  if (forbiddenTerm) reasonCodes.push("forbidden_term");
  if (scanned.unsupportedMarkup) reasonCodes.push("unsupported_markup");
  return { outcome: reasonCodes.length ? "failed" : "passed", reasonCodes };
}
