import assert from "node:assert/strict";
import test from "node:test";
import { formatInstallPreflightV1, runInstallPreflightV1 } from "../scripts/install/preflight.mjs";

const tailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const postgres = "/opt/homebrew/opt/postgresql@17/bin/postgres";

// R4S-12: `lsof -iTCP:PORT` run as the owner cannot see a listener owned by a system service or
// another account, so the preflight said "free" while the port was in use. netstat reads the
// kernel socket table and has no such blind spot. Every fixture that is not about ports reports
// a clean, empty socket table, so a pre-existing test only fails on what it is actually testing.
const NETSTAT_HEADER = "Active Internet connections (including servers)\n"
  + "Proto Recv-Q Send-Q  Local Address           Foreign Address         (state)\n";
const netstatFree = { code: 0, stdout: NETSTAT_HEADER };

function fixture(overrides = {}) {
  const calls = [];
  const responses = new Map([
    ["/usr/bin/sw_vers -productVersion", { code: 0, stdout: "14.6\n" }],
    ["/usr/bin/uname -m", { code: 0, stdout: "arm64\n" }],
    ["/bin/df -kP /Library", { code: 0, stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 100 1 4194304 1% /Library\n" }],
    ["/usr/bin/xcode-select -p", { code: 0, stdout: "/Library/Developer/CommandLineTools\n" }],
    ["/usr/bin/dscl . -list /Users UniqueID", { code: 0, stdout: "root 0\nnobody -2\nowner 501\n" }],
    ["/usr/bin/dscl . -list /Groups PrimaryGroupID", { code: 0, stdout: "nobody -2\nnogroup -1\nwheel 0\nstaff 20\n" }],
    [`${postgres} --version`, { code: 0, stdout: "postgres (PostgreSQL) 17.4\n" }],
    [`${tailscale} status --json`, { code: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.ts.net." } }) }],
    [`${tailscale} serve status --json`, { code: 0, stdout: JSON.stringify({ Web: { "mac.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3210" } } } }, TCP: {}, AllowFunnel: {} }) }],
  ]);
  return { calls, geteuid: () => overrides.euid ?? 501,
    exists: path => path.startsWith("/opt/homebrew/opt/postgresql@17/bin/")
      || overrides.existing === true && path === "/Library/Application Support/Control Room"
      || overrides.legacy === true && path.endsWith("/Library/Application Support/Agent Control Room/Protected"),
    async run(file, args) {
      calls.push([file, args]); const key = `${file} ${args.join(" ")}`;
      if (file === "/usr/sbin/netstat") return overrides.netstat?.(args) ?? structuredClone(netstatFree);
      if (file === "/usr/sbin/lsof") return overrides.lsof?.(args) ?? { code: 1, stdout: "" };
      return structuredClone(overrides.responses?.[key] ?? responses.get(key) ?? { code: 1, stderr: "missing fixture" });
    } };
}

// R4S-12: `lsof -iTCP:PORT` run as the owner cannot see a listener owned by a system service or
// another account, so the preflight said "free" while the port was in use. netstat reads the
// kernel socket table and has no such blind spot.
const NETSTAT_FREE = "Active Internet connections (including servers)\n"
  + "Proto Recv-Q Send-Q  Local Address           Foreign Address         (state)\n";

test("R4S-12 preflight fails a required port held by an account its lsof cannot see", async () => {
  // A row exactly as the kernel prints it, for a listener this account does not own: the name
  // column is `*` and lsof therefore reports nothing. `ports` must FAIL, not pass.
  const netstat = { code: 0, stdout: `${NETSTAT_HEADER}tcp4       0      0  127.0.0.1.3210            *.*                    LISTEN      0      0  0x0  0x0  *     *      *     *     *         0        0\n` };
  const result = await runInstallPreflightV1(fixture({ netstat: () => netstat }));
  const ports = result.checks.find(row => row.id === "ports");
  assert.equal(ports.status, "fail");
  assert.match(ports.summary, /3210/u);
  assert.equal(result.ok, false);
  // And the owner is told WHY: lsof could not name the holder.
  const foreign = result.checks.find(row => row.id === "ports-other-account");
  assert.equal(foreign.status, "fail");
  assert.match(foreign.summary, /another account or a system service/u);
  // A wildcard-bound listener and a newer-macOS trailing count are both recognised.
  for (const row of [
    "tcp4       0      0  *.5432                 *.*                    LISTEN      0      0\n",
    "tcp4       0      0  *.5432                 *.*                    LISTEN      0      0  0x0  0x0  *   *    *   *   *   0  0\n",
    "tcp6       0      0  ::1.3212               *.*                    LISTEN      0      0\n",
  ]) {
    const checked = await runInstallPreflightV1(fixture({ netstat: () => ({ code: 0, stdout: NETSTAT_HEADER + row }) }));
    assert.equal(checked.checks.find(entry => entry.id === "ports").status, "fail", JSON.stringify(row));
  }
  // Control: with every required port free, netstat reporting nothing must still PASS, or the
  // check above would be passing for the wrong reason.
  const free = await runInstallPreflightV1(fixture({ netstat: () => ({ code: 0, stdout: NETSTAT_HEADER }) }));
  assert.equal(free.checks.find(row => row.id === "ports").status, "pass");
  assert.equal(free.checks.find(row => row.id === "ports-other-account"), undefined);
  // A listener on a port that is not required must not block anything.
  const other = await runInstallPreflightV1(fixture({ netstat: () => ({ code: 0, stdout: NETSTAT_HEADER
    + "tcp4       0      0  127.0.0.1.59999        *.*                    LISTEN      0      0\n" }) }));
  assert.equal(other.checks.find(row => row.id === "ports").status, "pass");
});

test("R4S-12 preflight refuses the port row when netstat cannot be read at all", async () => {
  // lsof alone already said free, so this is the exact blind spot the fix has to close.
  const result = await runInstallPreflightV1(fixture({ netstat: () => ({ code: 1, stdout: "" }) }));
  const ports = result.checks.find(row => row.id === "ports");
  assert.equal(ports.status, "fail");
  assert.match(ports.summary, /could not be checked safely/u);
  assert.equal(result.ok, false);
  // A netstat that fails or returns something unparseable must not be treated as "free".
  for (const broken of [{ code: 1, stdout: "" }, { code: 0, timedOut: true, stdout: "" }, { code: 0, stdout: "x".repeat(70 * 1024) }]) {
    const checked = await runInstallPreflightV1(fixture({ netstat: () => broken }));
    assert.equal(checked.checks.find(row => row.id === "ports").status, "fail", JSON.stringify(broken).slice(0, 40));
  }
});

test("preflight gives a short successful checklist without inspecting a credential", async () => {
  const ports = fixture(), result = await runInstallPreflightV1(ports);
  assert.equal(result.ok, true); assert.equal(result.checks.length, 12);
  assert(result.checks.every(row => row.mutation && row.action && row.status !== "fail"));
  const text = formatInstallPreflightV1(result);
  assert.match(text, /✅ PostgreSQL 17/u); assert.match(text, /⚠️ Have a Face ID-capable phone/u);
  assert.match(text, /read-only GitHub token ready/u);
  assert.equal(result.checks.find(row => row.id === "github-read-token").status, "warn");
  assert.equal(ports.calls.some(([file]) => file === "/usr/bin/security"), false);
});

test("preflight refuses root before it issues a system command", async () => {
  const ports = fixture({ euid: 0 }), result = await runInstallPreflightV1(ports);
  assert.equal(result.ok, false); assert.equal(result.checks[0].id, "owner"); assert.equal(ports.calls.length, 0);
});

test("each required owner-machine prerequisite fails closed", async () => {
  const cases = [
    ["macos", { "/usr/bin/sw_vers -productVersion": { code: 0, stdout: "13.7\n" } }],
    ["apple-silicon", { "/usr/bin/uname -m": { code: 0, stdout: "x86_64\n" } }],
    ["disk", { "/bin/df -kP /Library": { code: 0, stdout: "/dev/disk3 100 1 1 99% /Library\n" } }],
    ["xcode-clt", { "/usr/bin/xcode-select -p": { code: 1, stdout: "" } }],
    ["tailscale", { [`${tailscale} status --json`]: { code: 0, stdout: JSON.stringify({ BackendState: "Stopped", Self: {} }) } }],
  ];
  for (const [id, responses] of cases) {
    const result = await runInstallPreflightV1(fixture({ responses }));
    assert.equal(result.checks.find(row => row.id === id).status, "fail", id);
  }
});

test("existing current and legacy installs are warnings and never block a ready machine", async () => {
  let result = await runInstallPreflightV1(fixture({ existing: true }));
  assert.equal(result.ok, true);
  assert.match(result.checks.find(row => row.id === "existing-install").summary, /moved aside/u);
  assert.equal(result.checks.find(row => row.id === "existing-install").status, "warn");
  result = await runInstallPreflightV1(fixture({ legacy: true }));
  assert.equal(result.ok, true);
  assert.match(result.checks.find(row => row.id === "existing-install").summary, /moved aside/u);
  assert.equal(result.checks.find(row => row.id === "phone").status, "warn");
});

test("hostile Serve output, a Funnel, busy ports, and a slow command fail safely", async () => {
  let result = await runInstallPreflightV1(fixture({ responses: { [`${tailscale} serve status --json`]: { code: 0, stdout: "\u001b[31m{not json" } } }));
  assert.equal(result.checks.find(row => row.id === "tailscale-serve").status, "fail");
  result = await runInstallPreflightV1(fixture({ responses: { [`${tailscale} serve status --json`]: { code: 0,
    stdout: JSON.stringify({ Web: { "mac.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3210" } } } }, TCP: {}, AllowFunnel: { "mac.ts.net:443": true } }) } } }));
  assert.equal(result.checks.find(row => row.id === "tailscale-serve").status, "fail");
  result = await runInstallPreflightV1(fixture({ lsof: args => args[1] === "-iTCP:3211" ? { code: 0, stdout: "node 1\n" } : { code: 1, stdout: "" } }));
  assert.equal(result.checks.find(row => row.id === "ports").status, "fail");
  result = await runInstallPreflightV1(fixture({ responses: { [`${tailscale} status --json`]: { code: 1, timedOut: true, stdout: "" } } }));
  assert.equal(result.checks.find(row => row.id === "tailscale").status, "fail");
});

