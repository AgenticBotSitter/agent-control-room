/**
 * Select grant statements that a staged migration prefix can execute.
 *
 * This support module is deliberately not a test module: both the PGlite
 * regression test and the real-PostgreSQL lifecycle lane use it, so importing
 * it must never register another lane's tests with Node's active test runner.
 */
export function applicableStatements(statements: readonly string[], absent: ReadonlySet<string>): string[] {
  if (absent.size === 0) return [...statements];
  const names = [...absent];
  const mentions = (text: string) => names.some(name => new RegExp(`\\b${name}\\b`, "u").test(text));
  const kept: string[] = [];
  for (const statement of statements) {
    // The column list of a column-level GRANT, and the relation list after ON.
    // Each is rewritten to the names that still exist; a list that empties out
    // takes the whole statement with it, because `GRANT SELECT ON <nothing> TO x`
    // is a syntax error rather than a no-op. Only ON names relations: the FROM of
    // a REVOKE names ROLES, which are cluster-global and present on both sides,
    // so rewriting that list would corrupt the statement.
    let usable = true;
    let text = statement.replace(/\(([^)]*)\)/gu, (whole, columns: string) => {
      const parts = columns.split(",").map(part => part.trim()).filter(Boolean);
      const remaining = parts.filter(part => !absent.has(part));
      if (remaining.length === parts.length) return whole;
      if (remaining.length === 0) { usable = false; return ""; }
      return `(${remaining.join(", ")})`;
    });
    if (usable) text = text.replace(/\bON\s+(SCHEMA\s+)?(ALL\s+\w+\s+IN\s+SCHEMA\s+)?(FUNCTION\s+|PROCEDURE\s+)?([^;]*?)\s+(TO|FROM)\b/giu,
      (whole, schema: string | undefined, allIn: string | undefined,
        routine: string | undefined, list: string, direction: string) => {
        // `ON SCHEMA x TO/FROM y` names a schema, and `ON ALL ... IN SCHEMA x`
        // names that schema too. Both are dropped whole when the schema is absent,
        // since neither has a partial form: there is no list to trim. The keywords
        // are captured so the rewrite cannot turn `ON ALL TABLES IN SCHEMA x` into
        // a grant on a relation that happens to share the name.
        //
        // `public` is the exception: it is what the blanket grants on every
        // table are written against, and a staged prefix always has it, so
        // naming it absent would drop the previous release's own authority.
        const schemaName = (schema ? list : allIn ? allIn.replace(/^ALL\s+\w+\s+IN\s+SCHEMA\s+/i, "") : "").trim();
        if (schemaName && schemaName !== "public" && mentions(schemaName)) { usable = false; return ""; }
        if (schema || allIn) return whole;
        // The routine keyword is captured separately: `ON FUNCTION f(text) TO x`
        // must be rewritten to `ON FUNCTION f TO x`, not to a name of
        // "FUNCTION f". A routine grant has exactly one target, and its argument
        // list may itself contain commas -- `f(text,text,text)` splits into three
        // bogus "relations" if the list is comma-split, so a routine target is
        // never split: it is either wholly present and kept verbatim, or wholly
        // absent and takes the statement with it. A partially-kept routine grant
        // is meaningless and would raise 42883 anyway.
        if (routine) {
          const name = list.replace(/\(.*$/u, "").trim();
          if (mentions(name)) { usable = false; return ""; }
          return whole;
        }
        const parts = list.split(",").map(part => part.trim()).filter(Boolean);
        const remaining = parts.filter(part => !mentions(part.replace(/\(.*$/u, "").trim()));
        if (remaining.length === parts.length) return whole;
        if (remaining.length === 0) { usable = false; return ""; }
        return `ON ${remaining.join(", ")} ${direction}`;
      });
    // Dropped: a list emptied out, or a statement that still names something the
    // prefix does not have. Everything else is kept verbatim, including
    // statements with no relation list at all (ALTER DEFAULT PRIVILEGES, and
    // `ON ALL TABLES IN SCHEMA public`), which apply as they are.
    if (!usable || mentions(text)) continue;
    kept.push(text.trim());
  }
  return kept;
}
