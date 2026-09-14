// Removes the local files this tool created for one worker.
//
// The runtime directory must carry this tool's ownership marker, or nothing is removed.
// Unrecognised files inside an owned directory are preserved and reported, so a stray file
// an operator put there by hand is never destroyed by cleanup.
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertWorkerId, recordedExternalSignals, removeOwnedFiles, workerDirectory, workerSlug } from "./lib/runtime.mjs";

export const EXIT_OK = 0;
export const EXIT_CONFIG = 1;
export const EXIT_REFUSED = 3;

export function argumentsFor(argv) {
  const options = { json: false, dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--worker-id") options.workerId = argv[++index];
    else if (flag === "--runtime-root") options.runtimeRoot = argv[++index];
    else if (flag === "--signal-directory") options.signalDirectory = argv[++index];
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--help") options.help = true;
    else throw new Error(`worker_inbox_platform_argument_invalid:${flag}`);
  }
  return options;
}

export function usage() {
  return [
    "Usage: node scripts/worker-inbox-platform/worker-inbox-uninstall.mjs --worker-id ID [options]",
    "",
    "Removes the local state, log, signal and generated files for one worker.",
    "",
    "Options:",
    "  --worker-id ID       Stable worker ID (required).",
    "  --runtime-root DIR   Runtime directory to clean.",
    "  --signal-directory DIR",
    "                       Remove the extra signal file in this directory too. Required for that",
    "                       file to be removed: the tool will not delete outside its runtime",
    "                       directory on the strength of recorded state alone.",
    "  --dry-run            Report what would be removed without removing it.",
    "  --json               Print the result as JSON.",
    "  --help               Show this message.",
    "",
    "This does not remove a scheduler entry. Unload it first with the platform command in",
    "the setup instructions, then run this. Files not created by this tool are left alone.",
  ].join("\n");
}

export function uninstall({ options }) {
  const workerId = assertWorkerId(options.workerId);
  const directory = workerDirectory({ workerId, runtimeRoot: options.runtimeRoot });
  // The extra signal lives outside the runtime directory, and it is removed only when the operator
  // names that directory on THIS command. The marker records where it was last written, but a file
  // that anything with write access can edit must never authorise a deletion - so the recorded path
  // is used only to tell the operator which directory to pass.
  const named = typeof options.signalDirectory === "string" && options.signalDirectory.trim()
    ? join(resolve(options.signalDirectory), `${workerSlug(workerId)}.signal`)
    : undefined;
  const hinted = named ? [] : recordedExternalSignals(directory)
    // Filtered to the shape this tool writes, so a tampered marker cannot make the tool advise the
    // operator to point --signal-directory at an unrelated directory. This is a display filter only:
    // it decides what to print, never what to delete.
    .filter(entry => typeof entry === "string" && basename(entry) === `${workerSlug(workerId)}.signal`)
    .map(entry => dirname(entry));
  return {
    workerId,
    directory,
    ...removeOwnedFiles(directory, {
      dryRun: options.dryRun,
      externalFiles: named ? [named] : [],
    }),
    externalSignalDirectories: [...new Set(hinted)],
  };
}

function main(argv) {
  const options = argumentsFor(argv);
  if (options.help) {
    console.log(usage());
    return EXIT_OK;
  }
  const result = uninstall({ options });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.refused) {
    console.error(`worker-inbox-uninstall: refusing to remove "${result.directory}" (${result.reason}).`);
    console.error("That directory does not carry this tool's ownership marker.");
  } else if (result.missing) {
    console.log(`worker-inbox-uninstall: nothing to remove for worker ${result.workerId}.`);
  } else {
    const verb = options.dryRun ? "would remove" : "removed";
    console.log(`worker-inbox-uninstall: ${verb} ${result.removed.length} owned entr${result.removed.length === 1 ? "y" : "ies"} in "${result.directory}".`);
    for (const name of result.removed) console.log(`  ${verb}: ${name}`);
    for (const name of result.preserved) console.log(`  preserved (not created by this tool): ${name}`);
    // A recorded path that cannot be trusted means the marker has been edited or corrupted. It is
    // reported rather than ignored: silently declining to remove something is exactly the kind of
    // quiet behaviour that leaves an operator unable to explain what their runtime directory holds.
    for (const target of result.externalSignalDirectories ?? []) {
      console.log(`  note: an extra signal was written under "${target}"; re-run with --signal-directory "${target}" to remove it`);
    }
  }
  return result.refused ? EXIT_REFUSED : EXIT_OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`worker-inbox-uninstall: ${error.message}`);
    process.exitCode = EXIT_CONFIG;
  }
}
