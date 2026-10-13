import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = path => readFileSync(resolve(ROOT,path),"utf8");
// Runner inventory is bound to the real Mac-local compositions; the SQL being
// checked cannot supply its own expected columns or authority.
const RUNNERS = {
  owner_web_push_subscriptions: { method: "subscribe", columns: ["p256dh", "auth", "expires_at", "updated_at"] },
  owner_web_push_deliveries: { method: "reserve", columns: ["state", "status_code", "completed_at"] },
};
// The scan reads the TypeScript source with the TypeScript parser, so a `--`, `/*`
// or `i--` in code or in a string can never be mistaken for a SQL comment. Only
// string and template text is SQL, and that text is tokenised by PostgreSQL's
// lexical rules (comments, nested comments, '', E'', "", $tag$) before any
// statement is classified. Anything it cannot read refuses by name; nothing is
// skipped and nothing is stripped.
const REFUSAL = "unparsed web-push upsert";
const PLACEHOLDER = "￼";
const MAX_SQL_DEPTH = 16;
// Text with none of these words has no write to hide, so it is not tokenised: "image/*" is a MIME type, not SQL.
const mentionsWrite = text => /\b(?:INSERT|MERGE|CONFLICT|UPDATE)\b/i.test(text);
const refuse = reason => { throw new Error(`${REFUSAL}: ${reason}`); };
const preview = text => JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}...` : text);
// Quoted identifiers keep their exact bytes (case and spaces); unquoted ones fold to lower case.
const identifier = token => token.t === "qid" ? token.v : token.v.toLowerCase();

function sqlTexts(source) {
  const diagnostics = ts.transpileModule(source, { fileName: "postgres-store.ts", reportDiagnostics: true }).diagnostics ?? [];
  if (diagnostics.length > 0) refuse(`the TypeScript source does not parse (${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ")})`);
  const file = ts.createSourceFile("postgres-store.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const texts = [];
  const unwrap = node => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const visit = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      for (const side of [unwrap(node.left), unwrap(node.right)]) {
        if ((ts.isStringLiteral(side) || ts.isNoSubstitutionTemplateLiteral(side) || ts.isTemplateExpression(side))
          && mentionsWrite(ts.isTemplateExpression(side) ? side.getText(file) : side.text)) refuse("SQL built by string concatenation cannot be classified");
      }
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && mentionsWrite(node.text)) texts.push(node.text);
    if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map(span => PLACEHOLDER + span.literal.text).join("");
      if (mentionsWrite(text)) texts.push(text);
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return texts;
}

const isIdentifierPart = character => /[A-Za-z0-9_$]/.test(character) || (character > "\u007f" && character !== PLACEHOLDER);
function tokenize(sql) {
  const tokens = [];
  const length = sql.length;
  const readString = (from, escapes) => {
    for (let at = from + 1; at < length; at += 1) {
      if (escapes && sql[at] === "\\") at += 1;
      else if (sql[at] === "'") {
        if (sql[at + 1] === "'") at += 1;
        else return at;
      }
    }
    return refuse(`unterminated string literal near ${preview(sql.slice(from))}`);
  };
  let i = 0;
  while (i < length) {
    const c = sql[i];
    if (/[ \t\n\r\f\v]/.test(c)) i += 1;
    else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? length : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      let depth = 1, at = i + 2;
      while (depth > 0 && at < length) {
        if (sql[at] === "/" && sql[at + 1] === "*") { depth += 1; at += 2; }
        else if (sql[at] === "*" && sql[at + 1] === "/") { depth -= 1; at += 2; }
        else at += 1;
      }
      if (depth > 0) refuse(`unterminated block comment near ${preview(sql.slice(i))}`);
      i = at;
    } else if (c === PLACEHOLDER) { tokens.push({ t: "ph", v: c }); i += 1; }
    else if (c === "'") {
      const end = readString(i, false);
      tokens.push({ t: "str", v: sql.slice(i + 1, end), body: sql.slice(i + 1, end).replaceAll("''", "'") });
      i = end + 1;
    } else if (c === '"') {
      let value = "", at = i + 1;
      for (; at < length; at += 1) {
        if (sql[at] === '"') {
          if (sql[at + 1] === '"') { value += '"'; at += 1; } else break;
        } else value += sql[at];
      }
      if (at >= length) refuse(`unterminated quoted identifier near ${preview(sql.slice(i))}`);
      tokens.push({ t: "qid", v: value });
      i = at + 1;
    } else if (c === "$") {
      const tag = /^\$(?:[A-Za-z_\u0080-￻][A-Za-z0-9_\u0080-￻]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag !== undefined) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) refuse(`unterminated dollar quote ${tag} near ${preview(sql.slice(i))}`);
        tokens.push({ t: "dollar", v: sql.slice(i + tag.length, end), body: sql.slice(i + tag.length, end) });
        i = end + tag.length;
      } else {
        const parameter = /^\$[0-9]+/.exec(sql.slice(i))?.[0];
        tokens.push({ t: "punct", v: parameter ?? c });
        i += (parameter ?? c).length;
      }
    } else if (/[A-Za-z_\u0080-￻]/.test(c)) {
      let at = i;
      while (at < length && isIdentifierPart(sql[at])) at += 1;
      const word = sql.slice(i, at);
      if (/^e$/i.test(word) && sql[at] === "'") {
        const end = readString(at, true);
        tokens.push({ t: "str", v: sql.slice(at + 1, end), body: sql.slice(at + 1, end) });
        i = end + 1;
      } else if (/^[bxn]$/i.test(word) && sql[at] === "'") i = at;
      else if (/^u$/i.test(word) && sql[at] === "&" && sql[at + 1] === "'") i = at + 1;
      else { tokens.push({ t: "word", v: word }); i = at; }
    } else if (/[0-9]/.test(c)) {
      const number = /^[0-9][0-9A-Za-z_.]*/.exec(sql.slice(i))[0];
      tokens.push({ t: "num", v: number });
      i += number.length;
    } else { tokens.push({ t: "punct", v: c }); i += 1; }
  }
  return tokens;
}

