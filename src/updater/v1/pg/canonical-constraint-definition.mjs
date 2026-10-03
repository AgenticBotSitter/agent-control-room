// Canonical form of a constraint definition, shared by the release's schema
// digest and the updater's own copy of that digest.
//
// WHY THIS EXISTS. `pg_dump`/`pg_restore` re-parses every CHECK constraint from
// the text it writes, and PostgreSQL's grammar builds an n-ary node for an AND
// chain while `BETWEEN` desugars into a NESTED one. So the constraint created by
// a migration that spells `char_length(a) BETWEEN 1 AND 180 AND a ~ '...'` holds
// the tree `(A AND B) AND C`, the dump prints that tree verbatim, and re-parsing
// the printed text yields the tree `A AND B AND C`. The restored constraint
// accepts and refuses exactly the same values -- it is the same schema -- but
// `pg_get_constraintdef` renders the two trees with different parentheses, so a
// hash over the rendered text moved on every dump/restore. A database restored
// from the nightly backup then failed the schema preflight and the app would not
// start on it, which is the opposite of what a restore is for.
//
// `deploy/postgres/evidence.mjs` hit this first and worked around it by DELETING
// every parenthesis from the expression. That cannot be reused here: it also
// makes `(A AND B) OR C` and `A AND (B OR C)` hash the same, so the digest would
// stop detecting a migration that regroups a guard's logic. This module removes
// only the parentheses that carry no meaning -- a group whose operator chain is
// the SAME operator as the chain it sits in -- and keeps every other grouping.
//
// WHY IT IS JAVASCRIPT AND NOT SQL. The release digests with the query in
// `src/web/v1/private-database-preflight.ts` and the updater digests with a
// byte-identical copy of it in `src/updater/v1/pg/release-schema-digest.sql`,
// proven equal by `tests/install-database-phase-real-postgres.test.mjs`. A SQL
// canonicaliser could not balance parentheses, so putting one in the query would
// mean editing both copies by hand forever, and a divergence between them would
// be a silent disagreement between the release and the updater on the same
// schema. Applying one small pure function to the rows the query returns keeps the
// duplicated SQL byte-identical and puts the logic where it can be reviewed,
// diffed and tested once.
//
// THE TRANSFORMATION IS ASSOCIATIVITY, AND ONLY THAT. `(A AND B) AND C` becomes
// `A AND B AND C`; `A AND (B OR C)` is left alone; `(A OR B) OR C` becomes
// `A OR B OR C`. Each rewrite is an identity for the operator it applies to, so
// the canonical form describes the same constraints as the original, and a
// genuinely different guard still produces a different digest.

/** One depth-0 boolean keyword occurrence. */
const keywordPattern = /^[A-Za-z_][A-Za-z0-9_$]*$/u;

/** `CHECK (` — the keyword and the parenthesis that opens the expression. */
const checkPrefix = "CHECK (";

/**
 * Words that look like operators but are not, and must never be read as the
 * chain's joining operator: `AND` and `OR` are the only two the re-association
 * below acts on. Everything else — `IS`, `NOT`, `LIKE`, `IN`, `BETWEEN`, ...
 * — is an ordinary word here.
 *
 * `BETWEEN 1 AND 180` contains a depth-0 `AND`, which is why a naive scan would
 * split it. That is harmless rather than dangerous: splitting and rejoining a
 * chain with the SAME separator reproduces the original text exactly, and only
 * splicing a nested group running the SAME operator changes grouping — and that
 * is an identity for AND and for OR. So no word is a barrier, and a chain whose
 * first operator is an `AND` belonging to `BETWEEN` is still handled correctly.
 */
const OPERATOR_WORDS = new Set(["AND", "OR"]);

/** `CHECK (<expr>)` and `CHECK (<expr>) NO INHERIT`; nothing else is canonicalised. */
const checkDefinition = /^CHECK \(/u;
const noInheritSuffix = /\)\s+(NO INHERIT)$/u;

/**
 * Canonicalise one `pg_get_constraintdef` string.
 *
 * A definition that is not a CHECK is returned byte-identical: foreign keys, unique
 * and primary keys carry their column lists and referenced names, and the
 * parenthesis pass below is not the right tool for them.
 */
export function canonicalConstraintDefinitionV1(definition) {
  if (typeof definition !== "string" || !checkDefinition.test(definition)) return definition;
  const suffix = noInheritSuffix.exec(definition);
  const end = definition.length - (suffix ? `) ${suffix[1]}`.length : 1);
  // The `(` that opens the expression, and ITS OWN matching `)`. The open index
  // is the index OF the parenthesis, not the one after it: starting one character
  // late leaves the depth at 0 immediately, so a body that is itself one balanced
  // group reads as "empty" and is never canonicalised -- which is exactly the
  // shape every restored CHECK has.
  const close = matchingCloser(definition, checkPrefix.length - 1);
  if (close === -1 || close !== end) return definition;
  const body = definition.slice(checkPrefix.length, close);
  if (body.length === 0) return definition;
  return `${checkPrefix}${canonicalBooleanChainV1(body)})${suffix ? ` ${suffix[1]}` : ""}`;
}

