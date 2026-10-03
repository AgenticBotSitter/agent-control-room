// N1b self-test: each mutation runs in its own process group, restored in finally.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";

const mutations = [
  {
    "file": "src/web/v1/mac-local-task-runtime.ts",
    "find": "role === \"review\" && reviewKey !== undefined ? reviewKey :",
    "replace": "false ? reviewKey :",
    "why": "The installed writer must reuse the genesis signing key instead of generating a fresh review key."
  },
  {
    "file": "src/web/v1/mac-local-task-runtime.ts",
    "find": "const reviewKey = basename(protectedRoot) === \"Protected\"",
    "replace": "const reviewKey = false",
    "why": "Installed roots must require the stored state and may not fall back to development key generation."
  },
  {
    "file": "src/web/v1/mac-local-task-runtime.ts",
    "find": "if (reviewKey !== undefined && Buffer.from(loaded.keys.review).toString(\"base64url\") !== reviewKey) invalid();",
    "replace": "if (false) invalid();",
    "why": "Both an existing file and a concurrent winner must be refused when their review key differs from first-owner state."
  },
  {
    "file": "src/web/v1/mac-local-task-runtime.ts",
    "find": "? entry.uid === 0 && (entry.mode & 0o7027) === 0",
    "replace": "? (entry.mode & 0o7027) === 0",
    "why": "Installed protected directories must belong to root."
  },
  {
    "file": "src/web/v1/mac-local-task-runtime.ts",
    "find": "? entry.uid === 0 && (entry.mode & 0o7027) === 0",
    "replace": "? entry.uid === 0",
    "why": "Installed protected directories must not allow group writes or other access."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "if (!safeRoot(root)) refuse(\"first_owner_input_refused\");\n  const runtime",
    "replace": "if (false) refuse(\"first_owner_input_refused\");\n  const runtime",
    "why": "The read-only state entry must reject noncanonical and relative roots with a fixed input refusal."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "await requireStateDirectory(directory, stateRuntime());",
    "replace": "// MUTATED: creation skipped the state directory check.",
    "why": "The original first-owner creator must use the same state directory custody rules as the read-only consumer."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "!stat.isDirectory() ||",
    "replace": "false ||",
    "why": "Reject a non-directory state container before opening any state file."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "(stat.mode & 0o7777) !== 0o700",
    "replace": "false",
    "why": "The shared state directory must be private, exactly mode 0700."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "|| stat.uid !== runtime.ownerUid) refuse(\"first_owner_state_refused\");\n}",
    "replace": "|| false) refuse(\"first_owner_state_refused\");\n}",
    "why": "A state directory owned by another account must be refused."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK",
    "replace": "fsConstants.O_RDONLY | fsConstants.O_NONBLOCK",
    "why": "A symlink must not be followed even when it targets a valid private state file."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "!stat.isFile() || stat.nlink",
    "replace": "false || stat.nlink",
    "why": "Refuse a nonregular state file before reading bytes."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "stat.nlink !== 1",
    "replace": "false",
    "why": "A hard-linked state file violates once-only private custody."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "(stat.mode & 0o7777) !== 0o600",
    "replace": "false",
    "why": "The state file must have exactly mode 0600."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "stat.size > 4096",
    "replace": "false",
    "why": "Oversized state must be refused before any bytes are read."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "|| stat.uid !== runtime.ownerUid) refuse(\"first_owner_state_refused\");\n    let value;",
    "replace": "|| false) refuse(\"first_owner_state_refused\");\n    let value;",
    "why": "A state file owned by another account must be refused."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "!exactKeys(value, [\"schema\", \"createdAt\", \"reviewKey\"])",
    "replace": "false",
    "why": "State must have exactly the three expected fields."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "value.schema !== FIRST_OWNER_STATE_V1",
    "replace": "false",
    "why": "A different state schema may not supply the genesis signing key."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "!Number.isFinite(Date.parse(value.createdAt))",
    "replace": "false",
    "why": "An invalid calendar date must produce the fixed refusal rather than escaping as a raw RangeError."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "new Date(value.createdAt).toISOString() !== value.createdAt",
    "replace": "false",
    "why": "A nonexistent date that normalises to another date is not valid retry state."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "!ISO.test(value.createdAt)",
    "replace": "false",
    "why": "State timestamps must use the exact stored ISO format."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "!KEY.test(value.reviewKey)",
    "replace": "false",
    "why": "Review key length and alphabet must represent exactly 32 bytes."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "Buffer.from(value.reviewKey, \"base64url\").toString(\"base64url\") !== value.reviewKey",
    "replace": "false",
    "why": "Only the canonical byte-for-byte encoding of the review key is accepted."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK",
    "replace": "fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW",
    "why": "The state reader must not block indefinitely on a pipe."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "(stat.mode & 0o7777) !== 0o700",
    "replace": "(stat.mode & 0o777) !== 0o700",
    "why": "Special permission bits on the state directory are not mode 0700."
  },
  {
    "file": "src/updater/v1/pg/first-owner-state.mjs",
    "find": "(stat.mode & 0o7777) !== 0o600",
    "replace": "(stat.mode & 0o777) !== 0o600",
    "why": "Special permission bits on the state file are not mode 0600."
  }
];
const command = ["--import", "tsx", "--test", "tests/updater-task-runtime-key.test.mjs", "tests/updater-first-owner-script.test.mjs"];

async function runTests() {
  const child = spawn(process.execPath, command, { detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" } });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 30_000);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(status.signal, null, "mutation test must finish normally");
    return { code: status.code, output };
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
  }
}

export async function verifyN1bMutationsV1() {
  assert.equal((await runTests()).code, 0, "unmodified baseline must pass");
  for (const [index, mutation] of mutations.entries()) {
    const original = await readFile(mutation.file);
    const text = original.toString("utf8");
    assert.equal(text.split(mutation.find).length - 1, 1, "mutation anchor must match exactly once");
    try {
      await writeFile(mutation.file, text.replace(mutation.find, () => mutation.replace));
      const result = await runTests();
      assert.equal(result.code, 1, `mutation ${index + 1} must be caught`);
      assert.match(result.output, /not ok/u, "a test assertion must fail");
      assert.doesNotMatch(result.output, /SyntaxError:/u, "a parse error does not prove a guard works");
      process.stdout.write(`caught ${index + 1}: ${mutation.why}\n`);
    } finally { await writeFile(mutation.file, original); }
  }
  assert.equal((await runTests()).code, 0, "restored baseline must pass");
  process.stdout.write(`N1b: ${mutations.length}/${mutations.length} mutations caught; all process groups gone\n`);
}

if (isMainModuleV1(process.argv[1], import.meta.url)) await verifyN1bMutationsV1();