test("extra preview ports, missing PostgreSQL, and occupied account IDs refuse", async () => {
  const ports = fixture({ responses: {
    [`${tailscale} serve status --json`]: { code: 0, stdout: JSON.stringify({ Web: { "mac.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3210" } } }, "mac.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8443" } } } }, TCP: {}, AllowFunnel: {} }) },
    "/usr/bin/dscl . -list /Users UniqueID": { code: 0, stdout: "_controlroom 300\n_crdb 301\n_crbuild 302\n" },
    "/usr/bin/dscl . -list /Groups PrimaryGroupID": { code: 0, stdout: "a 303\nb 304\nc 305\n" },
  } });
  ports.exists = () => false;
  const result = await runInstallPreflightV1(ports);
  for (const id of ["postgres-17", "tailscale-serve", "service-accounts"]) assert.equal(result.checks.find(row => row.id === id).status, "fail");
});

test("service-account IDs follow the installer allocator across UID and GID sets", async () => {
  const result = await runInstallPreflightV1(fixture({ responses: {
    "/usr/bin/dscl . -list /Users UniqueID": { code: 0, stdout: "apple-a 300\napple-b 301\napple-c 302\napple-d 303\napple-e 304\napple-f 305\napple-g 306\napple-h 307\napple-i 308\n" },
    "/usr/bin/dscl . -list /Groups PrimaryGroupID": { code: 0, stdout: "apple-a 300\napple-b 301\napple-c 302\napple-d 303\napple-e 304\napple-f 305\napple-g 306\napple-h 307\napple-i 308\nlate-a 395\nlate-b 396\nlate-c 397\nlate-d 398\nlate-e 399\n" },
  } }));
  assert.equal(result.ok, true);
  assert.equal(result.checks.find(row => row.id === "service-accounts").status, "pass");
});