function analyze(sql, depth = 0) {
  if (depth > MAX_SQL_DEPTH) refuse(`SQL strings nest deeper than ${MAX_SQL_DEPTH} levels`);
  const tokens = tokenize(sql);
  const result = { writes: [], doUpdate: 0, onConflict: 0, onConflictRead: 0 };
  const is = (token, name) => token?.t === "word" && token.v.toUpperCase() === name;
  const pair = (index, first, second) => is(tokens[index], first) && is(tokens[index + 1], second);
  for (const token of tokens) {
    if ((token.t !== "str" && token.t !== "dollar") || !mentionsWrite(token.body)) continue;
    const inner = analyze(token.body, depth + 1);
    result.writes.push(...inner.writes);
    for (const key of ["doUpdate", "onConflict", "onConflictRead"]) result[key] += inner[key];
  }
  const inserts = [];
  tokens.forEach((token, index) => {
    if (is(token, "MERGE")) refuse("MERGE statements cannot be classified");
    if (pair(index, "DO", "UPDATE")) result.doUpdate += 1;
    if (pair(index, "ON", "CONFLICT")) result.onConflict += 1;
    if (is(token, "INSERT")) inserts.push(index);
  });
  for (const [order, start] of inserts.entries()) {
    const near = preview(tokens.slice(start, start + 6).map(token => token.v).join(" "));
    if (!is(tokens[start + 1], "INTO")) refuse(`INSERT is not followed by INTO near ${near}`);
    let end = order + 1 < inserts.length ? inserts[order + 1] : tokens.length;
    const semicolon = tokens.findIndex((token, index) => index > start && end > index && token.t === "punct" && token.v === ";");
    if (semicolon !== -1) end = semicolon;
    const parts = [];
    let at = start + 2;
    for (;;) {
      const token = tokens[at];
      if (token?.t !== "word" && token?.t !== "qid") refuse(`INSERT INTO target cannot be read near ${near}`);
      parts.push(identifier(token));
      at += 1;
      if (tokens[at]?.t === "punct" && tokens[at].v === "." && parts.length < 3) at += 1;
      else break;
    }
    const table = parts.length === 2 && parts[0] === "public" ? parts[1] : parts.join(".");
    let conflicts = 0, update;
    for (let index = at; index < end; index += 1) {
      if (pair(index, "ON", "CONFLICT")) conflicts += 1;
      if (update === undefined && conflicts > 0 && pair(index, "DO", "UPDATE")) update = index;
    }
    result.onConflictRead += conflicts;
    if (update === undefined) continue;
    if (!is(tokens[update + 2], "SET")) refuse(`DO UPDATE is not followed by SET near ${near}`);
    const columns = [];
    let depthOfParens = 0, expectColumn = true;
    for (let index = update + 3; index < end; index += 1) {
      const token = tokens[index];
      if (token.t === "punct" && token.v === "(") depthOfParens += 1;
      if (token.t === "punct" && token.v === ")") {
        if (depthOfParens === 0 && !expectColumn) break;
        depthOfParens -= 1;
      }
      if (expectColumn) {
        const equals = tokens[index + 1];
        if ((token.t !== "word" && token.t !== "qid") || equals?.t !== "punct" || equals.v !== "=") refuse(`DO UPDATE SET column list cannot be read near ${near}`);
        columns.push(identifier(token));
        expectColumn = false;
        index += 1;
      } else if (depthOfParens === 0 && token.t === "punct" && token.v === ",") expectColumn = true;
      else if (depthOfParens === 0 && (is(token, "WHERE") || is(token, "RETURNING"))) break;
    }
    if (expectColumn || columns.length === 0) refuse(`DO UPDATE SET column list is empty or ends in a comma near ${near}`);
    result.writes.push({ table, columns: columns.sort() });
  }
  return result;
}

