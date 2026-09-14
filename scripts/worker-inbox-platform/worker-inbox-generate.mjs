// Generates scheduler definitions for the worker inbox watcher.
//
// Generation only. This command does not install, enable, load, or start anything: it writes
// text files into an output directory and prints the instructions for the operator. Actual
// native scheduler installation is separately authorized and is not performed or claimed
// here.
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PLATFORMS, artifactsFor } from "./lib/artifacts.mjs";
import { instructionsFor } from "./lib/instructions.mjs";
import {
  LAUNCHD_ERR_LOG, LAUNCHD_OUT_LOG, assertRepository, assertWorkerId, ensureWorkerDirectory,
  generatedDirectory, workerDirectory,
} from "./lib/runtime.mjs";
import { isWellFormedXml } from "./lib/xml-wellformed.mjs";

export const EXIT_OK = 0;
export const EXIT_CONFIG = 1;

export function argumentsFor(argv) {
  const options = {
    repository: "AgenticBotSitter/agent-control-room",
    intervalSeconds: 300,
    all: false,
    json: false,
    tokenFromGh: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--platform") options.platform = argv[++index];
    else if (flag === "--all") options.all = true;
    else if (flag === "--worker-id") options.workerId = argv[++index];
    else if (flag === "--repository") options.repository = argv[++index];
    else if (flag === "--out") options.out = argv[++index];
    else if (flag === "--runtime-root") options.runtimeRoot = argv[++index];
    else if (flag === "--signal-directory") options.signalDirectory = argv[++index];
    else if (flag === "--interval") options.intervalSeconds = Number(argv[++index]);
    else if (flag === "--node-path") options.nodePath = argv[++index];
    else if (flag === "--script-path") options.scriptPath = argv[++index];
    else if (flag === "--working-directory") options.workingDirectory = argv[++index];
    else if (flag === "--json") options.json = true;
    else if (flag === "--token-from-gh") options.tokenFromGh = true;
    else if (flag === "--help") options.help = true;
    else throw new Error(`worker_inbox_platform_argument_invalid:${flag}`);
  }
  return options;
}

export function usage() {
  return [
    "Usage: node scripts/worker-inbox-platform/worker-inbox-generate.mjs --worker-id ID (--platform NAME | --all) [options]",
    "",
    "Generates scheduler definitions and setup instructions. It does not install them.",
    "",
    "Options:",
    `  --platform NAME           One of ${PLATFORMS.join(", ")}.`,
    "  --all                     Generate every supported platform.",
    "  --worker-id ID            Stable worker ID (required).",
    "  --repository OWNER/NAME   Default AgenticBotSitter/agent-control-room.",
    "  --out DIR                 Where to write artifacts. Must be the worker runtime directory's",
    "                            generated/ subdirectory, or a path inside it, because that is the",
    "                            only location uninstall can clean up.",
    "  --runtime-root DIR        Where state, logs and signals live.",
    "  --signal-directory DIR    Optional extra directory for the signal file.",
    "  --interval SECONDS        Poll interval written into the definition (default 300).",
    "  --node-path PATH          Node executable to reference (default: the current one).",
    "  --script-path PATH        Watcher script to reference (default: this script's sibling).",
    "  --working-directory PATH  Working directory written into the definition.",
    "  --token-from-gh           Write definitions that use `gh auth token` in memory.",
    "  --json                    Print a machine-readable summary.",
    "  --help                    Show this message.",
    "",
    "No credentials are embedded in any generated file.",
  ].join("\n");
}

