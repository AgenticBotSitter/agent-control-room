// THE CONSTRAINT CANONICALISER, and the digest it feeds.
//
// WHY THIS EXISTS SEPARATELY FROM ANY POSTGRES TEST. The function is pure text
// in, text out, and its whole job is a judgement about which parentheses carry
// meaning -- a judgement that must be checked against REAL rendered constraint
// text or it is just an opinion. So: the shapes below are the real
// `pg_get_constraintdef` strings observed on a live PostgreSQL 17 install of this
// tree before and after pg_dump/pg_restore (tests/schema-restore-digest-real-postgres.test.mjs
// re-derives them from the cluster on every run), and this file checks the two
// properties that matter on its own, without a cluster:
//
//   1. STABILITY. The pair pg_dump produced must canonicalise to the same string.
//      This is the fix: before it, the pair hashed differently and a restored
//      database failed the startup preflight.
//   2. SENSITIVITY. A genuinely different guard must canonicalise differently.
//      This is the guard on the fix. Stripping every parenthesis -- the
//      workaround deploy/postgres/evidence.mjs uses -- passes (1) and fails (2).
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalConstraintDefinitionV1,
  canonicalConstraintManifestRowsV1,
} from "../src/updater/v1/pg/canonical-constraint-definition.mjs";

// The real renderings, copied verbatim from a live PostgreSQL 17 install of this
// tree: `source` is what pg_get_constraintdef returned after the migration, and
// `restored` is what it returned after pg_dump -> pg_restore re-parsed the printed
// text. Between them is the whole difference the canonicaliser has to absorb.
const PAIRS = [
  // db/migrations/0076_project_work_resource_admission.sql:38. BETWEEN makes the
  // parser build a NESTED tree, which is why this one differs at all.
  { name: "0076 base_revision",
    source: "CHECK ((((char_length(base_revision) >= 1) AND (char_length(base_revision) <= 180)) AND (base_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]*$'::text)))",
    restored: "CHECK (((char_length(base_revision) >= 1) AND (char_length(base_revision) <= 180) AND (base_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]*$'::text)))" },
  // A chain of plain comparisons written by a migration that grouped each one.
  { name: "0211 display_name",
    source: "CHECK ((((char_length(display_name) >= 1) AND (char_length(display_name) <= 120)) AND (display_name !~ '[[:cntrl:]]'::text)))",
    restored: "CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 120) AND (display_name !~ '[[:cntrl:]]'::text)))" },
  // The mixed OR/AND case: the OR chain is the constraint, and only the AND group
  // inside it may be re-associated.
  { name: "fleet_work_offers allowed_worker_ids",
    source: "CHECK ((allowed_worker_ids IS NULL) OR (((cardinality(allowed_worker_ids) >= 1) AND (cardinality(allowed_worker_ids) <= 20)) AND (array_ndims(allowed_worker_ids) = 1)))",
    restored: "CHECK ((allowed_worker_ids IS NULL) OR ((cardinality(allowed_worker_ids) >= 1) AND (cardinality(allowed_worker_ids) <= 20) AND (array_ndims(allowed_worker_ids) = 1)))" },
];

for (const pair of PAIRS) {
  test(`${pair.name}: the dump/restore pair canonicalises to one string`, () => {
    const source = canonicalConstraintDefinitionV1(pair.source);
    const restored = canonicalConstraintDefinitionV1(pair.restored);
    assert.equal(restored, source,
      `${pair.name}: a restored constraint must hash like the source it came from\n  source:   ${pair.source}\n  restored: ${pair.restored}`);
    // Idempotent: canonicalising a canonical form must not move it again, or the
    // two halves could disagree depending on how many times it ran.
    assert.equal(canonicalConstraintDefinitionV1(source), source, "canonicalisation must be a fixed point");
  });
}