function inventory(source) {
  const total = { writes: [], doUpdate: 0, onConflict: 0, onConflictRead: 0 };
  for (const text of sqlTexts(source)) {
    const part = analyze(text);
    total.writes.push(...part.writes);
    for (const key of ["doUpdate", "onConflict", "onConflictRead"]) total[key] += part[key];
  }
  const { writes } = total;
  for (const { table } of writes) assert.ok(Object.hasOwn(RUNNERS, table), `unclassified web-push upsert:${table}`);
  // Fail closed: every DO UPDATE and ON CONFLICT the lexer saw must belong to a classified INSERT.
  assert.equal(total.doUpdate, writes.length, `${REFUSAL}: ${total.doUpdate} DO UPDATE clauses, ${writes.length} recognised writes`);
  assert.equal(total.onConflict, total.onConflictRead, `${REFUSAL}: ${total.onConflict} ON CONFLICT clauses, ${total.onConflictRead} belong to a read INSERT`);
  return writes;
}
function freshColumns(table) {
  const sql = read("db/roles/private_web_roles.sql").replace(/--[^\n]*/g,"");
  return [...sql.matchAll(/GRANT UPDATE\s*\(([^)]*)\)\s+ON\s+(\w+)\s+TO control_room_private_web/g)]
    .filter(([, ,name])=>name===table).flatMap(([,columns])=>columns.split(",").map(x=>x.trim())).sort();
}
const source = () => read("src/web-push/v1/postgres-store.ts");

// Fixtures are appended to the real store as valid TypeScript. `asTemplate` turns the
// SQL text into the template literal whose cooked value is exactly that SQL.
const asTemplate = (sql, substitutions = false) => `\`${sql.replaceAll("\\", "\\\\").replaceAll("`", "\\`")
  .replace(substitutions ? /(?!)/g : /\$\{/g, "\\${")}\``;
const withSql = (sql, substitutions) => `\nexport const fixtureSql = ${asTemplate(sql, substitutions)};\n`;
const unknown = "INSERT INTO unknown_push_store(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET id=2";
const upsert = head => `${head} VALUES(1)\n  ON CONFLICT(id) DO UPDATE SET id=2`;
const REAL_TABLES = Object.keys(RUNNERS).sort();
const unclassified = /unclassified web-push upsert:unknown_push_store/;