// True when `child` is `parent` itself or lives underneath it. Path-aware rather than a string
// prefix test, so `/rt/generated-backup` is not treated as living inside `/rt/generated`.
function isWithin(child, parent) {
  const relativePath = relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

// `options` is merged over the same defaults `argumentsFor` applies, so the exported function
// is usable on its own and does not depend on a CLI having filled them in first.
export function generate({ options: provided = {}, scriptPath, nodePath, now = () => new Date() }) {
  const options = { repository: "AgenticBotSitter/agent-control-room", intervalSeconds: 300, ...provided };
  const workerId = assertWorkerId(options.workerId);
  const repository = assertRepository(options.repository);
  if (!Number.isFinite(options.intervalSeconds) || options.intervalSeconds < 1) {
    throw new Error("worker_inbox_platform_interval_invalid");
  }
  const platforms = options.all ? [...PLATFORMS] : [options.platform];
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform)) throw new Error("worker_inbox_platform_platform_invalid");
  }
  const runtimeDirectory = workerDirectory({ workerId, runtimeRoot: options.runtimeRoot });
  ensureWorkerDirectory(runtimeDirectory, { workerId });
  // Ownership boundary. Uninstall deletes only entries it recognises inside the worker runtime
  // directory, and `generated/` is the one directory it owns and removes recursively. An --out
  // anywhere else would leave artifacts that nothing owns and nothing can clean up - the same leak
  // that the launchd logs caused before they were made owned entries - so a stray output directory
  // is refused instead of being written and orphaned.
  const ownedArtifactDirectory = generatedDirectory(runtimeDirectory);
  const artifactDirectory = options.out ? resolve(options.out) : ownedArtifactDirectory;
  if (!isWithin(artifactDirectory, ownedArtifactDirectory)) {
    throw new Error("worker_inbox_platform_out_directory_not_owned");
  }
  mkdirSync(artifactDirectory, { recursive: true });

  const shared = {
    workerId,
    repository,
    runtimeDirectory,
    intervalSeconds: options.intervalSeconds,
    nodePath: nodePath ?? process.execPath,
    scriptPath,
    workingDirectory: options.workingDirectory ?? process.cwd(),
    signalDirectory: options.signalDirectory,
    tokenFromGh: options.tokenFromGh,
    startBoundary: now().toISOString().replace(/\.\d{3}Z$/, ""),
    // launchd appends this process's console output itself, so it must not be the same file
    // the watcher bounds internally: two writers would interleave and the advertised bound
    // would not hold. The launcher gets its own pair, and the watcher keeps watch.log.
    // Both are still owned entries, so an uninstall removes them with everything else.
    standardOut: join(runtimeDirectory, LAUNCHD_OUT_LOG),
    standardError: join(runtimeDirectory, LAUNCHD_ERR_LOG),
  };

  const written = [];
  const instructions = [];
  for (const platform of platforms) {
    const perPlatform = { ...shared };
    const artifacts = artifactsFor({ platform, ...perPlatform });
    for (const artifact of artifacts) {
      // Refuse to emit malformed XML rather than shipping a file that only fails on the
      // operator's machine.
      if (/\.(?:xml|plist)$/u.test(artifact.name) && !isWellFormedXml(artifact.content)) {
        throw new Error(`worker_inbox_platform_artifact_malformed:${artifact.name}`);
      }
      const target = join(artifactDirectory, artifact.name);
      writeFileSync(target, artifact.content, "utf8");
      written.push({ platform, name: artifact.name, path: target, bytes: Buffer.byteLength(artifact.content, "utf8") });
    }
    instructions.push({ platform, artifactDirectory, text: instructionsFor({
      platform, workerId, artifactDirectory, runtimeDirectory, repository,
    }) });
  }
  return { workerId, repository, runtimeDirectory, artifactDirectory, written, instructions };
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return EXIT_OK;
  }
  try {
    const result = generate({
      options,
      scriptPath: fileURLToPath(new URL("./worker-inbox-watch.mjs", import.meta.url)),
    });
    if (options.json) {
      console.log(JSON.stringify({ ...result, instructions: result.instructions.map(entry => entry.platform) }, null, 2));
      return EXIT_OK;
    }
    console.log(`Generated ${result.written.length} artifact(s) in "${result.artifactDirectory}":`);
    for (const artifact of result.written) console.log(`  ${artifact.platform}: ${artifact.name}`);
    for (const entry of result.instructions) console.log(`\n${entry.text}`);
    return EXIT_OK;
  } catch (error) {
    console.error(`worker-inbox-generate: ${error.message}`);
    return EXIT_CONFIG;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; });
}
