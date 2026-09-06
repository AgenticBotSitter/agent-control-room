import { spawnSync } from "node:child_process";
import { readFile, lstat, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const testLaneNames = Object.freeze(["pre", "main-1", "main-2", "main-3", "main-4", "post"]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const invalid = () => { throw new Error("ci_test_lane_configuration_invalid"); };
const reuseTests = new Set(["scripts/research/pg-boss-submission-integration.test.mjs",
  "scripts/research/pg-boss-worker-integration.test.mjs"]);

function parseScript(command) {
  if (typeof command !== "string") return invalid();
  const tokens = command.trim().split(/\s+/);
  if (tokens.slice(0, 4).join(" ") !== "node --import tsx --test" || tokens.length <= 4) return invalid();
  const files = tokens.slice(4);
  for (const file of files) {
    if ((!/^tests\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.test\.(?:ts|tsx|mjs)$/.test(file) && !reuseTests.has(file))
      || file.split("/").some(part => part === "." || part === "..")) return invalid();
  }
  return files;
}

/** Pure inventory partition. Package scripts remain the source of truth; no test discovery/filtering. */
export function createTestLanePlan(scripts) {
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return invalid();
  const pre = parseScript(scripts.pretest), main = parseScript(scripts.test), post = parseScript(scripts.posttest);
  const all = [...pre, ...main, ...post];
  if (new Set(all).size !== all.length || main.length < 4) return invalid();
  const sorted = [...main].sort();
  return Object.freeze({ pre: Object.freeze(pre),
    ...Object.fromEntries([0, 1, 2, 3].map(index => [`main-${index + 1}`, Object.freeze(sorted.filter((_, position) => position % 4 === index))])),
    post: Object.freeze(post) });
}

/** Exact argv execution, no shell or retry. Files across the entire plan must exist before any lane runs. */
export async function runTestLane({ scripts, lane, root = repositoryRoot, spawn = spawnSync }) {
  const plan = createTestLanePlan(scripts);
  if (!testLaneNames.includes(lane) || typeof root !== "string" || typeof spawn !== "function") return invalid();
  const directory = await realpath(resolve(root));
  for (const file of Object.values(plan).flat()) {
    const path = resolve(directory, file), stat = await lstat(path), canonical = await realpath(path);
    if (!stat.isFile() || !canonical.startsWith(`${directory}${sep}`)) return invalid();
  }
  let result;
  try {
    result = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...plan[lane]],
      { cwd: directory, stdio: "inherit", shell: false });
  } catch { return 1; }
  if (!result || result.error || result.signal || !Number.isInteger(result.status) || result.status < 0 || result.status > 255) return 1;
  return result.status;
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--lane" || !testLaneNames.includes(args[1])) return invalid();
  const { scripts } = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  const plan = createTestLanePlan(scripts), lane = args[1];
  process.stdout.write(`CI test lane ${lane}: ${plan[lane].length} files; ${Object.values(plan).flat().length} total lifecycle files\n`);
  process.exitCode = await runTestLane({ scripts, lane });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("CI test lane could not complete; configuration or required files are unavailable.\n");
    process.exitCode = 1;
  });
}