/** Index of the `)` closing the `(` at `open`, or -1 when the text is unbalanced. */
function matchingCloser(text, open) {
  let depth = 0;
  let quoted = null;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "\\" && quoted === "'") index += 1;
      else if (character === quoted) {
        if (text[index + 1] === quoted) index += 1;
        else quoted = null;
      }
      continue;
    }
    if (character === "'" || character === '"') { quoted = character; continue; }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Canonicalise the constraint rows of a schema manifest.
 *
 * Returns the SAME array when nothing changed, so the caller's rows keep their
 * identity and a manifest with no redundant parentheses is hashed exactly as the
 * query returned it.
 */
export function canonicalConstraintManifestRowsV1(rows) {
  if (!Array.isArray(rows)) return rows;
  let changed = false;
  const next = rows.map(row => {
    if (!row || typeof row !== "object" || row.kind !== "constraint" || typeof row.definition !== "string") return row;
    let parsed;
    try { parsed = JSON.parse(row.definition); } catch { return row; }
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return row;
    const canonical = canonicalConstraintDefinitionV1(parsed[0]);
    // Re-serialised unconditionally, so a row's text is the same compact JSON
    // whether or not its parentheses moved, and identical on both sides of a
    // comparison. PostgreSQL prints json with a space after each comma and this
    // does not; that difference is the point -- the shape is ours, not the
    // server's, and the constant below is re-derived to match.
    const definition = JSON.stringify([canonical, ...parsed.slice(1)]);
    if (definition === row.definition) return row;
    changed = true;
    return { ...row, definition };
  });
  return changed ? next : rows;
}

/** The digest input after canonicalisation. */
export function canonicalManifestV1(rows) {
  return canonicalConstraintManifestRowsV1(rows);
}

/**
 * Canonicalise one boolean expression group, wrappers first.
 *
 * Every group that spans the WHOLE expression is peeled, because that is what
 * hides the chain underneath: `((A) AND (B)) AND (C)` starts with a parenthesis
 * but its leading `(` closes before the end, so it is a sequence, not a group,
 * and the `AND` between its operands is only visible at depth 0 once the peel
 * loop stops. What is left is a chain, and it is re-rendered left-to-right by
 * splicing any operand that is a whole group running the SAME operator.
 *
 * Anything mixed (`A AND B OR C`), anything containing a barrier word (`BETWEEN`,
 * `IS`, `NOT`, ...) and anything whose operands are single values keeps its own
 * text: those groupings carry meaning, and this module must not reason about
 * them. So `((A AND B) OR C)` and `A AND (B OR C)` stay different, while
 * `(((A) AND (B)) AND (C))` and `(((A) AND (B) AND (C)))` become the same.
 */
function canonicalBooleanChainV1(expression) {
  // A group spanning the whole expression carries nothing: whatever it wraps is
  // the whole constraint. Peel it, canonicalise what was inside, and let the
  // CALLER re-add exactly one level of parentheses.
  const whole = wholeGroupInner(expression);
  if (whole !== null) return canonicalBooleanChainV1(whole);
  const scan = scanDepthZero(expression);
  if (scan.operators.length === 0) return expression;
  const operator = scan.operators[0].word;
  // A chain that mixes AND with OR has a fixed grouping that IS the constraint, so
  // the operands keep their separators and only each operand is canonicalised
  // inside its own parentheses.
  if (scan.operators.some(found => found.word !== operator))
    return canonicalOperandGroupsV1(expression, null);
  const operands = splitOnOperator(expression, operator);
  if (operands.length < 2) return canonicalOperandGroupsV1(expression, null);
  return flattenOperands(operands, operator).join(` ${operator} `);
}

/**
 * Canonicalise inside each operand WITHOUT changing which operator joins them.
 *
 * Used for a chain this function must not re-associate: rewriting
 * `A OR ((B AND C) AND D)` as `A OR (B AND C AND D)` moves nothing, while
 * rewriting it as `A OR B OR C OR D` would change the constraint. Each operand
 * that is a whole group is canonicalised inside and re-wrapped, so the
 * parentheses that carry the meaning survive.
 */
function canonicalOperandGroupsV1(expression, operator) {
  if (operator === null) {
    // No single operator to split on: split at the FIRST depth-0 operator of
    // either kind and recurse on the rest, so a mixed chain is still walked
    // operand by operand rather than abandoned.
    const found = scanDepthZero(expression).operators;
    if (found.length === 0) return expression;
    const first = found[0];
    const operands = splitOnOperatorPrefix(expression, first);
    if (operands.length < 2) return expression;
    return operands.map(canonicalOperandV1).join(` ${first.word} `);
  }
  const operands = splitOnOperator(expression, operator);
  if (operands.length < 2) return expression;
  return operands.map(canonicalOperandV1).join(` ${operator} `);
}

/** Canonicalise one operand, re-wrapping it if it is a whole group. */
function canonicalOperandV1(operand) {
  const text = operand.trim();
  const inner = wholeGroupInner(text);
  if (inner === null) return text;
  return `(${canonicalBooleanChainV1(inner)})`;
}

