import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentStructureRules } from "../src/completion-gate/v1/document-structure-contract";
import { verifyDocumentStructure } from "../src/completion-gate/v1/document-structure-verifier";

const rules = (overrides: Partial<DocumentStructureRules> = {}): DocumentStructureRules => ({
  version: "document-structure/v1", minUtf8Bytes: 1, maxUtf8Bytes: 65_536,
  requiredHeadings: [], forbiddenTerms: [], ...overrides,
});

test("accepts a valid document with exact case-sensitive Markdown headings", () => {
  const input = rules({ requiredHeadings: ["Overview", "Checks"], forbiddenTerms: ["DRAFT"] });
  const text = "# Overview\nUseful content.\n##    Checks   \nComplete.";
  assert.deepEqual(verifyDocumentStructure(text, input), { outcome: "passed", reasonCodes: [] });
  assert.deepEqual(input, rules({ requiredHeadings: ["Overview", "Checks"], forbiddenTerms: ["DRAFT"] }), "rules are not mutated");
  assert.deepEqual(verifyDocumentStructure(text.replace("Checks", "checks"), input),
    { outcome: "failed", reasonCodes: ["missing_heading"] });
});

test("returns unique failure reasons in fixed order", () => {
  const input = rules({ minUtf8Bytes: 100, maxUtf8Bytes: 110, requiredHeadings: ["Required", "Also required"],
    forbiddenTerms: ["BAD", "WORSE"] });
  assert.deepEqual(verifyDocumentStructure("BAD BAD", input),
    { outcome: "failed", reasonCodes: ["too_short", "missing_heading", "forbidden_term"] });
  const long = "BAD ".repeat(40);
  assert.deepEqual(verifyDocumentStructure(long, input),
    { outcome: "failed", reasonCodes: ["too_long", "missing_heading", "forbidden_term"] });
});

test("ignores headings inside backtick and tilde fences while accepting CRLF headings outside", () => {
  const input = rules({ requiredHeadings: ["Backtick fake", "Tilde fake", "Real heading"] });
  const fenced = "```markdown\r\n# Backtick fake\r\n```\r\n~~~\r\n## Tilde fake\r\n~~~~\r\n### Real heading\r\n";
  assert.deepEqual(verifyDocumentStructure(fenced, input),
    { outcome: "failed", reasonCodes: ["missing_heading"] });
  const outside = fenced + "# Backtick fake\r\n## Tilde fake\r\n";
  assert.deepEqual(verifyDocumentStructure(outside, input), { outcome: "passed", reasonCodes: [] });
});

test("uses inclusive UTF-8 byte bounds and literal case-sensitive Unicode terms", () => {
  const exact = "é界"; // two plus three UTF-8 bytes
  assert.deepEqual(verifyDocumentStructure(exact, rules({ minUtf8Bytes: 5, maxUtf8Bytes: 5, forbiddenTerms: ["É"] })),
    { outcome: "passed", reasonCodes: [] });
  assert.deepEqual(verifyDocumentStructure(exact, rules({ minUtf8Bytes: 6, maxUtf8Bytes: 6, forbiddenTerms: ["界"] })),
    { outcome: "failed", reasonCodes: ["too_short", "forbidden_term"] });
});

test("rejects non-string and malformed UTF-16 text without replacement encoding", () => {
  assert.throws(() => verifyDocumentStructure(7 as unknown as string, rules()), /document_text_invalid/);
  for (const text of ["\ud800", "a\udfff", "\ud800x", "\ud800\ud800"])
    assert.throws(() => verifyDocumentStructure(text, rules()), /document_text_invalid_utf16/);
  assert.deepEqual(verifyDocumentStructure("😀", rules({ minUtf8Bytes: 4, maxUtf8Bytes: 4 })),
    { outcome: "passed", reasonCodes: [] });
});

test("rejects invalid rule configurations before evaluation", () => {
  for (const input of [
    { ...rules(), version: "other" }, { ...rules(), minUtf8Bytes: 2, maxUtf8Bytes: 1 },
    { ...rules(), requiredHeadings: ["Same", " Same "] }, { ...rules(), forbiddenTerms: ["bad\nterm"] },
    { ...rules(), unexpected: true },
  ]) assert.throws(() => verifyDocumentStructure("# Same", input as DocumentStructureRules));
});

test("honors the 65,536-byte evaluation boundary and refuses absurd code-unit input", () => {
  assert.deepEqual(verifyDocumentStructure("a".repeat(65_536), rules({ minUtf8Bytes: 65_536, maxUtf8Bytes: 65_536 })),
    { outcome: "passed", reasonCodes: [] });
  assert.deepEqual(verifyDocumentStructure("a".repeat(65_537), rules()),
    { outcome: "failed", reasonCodes: ["too_long"] });
  assert.deepEqual(verifyDocumentStructure("界".repeat(100_000), rules()),
    { outcome: "failed", reasonCodes: ["too_long"] });
  assert.throws(() => verifyDocumentStructure("a".repeat(262_145), rules()), /document_text_refused/);
});

test("recognizes only one-to-six hash headings and keeps forbidden terms active inside fences", () => {
  const input = rules({ requiredHeadings: ["Exact"], forbiddenTerms: ["BLOCKED"] });
  assert.deepEqual(verifyDocumentStructure("####### Exact\n```\n# Exact\nBLOCKED\n```", input),
    { outcome: "failed", reasonCodes: ["missing_heading", "forbidden_term"] });
  assert.deepEqual(verifyDocumentStructure("###### Exact\nordinary blocked", input),
    { outcome: "passed", reasonCodes: [] });
});
