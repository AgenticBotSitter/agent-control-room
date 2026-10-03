import { isMainModuleV1 } from "../shared/is-main-module.mjs";
import packageJson from "../../../package.json";
import { nightlyBackupConfigurationPathV1, runNightlyBackupV1 } from "./nightly-backup";

export const NIGHTLY_BACKUP_USAGE_V1 =
  "Usage: nightlyBackup.js --configuration ABSOLUTE_PATH\nRuns one protected database backup and keeps the configured nightly history.\n";

const failureCodes = new Set([
  "nightly_backup_clock_refused",
  "nightly_backup_concurrent_refused",
  "nightly_backup_configuration_refused",
  "nightly_backup_credential_refused",
  "nightly_backup_dependency_missing",
  "nightly_backup_dump_timeout",
  "nightly_backup_execution_failed",
  "nightly_backup_incomplete",
  "nightly_backup_output_refused",
  "nightly_backup_retention_failed",
  "nightly_backup_usage_refused",
  // R4B-01: this run wrote a generation that does not bind its own bytes, so it
  // is not a backup anybody can restore. It has its own code rather than being
  // folded into "execution failed", because the difference between "the database
  // was not readable" and "what we just wrote is not what is on disk" is the
  // difference between a night to retry and a disk to investigate — and because
  // the generation is REMOVED rather than left as a partial nobody can use.
  "nightly_backup_unbound_generation",
  "unsafe_generation",
]);

type NightlyBackupRuntimeV1 = Parameters<typeof runNightlyBackupV1>[1];
type NightlyBackupIoV1 = Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>;

/**
 * A runtime override, for the real-PostgreSQL lane only.
 *
 * The direct-entry tail — the `process.exit` R4S-03 added — only runs when this
 * module IS the entry, so a test that spawns a child which merely imports
 * `mainNightlyBackupV1` never executes the line it is trying to cover. The
 * mutation run caught that: with `process.exit` deleted, the test still passed.
 *
 * So the lane runs THIS module as the entry, which means it needs a way to point
 * the dump at a scratch cluster's socket. This is that way, and it is closed in
 * production by three properties rather than by hope:
 *
 *   - it is OFF unless the environment variable is set, and a launchd job's
 *     environment is fixed by its plist, which nothing writes;
 *   - the override is only ever the `backup` PORT, which cannot change what is
 *     dumped, what is hashed or what is retained — the configuration parser still
 *     pins everything else, and `parseNightlyBackupConfigurationV1` still refuses
 *     a hand-edited file;
 *   - it is checked here, at the entry, so a value that is not an absolute path
 *     inside a temp directory is ignored rather than loaded.
 */
const testHookPathV1 = process.env.CONTROL_ROOM_NIGHTLY_BACKUP_TEST_HOOK;

async function testHookRuntimeV1(): Promise<Partial<NightlyBackupRuntimeV1>> {
  const path = testHookPathV1;
  if (typeof path !== "string" || !path.startsWith("/") || !path.includes("/tmp/")) return {};
  const { backup } = await import(path) as { backup?: NonNullable<NightlyBackupRuntimeV1>["backup"] };
  return typeof backup === "function" ? { backup } : {};
}

const processIo: NightlyBackupIoV1 = Object.freeze({
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
});

function failureCode(error: unknown): string {
  // A dump that hit the size-fitted limit says so, with its own code and the
  // limit in milliseconds, rather than being flattened into
  // `nightly_backup_execution_failed`. Everything else keeps the one
  // `error.message`-is-the-code contract.
  if (error instanceof Error && /^nightly_backup_dump_timeout:\d+$/u.test(error.message)) return error.message;
  return error instanceof Error && failureCodes.has(error.message) ? error.message : "nightly_backup_execution_failed";
}

/** A bounded CLI boundary: expected refusals are named and no Error object is printed. */
export async function mainNightlyBackupV1(args: readonly string[], runtime?: NightlyBackupRuntimeV1,
  io: NightlyBackupIoV1 = processIo): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.stdout(NIGHTLY_BACKUP_USAGE_V1);
    return 0;
  }
  if (args.length === 1 && args[0] === "--version") {
    io.stdout(`nightlyBackup.js ${packageJson.version}\n`);
    return 0;
  }
  const configurationPath = nightlyBackupConfigurationPathV1(args);
  if (!configurationPath) {
    io.stderr("nightly database backup failed: nightly_backup_usage_refused\n");
    return 64;
  }
  try {
    const report = await runNightlyBackupV1(configurationPath, runtime);
    // R4S-09: a run that succeeded while a future-dated generation exists still
    // has something to say, and the sayable thing is on the same line the owner
    // reads. "completed" alone would leave a directory dated 2031 on disk with
    // nothing anywhere saying why.
    io.stdout(report.laterDatedGenerations.length === 0
      ? "nightly database backup completed\n"
      : `nightly database backup completed (later-dated backups kept: ${report.laterDatedGenerations.join(", ")})\n`);
    return 0;
  } catch (error) {
    io.stderr(`nightly database backup failed: ${failureCode(error)}\n`);
    return 1;
  }
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  // R4S-03: this entry EXITS rather than setting `process.exitCode` and waiting
  // for the event loop to drain. The line it wrote and the code it returned were
  // both correct while the process stayed alive indefinitely, because a leaked
  // database client keeps a socket handle open. For a launchd
  // StartCalendarInterval job that is not cosmetic: while the job is still
  // "running", launchd does not start it again, so one failure would silently
  // skip every later night until something restarted the job.
  //
  // `process.exit` is safe here because every line this entry writes is
  // `process.stdout.write`/`process.stderr.write` of a short bounded string, and
  // Node flushes those pipes synchronously for a TTY and a file.
  //
  // This is also why the exit is NOT redundant. The `end()` on the failed
  // evidence client releases the leaked database socket, which is what made the
  // mutation run report this line as unprotected: with `end()` in place, nothing
  // is left holding the loop for THAT failure. It is left here for the failures
  // `end()` cannot cover — a handle this process never owned, a driver timer, a
  // pending promise chain — so the job's fate never depends on one cleanup being
  // complete. MEASURED in the real-PostgreSQL lane: a handle held open past the
  // return keeps this process alive, and this `process.exit` is what ends it.
  void mainNightlyBackupV1(process.argv.slice(2), await testHookRuntimeV1()).then(code => {
    process.exitCode = code;
    process.exit(code);
  }, () => {
    process.stderr.write("nightly database backup failed: nightly_backup_execution_failed\n");
    process.exit(1);
  });
}