/** Constraints that are NOT the same must NOT collide. Each pair is a real hazard. */
const DISTINCT = [
  // Regrouping a guard. This is the one a parenthesis-stripping canonicaliser
  // silently merges, turning a real guard change into an undetected one.
  { name: "OR regrouped to AND", one: "CHECK (((a > 0 AND b > 0) OR c > 0))", two: "CHECK (((a > 0) AND (b > 0 OR c > 0)))" },
  // An operand moved out of a group changes which values pass.
  { name: "one operand regrouped", one: "CHECK (((a > 0 AND b > 0) AND c > 0))", two: "CHECK (((a > 0) AND ((b > 0) AND c > 0)))" },
  // OR is not associative in the same textual shape: the parenthesised OR stays.
  { name: "OR chain regrouped", one: "CHECK (((a > 0) OR ((b > 0) OR (c > 0)))", two: "CHECK ((a > 0) OR (b > 0) OR (c > 0))" },
  { name: "boundary moved", one: "CHECK ((char_length(a) <= 180))", two: "CHECK ((char_length(a) <= 181))" },
  { name: "IS NOT added", one: "CHECK (((x IS NULL) OR ((a > 0) AND (b > 0))))", two: "CHECK (((x IS NOT NULL) OR ((a > 0) AND (b > 0))))" },
  { name: "different column", one: "CHECK ((a > 0))", two: "CHECK ((b > 0))" },
];

for (const shape of DISTINCT) {
  test(`${shape.name}: two different guards stay different`, () => {
    assert.notEqual(canonicalConstraintDefinitionV1(shape.one), canonicalConstraintDefinitionV1(shape.two),
      `${shape.one} and ${shape.two} are different constraints and must not hash the same`);
  });
}

// A chain's operands are re-associated ONLY when a spliced group runs the SAME
// operator. These are the cases that guard, and each one is a mixed-operator
// operand that a "splice anything" rule would flatten into a different constraint.
test("an operand running a different operator keeps its parentheses", () => {
  const cases = [
    // A parenthesised OR is an operand of an AND chain. Flattening it would read
    // as three ANDed terms, which is a different set of accepted values.
    { one: "CHECK (((a > 0) AND ((b > 0) OR (c > 0))))", two: "CHECK (((a > 0) AND (b > 0) OR (c > 0)))",
      group: /\(\(b > 0\) OR \(c > 0\)\)/u },
    // The mirror: a parenthesised AND inside an OR chain.
    { one: "CHECK (((a > 0) OR ((b > 0) AND (c > 0))))", two: "CHECK (((a > 0) OR (b > 0) AND (c > 0)))",
      group: /\(\(b > 0\) AND \(c > 0\)\)/u },
    // A three-operand OR inside an AND chain is kept whole.
    { one: "CHECK ((a > 0) AND ((b > 0) OR (c > 0) OR (d > 0)))", two: "CHECK ((a > 0) AND (b > 0) OR (c > 0) OR (d > 0))",
      group: /\(\(b > 0\) OR \(c > 0\) OR \(d > 0\)\)/u },
  ];
  for (const shape of cases) {
    // The claim is that the differently-operating group SURVIVES, and that the
    // flattened alternative does not collide with it. Comparing for the literal
    // sub-string would be brittle -- the outer wrapper paren is legitimately
    // collapsed -- so the claim is checked as: the group is still parenthesised in
    // the output, and the two constraints do not hash alike.
    const canonical = canonicalConstraintDefinitionV1(shape.one);
    assert.match(canonical, shape.group,
      `the differently-operating group must stay parenthesised: ${canonical}`);
    assert.notEqual(canonical, canonicalConstraintDefinitionV1(shape.two),
      `${shape.one} and ${shape.two} are different constraints`);
  }
});

test("a non-CHECK, non-string and non-array input passes through without throwing", () => {
  // These are the shapes a caller can hand it by mistake. A throw here would take
  // down a startup preflight on a malformed row, so each is returned unchanged and
  // the caller still hashes it.
  assert.equal(canonicalConstraintDefinitionV1(undefined), undefined);
  assert.equal(canonicalConstraintDefinitionV1(42), 42);
  assert.equal(canonicalConstraintManifestRowsV1(undefined), undefined);
});

test("a foreign key or unique definition is returned byte-identical", () => {
  const others = ["FOREIGN KEY (tenant_id) REFERENCES tenants(id)",
    "UNIQUE (tenant_id, id)", "PRIMARY KEY (filename)", "NOT NULL"];
  for (const definition of others) {
    assert.equal(canonicalConstraintDefinitionV1(definition), definition,
      `${definition} carries column lists and references; this canonicaliser is for CHECK text only`);
  }
});