test("CR-E075 upsert inventory refuses an unclassified future write", () => {
  const writes=inventory(source()); assert.deepEqual(writes.map(x=>x.table).sort(),Object.keys(RUNNERS).sort());
  const web=read("src/web/v1/mac-local-web-process.ts"), serving=read("src/web/v1/mac-local-serving.ts");
  assert.match(web,/store: new PostgresOwnerPushStoreV1\(options\.database\.client\)/);
  assert.match(serving,/new PostgresOwnerPushStoreV1/);
  assert.throws(()=>inventory(source()+withSql(unknown)),
    /unclassified web-push upsert:unknown_push_store/,"unknown writes cannot silently escape the runner inventory");
});
test("CR-E075 upsert inventory refuses spelling variants of an unknown write", () => {
  for (const [name, sql] of [
    ["lowercase", upsert("insert into unknown_push_store(id)")],
    ["mixed case", upsert("Insert Into unknown_push_store(id)")],
    ["newline after INTO", upsert("INSERT INTO\n    unknown_push_store(id)")],
    ["quoted", upsert('INSERT INTO "unknown_push_store"(id)')],
    ["schema-qualified", upsert("INSERT INTO public.unknown_push_store(id)")],
    ["quoted schema-qualified", upsert('INSERT INTO "public"."unknown_push_store"(id)')],
    ["lowercase on conflict", "insert into unknown_push_store(id) values(1) on conflict(id) do update set id=2"],
  ]) assert.throws(() => inventory(source() + withSql(sql)), unclassified, `${name} unknown upsert must be refused`);
  for (const [name, sql] of [
    ["block comment before INTO", upsert("INSERT /* c */ INTO unknown_push_store(id)")],
    ["block comment after INTO", upsert("INSERT INTO /* c */ unknown_push_store(id)")],
    ["line comment separator", upsert("INSERT -- c\nINTO unknown_push_store(id)")],
    ["comment between schema and table", upsert("INSERT INTO public /* c */ . unknown_push_store(id)")],
  ]) assert.throws(() => inventory(source() + withSql(sql)), unclassified, `${name} must not hide an unknown upsert`);
  assert.throws(() => inventory(source() + withSql(upsert('INSERT INTO "OWNER_WEB_PUSH_SUBSCRIPTIONS"(id)'))),
    /unclassified web-push upsert:OWNER_WEB_PUSH_SUBSCRIPTIONS/, "a quoted upper-case name is a different relation from the classified one");
  assert.throws(() => inventory(source() + withSql(upsert('INSERT INTO "owner_web_push_subscriptions "(id)'))),
    /unclassified web-push upsert:owner_web_push_subscriptions $/, "a quoted name with a trailing space is a different relation");
  assert.throws(() => inventory(source() + withSql(upsert("INSERT INTO ${table}(id)"), true)), /unparsed web-push upsert/,
    "an upsert whose table cannot be read must fail closed, never pass as classified");
  assert.deepEqual(inventory(source() + withSql("/* ON CONFLICT(id) DO UPDATE SET id=2 */ -- DO UPDATE\n")).map(x => x.table).sort(), REAL_TABLES,
    "SQL comment text is not an upsert");
  assert.deepEqual(inventory(`${source()}\n// ${unknown}\n/* ${unknown} */\n`).map(x => x.table).sort(), REAL_TABLES,
    "TypeScript comment text is not an upsert");
  assert.equal(inventory(source() + withSql(upsert("INSERT INTO OWNER_WEB_PUSH_DELIVERIES(id)"))).filter(x => x.table === "owner_web_push_deliveries").length, 2,
    "an unquoted upper-case spelling folds to the classified relation");
  assert.throws(() => inventory(source() + withSql(upsert("INSERT INTO other_schema.unknown_push_store(id)"))),
    /unclassified web-push upsert:other_schema\.unknown_push_store/, "a different schema is never folded into public");
  assert.deepEqual(inventory(source()).map(x => x.table).sort(), REAL_TABLES, "the real store still classifies");
  assert.deepEqual(inventory(source() + withSql(upsert("INSERT INTO public.owner_web_push_deliveries(id)"))).filter(x => x.table === "owner_web_push_deliveries").length, 2,
    "a qualified spelling of a classified table is still counted");
});
test("CR-E075 upsert inventory reads comments and strings by their lexical rules", () => {
  // Round-5 reviewers' reproductions: each hid an unknown upsert from the regex stripper.
  for (const [name, appended] of [
    ["TS string image/* before and a later doc comment", `\nexport const accept = "image/*";${withSql(unknown)}/** doc */\n`],
    ["SQL string '--' ahead of the upsert on one line", withSql(`SELECT '--'; ${unknown}`)],
    ["TS decrement n-- on the line before the upsert", `\nlet n = 2; n--; export const q = ${asTemplate(unknown)};\n`],
    ["TS string url/* before and */ after", `\nexport const origin = "https://fcm.googleapis.com/*";${withSql(unknown)}export const close = "*/";\n`],
    ["SQL string '--' inside the upsert values", withSql("INSERT INTO unknown_push_store(id) VALUES('--') ON CONFLICT(id) DO UPDATE SET id=2")],
    ["TS strings \"/*\" before and \"*/\" after", `\nexport const open = "/*";${withSql(unknown)}export const close = "*/";\n`],
    ["SQL strings '/*' and '*/' inside the upsert", withSql("INSERT INTO unknown_push_store(id,note) VALUES(1,'/*') ON CONFLICT(id) DO UPDATE SET note='*/'")],
    ["TS decrement i-- before a one-line template", `\nlet i = 3; i--; export const q = ${asTemplate(unknown)};\n`],
    ["ordinary string content around the markers", withSql("INSERT INTO unknown_push_store(id,note) VALUES(1,'a/*b') ON CONFLICT(id) DO UPDATE SET note='c*/d'")],
    ["dollar-quoted markers", withSql("INSERT INTO unknown_push_store(id,note) VALUES(1,$$/*$$) ON CONFLICT(id) DO UPDATE SET note=$$*/$$")],
    ["tagged dollar-quoted markers", withSql("INSERT INTO unknown_push_store(id,note) VALUES(1,$t$/*$t$) ON CONFLICT(id) DO UPDATE SET note=$t$*/$t$")],
    ["escape-string markers", withSql("INSERT INTO unknown_push_store(id,note) VALUES(1,E'\\'/*') ON CONFLICT(id) DO UPDATE SET note=E'\\'*/'")],
    ["backslash-quote inside an E string does not end it", withSql(`SELECT E'\\'--'; ${unknown}`)],
    ["doubled quote inside a string does not end it", withSql(`SELECT 'it''s --'; ${unknown}`)],
    ["doubled quotes inside an EXECUTE string do not end it early",
      withSql("SELECT 'INSERT INTO unknown_push_store(id,note) VALUES(1,''x'') ON CONFLICT(id) DO UPDATE SET note=''y'''")],
    ["comment marker inside a quoted identifier", withSql(`SELECT 1 AS "a--b"; ${unknown}`)],
    ["comment closed only by its matching nested end", withSql(`/* a /* b */ c */ ${unknown}`)],
    ["upsert inside a dollar-quoted DO block", withSql(`DO $$ BEGIN ${unknown}; END $$`)],
    ["upsert inside a tagged dollar-quoted function body", withSql(`SELECT $fn$ ${unknown} $fn$`)],
    ["upsert inside an EXECUTE string", withSql(`DO $$ BEGIN EXECUTE '${unknown}'; END $$`)],
  ]) assert.throws(() => inventory(source() + appended), unclassified, `${name} must not hide an unknown upsert`);
  assert.deepEqual(inventory(source() + withSql(`/* a /* b */ ${unknown} */ SELECT 1`)).map(x => x.table).sort(), REAL_TABLES,
    "an upsert that sits wholly inside a nested comment is not an upsert");
  assert.deepEqual(inventory(`${source()}\nlet n = 2; n--; export const accept = "image/*"; /** doc */\n`).map(x => x.table).sort(), REAL_TABLES,
    "ordinary TypeScript with -- and /* in code and strings adds no write and no false refusal");
});
test("CR-E075 upsert inventory fails closed on SQL it cannot classify", () => {
  for (const [name, appended, expected] of [
    ["a MERGE statement", withSql("MERGE INTO unknown_push_store t USING src s ON t.id = s.id WHEN MATCHED THEN UPDATE SET id = 2"), /unparsed web-push upsert: MERGE/],
    ["INSERT without INTO", withSql("INSERT unknown_push_store(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET id=2"), /unparsed web-push upsert: INSERT is not followed by INTO/],
    ["an INSERT target that is a substitution", withSql("INSERT INTO ${table}(id) VALUES(1)", true), /unparsed web-push upsert: INSERT INTO target cannot be read/],
    ["a substituted verb ahead of an upsert", withSql("${verb} INTO unknown_push_store(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET id=2", true), /unparsed web-push upsert: 3 DO UPDATE clauses, 2 recognised writes/],
    ["a DO UPDATE with no INSERT before it", withSql("ON CONFLICT(id) DO UPDATE SET id=2"), /unparsed web-push upsert: 3 DO UPDATE clauses, 2 recognised writes/],
    ["an ON CONFLICT with no INSERT before it", withSql("ON CONFLICT(id) DO NOTHING"), /unparsed web-push upsert: 3 ON CONFLICT clauses, 2 belong to a read INSERT/],
    ["a multi-column SET list on a classified table",
      withSql("INSERT INTO owner_web_push_subscriptions(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET (p256dh, auth) = (1, 2)"), /unparsed web-push upsert: DO UPDATE SET column list cannot be read/],
    ["a DO UPDATE with no SET", withSql("INSERT INTO owner_web_push_subscriptions(id) VALUES(1) ON CONFLICT(id) DO UPDATE WHERE true"), /unparsed web-push upsert: DO UPDATE is not followed by SET/],
    ["an unterminated block comment", withSql(`${unknown} /* tail`), /unparsed web-push upsert: unterminated block comment/],
    ["an unterminated nested block comment", withSql(`/* a /* b */ ${unknown}`), /unparsed web-push upsert: unterminated block comment/],
    ["an unterminated string", withSql(`${unknown}; SELECT 'tail`), /unparsed web-push upsert: unterminated string literal/],
    ["an unterminated escape string", withSql(`${unknown}; SELECT E'tail\\'`), /unparsed web-push upsert: unterminated string literal/],
    ["an unterminated quoted identifier", withSql(`${unknown}; SELECT "tail`), /unparsed web-push upsert: unterminated quoted identifier/],
    ["an unterminated dollar quote", withSql(`${unknown}; SELECT $tag$ tail`), /unparsed web-push upsert: unterminated dollar quote/],
    ["TypeScript that does not parse", "\nexport const = ;\n", /unparsed web-push upsert: the TypeScript source does not parse/],
    ["an unterminated TypeScript template", `\nexport const q = \`${unknown}`, /unparsed web-push upsert: the TypeScript source does not parse/],
    ["SQL built by string concatenation", `\nexport const q = "INSERT INTO unknown_push_store(id) VALUES(1) " + "ON CONFLICT(id) DO UPDATE SET id=2";\n`, /unparsed web-push upsert: SQL built by string concatenation/],
    ["SQL built by concatenating a template", `\nexport const q = \`INSERT INTO unknown_push_store(id) VALUES(1) \` + "x";\n`, /unparsed web-push upsert: SQL built by string concatenation/],
  ]) assert.throws(() => inventory(source() + appended), expected, `${name} must fail closed by name`);
  const deep = Array.from({ length: 20 }).reduce(sql => `'${sql.replaceAll("'", "''")}'`, unknown);
  assert.throws(() => inventory(source() + withSql(deep)), /unparsed web-push upsert: SQL strings nest deeper than 16 levels/,
    "SQL strings nested past the bound fail closed");
  assert.throws(() => inventory(source() + withSql(`SELECT '${unknown.replaceAll("'", "''")}'`)), unclassified, "an upsert quoted inside a string is still read");
});
test("CR-E075 subscription upsert has exactly four fresh UPDATE columns", () => {
  const expected=["auth","expires_at","p256dh","updated_at"];
  assert.deepEqual(inventory(source()).find(x=>x.table==="owner_web_push_subscriptions").columns,expected);
  assert.deepEqual(freshColumns("owner_web_push_subscriptions"),expected,"subscription runner requires the four-column grant");
  assert.doesNotMatch(read("db/roles/private_web_roles.sql"),/GRANT UPDATE ON owner_web_push_subscriptions/);
});
test("delivery upsert preserves its independently declared three-column grant", () => {
  const expected=["completed_at","state","status_code"];
  assert.deepEqual(inventory(source()).find(x=>x.table==="owner_web_push_deliveries").columns,expected);
  assert.deepEqual(freshColumns("owner_web_push_deliveries"),expected);
});
test("CR-E075 subscription fresh migration generated and startup declarations agree", () => {
  const columns=["auth","expires_at","p256dh","updated_at"];
  assert.match(read("src/web/v1/private-database-preflight.ts"),/owner_web_push_subscriptions: \["p256dh", "auth", "expires_at", "updated_at"\]/);
  const migration=read("db/migrations/0299_owner_web_push_subscription_update_grant.sql");
  assert.match(migration,/GRANT UPDATE \(p256dh, auth, expires_at, updated_at\) ON owner_web_push_subscriptions TO control_room_private_web/);
  assert.match(read("db/down/0299_owner_web_push_subscription_update_grant.sql"),/REVOKE UPDATE \(p256dh, auth, expires_at, updated_at\) ON owner_web_push_subscriptions FROM control_room_private_web/);
  const desired=JSON.parse(read("deploy/postgres/desired-grants.json")).desired;
  assert.deepEqual(desired.filter(x=>x.startsWith("control_room_private_web|table|public.owner_web_push_subscriptions|")&&x.includes("|UPDATE|")),
    columns.map(c=>`control_room_private_web|table|public.owner_web_push_subscriptions|${c}|UPDATE|plain`));
});