/**
 * Expand operands, splicing any that is a WHOLE parenthesised group running the
 * same operator. Every other operand keeps its original text.
 */
function flattenOperands(operands, operator) {
  const flat = [];
  for (const operand of operands) {
    const text = operand.trim();
    // Peel every redundant wrapper off this operand, then ask what operator runs
    // at the top of what is left. Peeling is what makes `A AND (B AND C)` splice:
    // the `AND` inside the operand is at depth 1 until the group is removed, and a
    // group around an operand of the same operator is exactly the redundancy this
    // function exists to remove.
    const stripped = peelGroups(text);
    const scan = scanDepthZero(stripped);
    if (scan.operators.length > 0 && scan.operators.every(found => found.word === operator)) {
      const nested = splitOnOperator(stripped, operator);
      if (nested.length >= 2) { flat.push(...flattenOperands(nested, operator)); continue; }
    }
    // Not spliceable — a different operator, or no operator at all. It still gets
    // canonicalised INSIDE its own parentheses, because that re-association is
    // confined by them. This is the case a restored `A OR ((B AND C) AND D)`
    // lands in: the OR chain is left alone and the AND group inside it is fixed.
    flat.push(canonicalOperandV1(text));
  }
  return flat;
}

/** The text inside every wrapper that spans the whole operand, outermost first. */
function peelGroups(text) {
  let current = text;
  for (let pass = 0; pass < 32; pass += 1) {
    const inner = wholeGroupInner(current);
    if (inner === null) break;
    current = inner;
  }
  return current;
}

/** The inside of `text` when `text` is exactly one parenthesised group, else null. */
function wholeGroupInner(text) {
  if (text.length < 2 || text[0] !== "(" || text.at(-1) !== ")") return null;
  let depth = 0;
  let quoted = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "\\" && quoted === "'") index += 1;
      else if (character === quoted) {
        if (text[index + 1] === quoted) index += 1;
        else quoted = null;
      }
      continue;
    }
    if (character === "'" || character === '"') { quoted = character; continue; }
    if (character === "$" && text[index + 1] === "$") {
      const close = text.indexOf("$$", index + 2);
      if (close === -1) return null;
      index = close + 1;
      continue;
    }
    if (character === "-" && text[index + 1] === "-") { const eol = text.indexOf("\n", index); index = eol === -1 ? text.length : eol; continue; }
    if (character === "/" && text[index + 1] === "*") { const close = text.indexOf("*/", index); if (close === -1) return null; index = close + 1; continue; }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      // Returning to depth 0 anywhere but the final character means the leading
      // `(` closed there and the text is a SEQUENCE that merely happens to start
      // and end with a parenthesis -- `(X AND (Y)) AND (Z)` is the case that
      // matters: read as one group it would be unwrapped into `X AND (Y)) AND
      // (Z`, which is not an expression at all. Only the final `)` may close the
      // opening one.
      if (depth === 0) return index === text.length - 1 ? text.slice(1, -1) : null;
    }
  }
  return null;
}

/** Every depth-0 boolean keyword, plus the count of barrier words. */
function scanDepthZero(text) {
  const operators = [];
  let depth = 0;
  let quoted = null;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (quoted) {
      if (character === "\\" && quoted === "'") index += 1;
      else if (character === quoted) {
        if (text[index + 1] === quoted) index += 1;
        else quoted = null;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') { quoted = character; index += 1; continue; }
    if (character === "$" && text[index + 1] === "$") {
      const close = text.indexOf("$$", index + 2);
      if (close === -1) { index = text.length; break; }
      index = close + 2;
      continue;
    }
    if (character === "-" && text[index + 1] === "-") { const eol = text.indexOf("\n", index); index = eol === -1 ? text.length : eol; continue; }
    if (character === "/" && text[index + 1] === "*") { const close = text.indexOf("*/", index); if (close === -1) { index = text.length; break; } index = close + 2; continue; }
    if (character === "(") { depth += 1; index += 1; continue; }
    if (character === ")") { depth -= 1; index += 1; continue; }
    if (keywordPattern.test(character)) {
      let end = index;
      while (end < text.length && /[A-Za-z0-9_$]/u.test(text[end])) end += 1;
      const word = text.slice(index, end).toUpperCase();
      if (depth === 0 && OPERATOR_WORDS.has(word)) operators.push({ word, start: index, end });
      index = end;
      continue;
    }
    index += 1;
  }
  return { operators };
}

/** Split at the recorded depth-0 occurrences of `operator`, in order. */
function splitOnOperator(text, operator) {
  const found = scanDepthZero(text).operators.filter(entry => entry.word === operator);
  if (found.length === 0) return [text];
  const operands = [];
  let start = 0;
  for (const entry of found) {
    operands.push(text.slice(start, entry.start));
    start = entry.end;
  }
  operands.push(text.slice(start));
  return operands;
}

/**
 * Split at ONE recorded occurrence — the one `entry` names — so a chain that
 * mixes AND with OR is walked operand by operand in its original order without
 * its operators being assumed homogeneous.
 */
function splitOnOperatorPrefix(text, entry) {
  return [text.slice(0, entry.start), text.slice(entry.end)];
}