test("NO INHERIT survives canonicalisation", () => {
  const one = "CHECK (a <> ''::text) NO INHERIT";
  assert.equal(canonicalConstraintDefinitionV1(one), one, "the NO INHERIT marker is part of the constraint");
  assert.equal(canonicalConstraintDefinitionV1("CHECK (((a <> ''::text)) AND (b > 0)) NO INHERIT"),
    canonicalConstraintDefinitionV1("CHECK (((a <> ''::text) AND (b > 0))) NO INHERIT"),
    "NO INHERIT must not stop the body from being canonicalised");
});

test("an unbalanced or unparseable definition is returned unchanged, never mangled", () => {
  for (const definition of ["CHECK (((a > 0)", "CHECK ()", "CHECK ((a > 0)))"]) {
    assert.equal(typeof canonicalConstraintDefinitionV1(definition), "string");
  }
  // Unbalanced input is not repaired: the caller still hashes it, so a definition
  // that appeared on only one side of a comparison still differs there.
  assert.equal(canonicalConstraintDefinitionV1("CHECK (((a > 0) AND (b > 0)"), "CHECK (((a > 0) AND (b > 0)");
});

test("manifest rows: only constraint rows are rewritten, and only when they change", () => {
  const rows = [
    { kind: "column", name: "public.t.a", definition: '["",1,"integer",false,null,null,null,false,false]' },
    { kind: "constraint", name: "public.t.c", definition: JSON.stringify([PAIRS[0].restored, true]) },
    { kind: "function", name: "public.f()", definition: "CREATE FUNCTION public.f() RETURNS int" },
  ];
  const next = canonicalConstraintManifestRowsV1(rows);
  assert.equal(next[0], rows[0], "a column row is returned as the same object");
  assert.equal(next[2], rows[2], "a function row is returned as the same object");
  assert.notEqual(next[1], rows[1], "the constraint row is rewritten");
  // The rewritten row carries the CANONICAL form of the pair -- which is the
  // flattened chain, neither of the two raw renderings -- and keeps
  // `convalidated` (the second element) untouched.
  assert.deepEqual(JSON.parse(next[1].definition),
    [canonicalConstraintDefinitionV1(PAIRS[0].restored), true],
    "the rewritten row carries the canonical definition and keeps its other fields");
  assert.notEqual(JSON.parse(next[1].definition)[0], PAIRS[0].restored,
    "the restored rendering is NOT itself canonical, or this rewrite did nothing");
  // Idempotent over the manifest, and the identity guarantee: a manifest whose
  // constraints need no change comes back as the SAME array, so a schema that is
  // already canonical is hashed exactly as the catalog returned it.
  assert.equal(canonicalConstraintManifestRowsV1(next), next);
  const untouched = [{ kind: "column", name: "public.t.a", definition: '["x"]' }];
  assert.equal(canonicalConstraintManifestRowsV1(untouched), untouched);
});

test("a row of another kind is never rewritten, even when its text looks like a CHECK", () => {
  // A function or trigger definition can contain the words "CHECK (" and "AND", and
  // a column default can be anything at all. The kind is the guard, not the text:
  // rewriting one would change the digest of a schema this canonicaliser knows
  // nothing about, for no reason.
  const rows = [
    { kind: "function", name: "public.f()", definition: "CHECK (a > 0) AND CHECK (b > 0)" },
    { kind: "column", name: "public.t.a", definition: JSON.stringify(["CHECK ((a > 0) AND (b > 0))"]) },
    { kind: "trigger", name: "public.t.g", definition: '["CHECK (((a > 0) AND (b > 0)))"]' },
  ];
  assert.deepEqual(canonicalConstraintManifestRowsV1(rows), rows,
    "only rows whose kind is exactly \"constraint\" are canonicalised");
});

test("a row that is not parseable JSON, or not an array, is left alone", () => {
  for (const definition of ["not json", '{"a":1}', '"CHECK (a > 0)"', '"7"']) {
    const rows = [{ kind: "constraint", name: "public.t.c", definition }];
    assert.equal(canonicalConstraintManifestRowsV1(rows)[0], rows[0],
      `${definition} is not a shape this canonicaliser understands and must be untouched`);
  }
});