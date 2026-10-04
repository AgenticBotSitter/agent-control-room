// The Module Contract v1 manifest for a compatibility module (News, Idea Lab)
// declares the exact `projectData` resources that module is allowed to touch
// (docs/MODULE_CONTRACT_V1.md, "Declared permissions"). Nothing yet forces the
// declaration to track the application code: a developer can add a new table
// to a store class without ever touching `src/modules/v1/registry.ts`, and the
// manifest would silently under-declare. This is exactly how `cook/idealab`'s
// `control_idea_promotion_task_links` table (added after the manifest was
// written) ended up missing from the Idea Lab manifest until this test caught
// it.
//
// This compares them statically: every `control_news_*` / `control_idea_*`
// table identifier that appears anywhere under `src/` must be declared by the
// matching module's manifest, and every resource the manifest declares must
// actually be used somewhere. A real PostgreSQL preflight
// (`private-web-role-preflight-declaration.test.ts`) separately proves the
// production grants track `db/roles/*.sql`; this proves the module manifest
// tracks the application code that assumes those grants.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

import { MODULE_REGISTRY_V1 } from "../src/modules/v1/registry";

const SRC_ROOT = join(process.cwd(), "src");
const TABLE_TOKEN_PATTERN = /\bcontrol_(?:news|idea)_[a-z][a-z0-9_]*[a-z0-9]\b/g;

/** Files that declare the mapping itself, or grant tables for reasons
 * unrelated to which resources a module's own code reads or writes. Excluding
 * them keeps the audit anchored to actual module code rather than to other
 * declarations that are already covered by their own guards. */
const EXCLUDED_RELATIVE_PATHS = new Set([
  join("modules", "v1", "registry.ts"),
  join("web", "v1", "private-database-preflight.ts"),
]);

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|mjs|mts)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
    files.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return files;
}

/** `moduleId -> the set of table tokens its manifest declares as `projectData`
 * resources`, and the prefix that maps a table token to that module. */
const MODULE_TABLE_PREFIXES: ReadonlyArray<{ moduleId: string; prefix: string }> = [
  { moduleId: "news", prefix: "control_news_" },
  { moduleId: "ideaLab", prefix: "control_idea_" },
];

function moduleIdForTable(table: string): string | undefined {
  return MODULE_TABLE_PREFIXES.find(({ prefix }) => table.startsWith(prefix))?.moduleId;
}

async function findTableUsageByModule(): Promise<Map<string, Set<string>>> {
  const usage = new Map<string, Set<string>>(MODULE_TABLE_PREFIXES.map(({ moduleId }) => [moduleId, new Set<string>()]));
  const files = await collectSourceFiles(SRC_ROOT);
  for (const file of files) {
    const relativePath = relative(SRC_ROOT, file);
    if (EXCLUDED_RELATIVE_PATHS.has(relativePath)) continue;
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(TABLE_TOKEN_PATTERN)) {
      const table = match[0];
      const moduleId = moduleIdForTable(table);
      if (!moduleId) continue;
      usage.get(moduleId)!.add(table);
    }
  }
  return usage;
}

test("News and Idea Lab manifests declare exactly the project-data resources their code uses", async () => {
  const usage = await findTableUsageByModule();
  for (const { moduleId } of MODULE_TABLE_PREFIXES) {
    const manifest = MODULE_REGISTRY_V1[moduleId];
    assert.ok(manifest, `module ${moduleId} must be registered`);
    const declared = new Set(manifest.permissions.projectData.map(({ resource }) => resource));
    const used = usage.get(moduleId)!;
    assert.ok(used.size > 0, `expected to find at least one control_${moduleId}_* table reference under src/`);

    const undeclared = [...used].filter((table) => !declared.has(table)).sort();
    assert.deepEqual(undeclared, [], `${moduleId} code uses undeclared project-data resource(s): ${undeclared.join(", ")}`);

    const unused = [...declared].filter((table) => !used.has(table)).sort();
    assert.deepEqual(unused, [], `${moduleId} manifest declares resource(s) no code under src/ actually uses: ${unused.join(", ")}`);
  }
});

test("registered module ids include the first two real modules", () => {
  assert.ok(Object.hasOwn(MODULE_REGISTRY_V1, "news"));
  assert.ok(Object.hasOwn(MODULE_REGISTRY_V1, "ideaLab"));
  assert.equal(MODULE_REGISTRY_V1.news.class, "code");
  assert.equal(MODULE_REGISTRY_V1.ideaLab.class, "code");
});
