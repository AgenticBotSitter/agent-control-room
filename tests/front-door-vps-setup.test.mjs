import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const setupScript = join(repositoryRoot, "deploy/front-door/vps-setup.sh");
const policyScript = join(repositoryRoot, "deploy/front-door/tailnet-policy-snippet.mjs");
const ownerOnePager = join(repositoryRoot, "docs/front-door/OWNER_ONE_PAGER.md");
const liveGroups = new Set();

test("owner one-pager is generic and makes the Face-ID-only phishing warning prominent", async () => {
  const guide = await readFile(ownerOnePager, "utf8");
  assert.ok(guide.split(/\r?\n/u).length <= 60, "the owner guide must remain a one-pager");
  assert.match(guide, /Face ID only\. A page that asks you for a code or password is fake — close it\./u);
  assert.match(guide, /TLS passthrough/u);
  assert.match(guide, /`--remove` restores/u);
  assert.doesNotMatch(guide, /(?:\b\d{1,3}(?:\.\d{1,3}){3}\b|\.ts\.net\b|\b[a-z0-9][a-z0-9-]*@[a-z0-9.-]+\b)/iu);
});

async function executable(path, source) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function run(command, args, { env = {}, timeout = 20_000 } = {}) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveGroups.add(child.pid);
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }, timeout);
  try {
    const result = await new Promise((resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveResult({ code, signal }));
    });
    if (timedOut) assert.fail(`${command} timed out`);
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(timer);
    liveGroups.delete(child.pid);
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

test.after(() => {
  for (const pid of liveGroups) {
    try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
});

const baseArgs = [
  "--host", "front.example.invalid",
  "--tailnet-target", "100.100.100.100",
  "--port", "9443",
];

async function createHarness(variant) {
  const directory = await mkdtemp(join(tmpdir(), "front-door-test-"));
  const root = join(directory, "root");
  const bin = join(directory, "bin");
  const state = join(directory, "fake-state");
  await Promise.all([mkdir(bin), mkdir(state), mkdir(join(root, "run"), { recursive: true })]);
  await writeFile(join(state, "commands.log"), "");
  await writeFile(join(state, "prefs.json"), JSON.stringify({
    ShieldsUp: false,
    RouteAll: true,
    CorpDNS: true,
    RunSSH: true,
    AdvertiseRoutes: ["192.0.2.0/24", "0.0.0.0/0", "::/0"],
  }));
  await writeFile(join(state, "serve.json"), '{"TCP":{"5432":{"TCPForward":"tcp://127.0.0.1:5432"}}}\n');
  for (const service of ["nginx", "apache2", "caddy"]) {
    await writeFile(join(state, `${service}.enabled`), "yes");
    await writeFile(join(state, `${service}.active`), "yes");
  }
  await writeFile(join(state, "haproxy.enabled"), "no");
  await writeFile(join(state, "haproxy.active"), "no");
  await mkdir(join(root, "etc/haproxy"), { recursive: true });
  await writeFile(join(root, "etc/haproxy/haproxy.cfg"), "# original HAProxy configuration\n");

  await executable(join(bin, "systemctl"), `#!/bin/sh
set -eu
printf 'systemctl %s\\n' "$*" >> "$FAKE_STATE/commands.log"
action=$1; service=$2
case "$action" in
  is-enabled) value=$(cat "$FAKE_STATE/$service.enabled" 2>/dev/null || printf no); printf '%s\\n' "$value"; test "$value" = yes ;;
  is-active) value=$(cat "$FAKE_STATE/$service.active" 2>/dev/null || printf no); printf '%s\\n' "$value"; test "$value" = yes ;;
  enable|unmask) printf yes > "$FAKE_STATE/$service.enabled" ;;
  disable) printf no > "$FAKE_STATE/$service.enabled" ;;
  mask) printf masked > "$FAKE_STATE/$service.enabled" ;;
  restart|start) printf yes > "$FAKE_STATE/$service.active" ;;
  stop) printf no > "$FAKE_STATE/$service.active" ;;
  *) exit 2 ;;
esac
`);
  await executable(join(bin, "tailscale"), `#!/bin/sh
set -eu
printf 'tailscale %s\\n' "$*" >> "$FAKE_STATE/commands.log"
if [ "$1 $2" = "debug prefs" ]; then
  if [ -n "\${FAKE_TAILSCALE_DELAY:-}" ]; then sleep "$FAKE_TAILSCALE_DELAY"; fi
  cat "$FAKE_STATE/prefs.json"
elif [ "$1" = set ]; then :
elif [ "$1 $2 \${3:-}" = "serve status --json" ]; then cat "$FAKE_STATE/serve.json"
elif [ "$1 $2" = "serve reset" ]; then printf '{}\\n' > "$FAKE_STATE/serve.json"
elif [ "$1 $2" = "serve set-raw" ]; then cat > "$FAKE_STATE/serve.json"
else exit 2
fi
`);
  await executable(join(bin, "curl"), `#!/bin/sh
set -eu
count_file="$FAKE_STATE/curl.count"
count=$(cat "$count_file" 2>/dev/null || printf 0); count=$((count + 1)); printf '%s' "$count" > "$count_file"
printf 'curl %s\\n' "$*" >> "$FAKE_STATE/commands.log"
if [ -n "\${FAKE_CURL_FAIL_AT:-}" ] && [ "$count" -eq "$FAKE_CURL_FAIL_AT" ] && [ ! -e "$FAKE_STATE/curl.failed" ]; then
  : > "$FAKE_STATE/curl.failed"; exit 22
fi
`);
  await executable(join(bin, "haproxy"), `#!/bin/sh
set -eu
printf 'haproxy %s\\n' "$*" >> "$FAKE_STATE/commands.log"
test "$1" = -c; test "$2" = -f; test -s "$3"
! grep -Eiq '(ssl[[:space:]]+crt|crt-list|private.?key|\\.pem)' "$3"
`);
  for (const command of ["nginx", "apache2ctl", "caddy"]) {
    await executable(join(bin, command), `#!/bin/sh
set -eu
printf '${command} %s\\n' "$*" >> "$FAKE_STATE/commands.log"
`);
  }

  let configPath, original;
  if (variant === "nginx") {
    configPath = join(root, "etc/nginx/sites-enabled/site.conf");
    original = `server {
  listen 203.0.113.10:80;
  listen [::]:80;
  listen 203.0.113.10:443 ssl;
  listen [::]:443 ssl;
  server_name site.example.invalid;
}\n`;
  } else if (variant === "apache") {
    const ports = join(root, "etc/apache2/ports.conf");
    configPath = join(root, "etc/apache2/sites-enabled/site.conf");
    await mkdir(dirname(ports), { recursive: true });
    await writeFile(ports, "Listen 203.0.113.10:80\nListen 203.0.113.10:443\n");
    original = `<VirtualHost 203.0.113.10:80>\n</VirtualHost>\n<VirtualHost 203.0.113.10:443>\n</VirtualHost>\n`;
  } else if (variant === "caddy") {
    configPath = join(root, "etc/caddy/Caddyfile");
    original = `# Existing website settings\n{\n\temail admin@example.invalid\n}\n\nsite.example.invalid {\n  respond "site"\n}\n`;
  }
  if (configPath) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, original);
  }
  return {
    directory, root, bin, state, configPath,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_STATE: state,
      FRONT_DOOR_ALLOW_TEST_ROOT: "1",
    },
    args: ["--test-root", root, "--variant", variant, ...baseArgs,
      ...(variant === "nothing" ? [] : ["--website-host", "site.example.invalid"])],
  };
}

async function treeSnapshot(root) {
  const result = new Map();
  async function visit(directory, relative = "") {
    let entries;
    try { entries = await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const childRelative = join(relative, entry.name);
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else result.set(childRelative, await readFile(child, "utf8"));
    }
  }
  await visit(root);
  return result;
}

test("rendered HAProxy is TCP SNI passthrough with bounded Control Room connections", async () => {
  const result = await run(setupScript, ["--render-haproxy", ...baseArgs, "--allow-source", "192.0.2.0/24"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /frontend public_tls\n  bind :443\n  mode tcp/u);
  assert.match(result.stdout, /acl control_room_sni req\.ssl_sni -i front\.example\.invalid/u);
  assert.match(result.stdout, /stick-table type ip .*conn_cur,conn_rate\(1m\)/u);
  assert.match(result.stdout, /sc0_conn_cur gt 20 \}/u);
  assert.match(result.stdout, /sc0_conn_rate gt 60 \}/u);
  assert.match(result.stdout, /server control_room_mac 100\.100\.100\.100:9443 send-proxy-v2/u);
  assert.match(result.stdout, /default_backend owner_websites_tls/u);
  assert.match(result.stdout, /control_room_source_allowed src 192\.0\.2\.0\/24/u);
  assert.match(result.stdout, /tcp-request content reject if control_room_sni !control_room_source_allowed/u);
  assert.doesNotMatch(result.stdout, /ssl\s+crt|crt-list|private.?key|\.pem/iu);
  assert.doesNotMatch(result.stdout, /bind[^\n]*:9443/u);

  if (process.platform === "linux") {
    const probe = await run("sh", ["-c", "command -v haproxy"]);
    if (probe.code === 0) {
      const directory = await mkdtemp(join(tmpdir(), "front-door-haproxy-"));
      try {
        const config = join(directory, "haproxy.cfg");
        await writeFile(config, result.stdout);
        const validation = await run("haproxy", ["-c", "-f", config]);
        assert.equal(validation.code, 0, validation.stderr);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
});

const transformedGoldens = {
  nginx: `server {
  listen 127.0.0.1:8080;
  # front-door disabled IPv6: listen [::]:80;
  listen 127.0.0.1:8443 ssl;
  # front-door disabled IPv6: listen [::]:443 ssl;
  server_name site.example.invalid;
}\n`,
  apache: `<VirtualHost 127.0.0.1:8080>\n</VirtualHost>\n<VirtualHost 127.0.0.1:8443>\n</VirtualHost>\n`,
  caddy: `# Existing website settings\n{\n\thttp_port 8080\n\thttps_port 8443\n\tdefault_bind 127.0.0.1\n\temail admin@example.invalid\n}\n\nsite.example.invalid {\n  respond "site"\n}\n`,
};

for (const variant of ["nginx", "apache", "caddy", "nothing"]) {
  test(`${variant} golden, idempotency, explicit Serve reset, and exact remove round trip`, async () => {
    const harness = await createHarness(variant);
    try {
      const before = await treeSnapshot(join(harness.root, "etc"));
      const originalServe = await readFile(join(harness.state, "serve.json"), "utf8");
      const first = await run(setupScript, [...harness.args, "--disable-old-serve"], { env: harness.env });
      assert.equal(first.code, 0, first.stderr);
      assert.equal(first.stdout, "front door: ready\n");
      if (harness.configPath) assert.equal(await readFile(harness.configPath, "utf8"), transformedGoldens[variant]);
      const config = await readFile(join(harness.root, "etc/haproxy/haproxy.cfg"), "utf8");
      assert.doesNotMatch(config, /ssl\s+crt|crt-list|private.?key|\.pem/iu);
      assert.equal(await readFile(join(harness.state, "serve.json"), "utf8"), "{}\n");

      const logBefore = await readFile(join(harness.state, "commands.log"), "utf8");
      const second = await run(setupScript, [...harness.args, "--disable-old-serve"], { env: harness.env });
      assert.equal(second.code, 0, second.stderr);
      assert.equal(second.stdout, "front door: already configured\n");
      const newCommands = (await readFile(join(harness.state, "commands.log"), "utf8")).slice(logBefore.length);
      if (variant === "nothing") assert.equal(newCommands, "");
      else assert.match(newCommands, /^curl /u);
      assert.doesNotMatch(newCommands, /systemctl|tailscale|haproxy/u);

      const removed = await run(setupScript, ["--test-root", harness.root, "--remove"], { env: harness.env });
      assert.equal(removed.code, 0, removed.stderr);
      assert.equal(removed.stdout, "front door: removed\n");
      assert.deepEqual(await treeSnapshot(join(harness.root, "etc")), before);
      assert.equal(await readFile(join(harness.state, "serve.json"), "utf8"), originalServe);
      const allCommands = await readFile(join(harness.state, "commands.log"), "utf8");
      assert.match(allCommands, /tailscale set --shields-up=true --accept-routes=false --accept-dns=false --ssh=false --advertise-exit-node=false --advertise-routes=/u);
      assert.match(allCommands, /tailscale set --shields-up=false --accept-routes=true --accept-dns=true --ssh=true --advertise-exit-node=true --advertise-routes=192\.0\.2\.0\/24/u);
      assert.equal(await readFile(join(harness.state, "haproxy.enabled"), "utf8"), "no");
      assert.equal(await readFile(join(harness.state, "haproxy.active"), "utf8"), "no");
    } finally { await rm(harness.directory, { recursive: true, force: true }); }
  });
}

test("Serve is untouched unless the explicit flag is present", async () => {
  const harness = await createHarness("nothing");
  try {
    const before = await readFile(join(harness.state, "serve.json"), "utf8");
    const installed = await run(setupScript, harness.args, { env: harness.env });
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(await readFile(join(harness.state, "serve.json"), "utf8"), before);
    const commands = await readFile(join(harness.state, "commands.log"), "utf8");
    assert.doesNotMatch(commands, /tailscale serve/u);
  } finally { await rm(harness.directory, { recursive: true, force: true }); }
});

test("failed post-change probe rolls back, and a retry succeeds", async () => {
  const harness = await createHarness("nginx");
  try {
    const original = await readFile(harness.configPath, "utf8");
    const failed = await run(setupScript, harness.args, { env: { ...harness.env, FAKE_CURL_FAIL_AT: "3" } });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /restoring the previous state/u);
    assert.equal(await readFile(harness.configPath, "utf8"), original);
    assert.equal(await readFile(join(harness.root, "etc/haproxy/haproxy.cfg"), "utf8"), "# original HAProxy configuration\n");

    await writeFile(join(harness.state, "curl.count"), "0");
    const retried = await run(setupScript, harness.args, { env: harness.env });
    assert.equal(retried.code, 0, retried.stderr);
  } finally { await rm(harness.directory, { recursive: true, force: true }); }
});

test("failed remove probe restores the installed front door, then remove can retry", async () => {
  const harness = await createHarness("apache");
  try {
    const installed = await run(setupScript, harness.args, { env: harness.env });
    assert.equal(installed.code, 0, installed.stderr);
    const installedWebsite = await readFile(harness.configPath, "utf8");
    const installedProxy = await readFile(join(harness.root, "etc/haproxy/haproxy.cfg"), "utf8");
    await writeFile(join(harness.state, "curl.count"), "0");
    await rm(join(harness.state, "curl.failed"), { force: true });

    const failed = await run(setupScript, ["--test-root", harness.root, "--remove"], {
      env: { ...harness.env, FAKE_CURL_FAIL_AT: "2" },
    });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /restoring the previous state/u);
    assert.equal(await readFile(harness.configPath, "utf8"), installedWebsite);
    assert.equal(await readFile(join(harness.root, "etc/haproxy/haproxy.cfg"), "utf8"), installedProxy);
    assert.equal(await readFile(join(harness.state, "haproxy.active"), "utf8"), "yes");

    await writeFile(join(harness.state, "curl.count"), "0");
    const retried = await run(setupScript, ["--test-root", harness.root, "--remove"], { env: harness.env });
    assert.equal(retried.code, 0, retried.stderr);
  } finally { await rm(harness.directory, { recursive: true, force: true }); }
});

test("termination halfway restores the original website configuration", async () => {
  const harness = await createHarness("caddy");
  try {
    const original = await readFile(harness.configPath, "utf8");
    const stopped = await run(setupScript, harness.args, {
      env: { ...harness.env, FRONT_DOOR_TEST_STOP_AFTER_WEBSITE: "1" },
    });
    assert.notEqual(stopped.code, 0);
    assert.equal(await readFile(harness.configPath, "utf8"), original);
  } finally { await rm(harness.directory, { recursive: true, force: true }); }
});

test("twenty concurrent callers serialize without corrupting state", async () => {
  const harness = await createHarness("nothing");
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => run(setupScript, harness.args, { env: harness.env })));
    assert.ok(results.some(result => result.code === 0 && /front door: ready/u.test(result.stdout)));
    for (const result of results) {
      assert.ok(result.code === 0 || /another front-door operation is running/u.test(result.stderr), result.stderr);
    }
    const config = await readFile(join(harness.root, "etc/haproxy/haproxy.cfg"), "utf8");
    assert.match(config, /send-proxy-v2/u);
  } finally { await rm(harness.directory, { recursive: true, force: true }); }
});

test("a second caller is refused while the installation lock is held", async () => {
  const harness = await createHarness("nothing");
  try {
    const firstPromise = run(setupScript, harness.args, {
      env: { ...harness.env, FAKE_TAILSCALE_DELAY: "2" },
      timeout: 10_000,
    });
    let observed = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const log = await readFile(join(harness.state, "commands.log"), "utf8");
      if (/tailscale debug prefs/u.test(log)) { observed = true; break; }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
    }
    assert.equal(observed, true, "first caller did not reach the held transaction");
    const second = await run(setupScript, harness.args, { env: harness.env });
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /another front-door operation is running/u);
    const first = await firstPromise;
    assert.equal(first.code, 0, first.stderr);
  } finally { await rm(harness.directory, { recursive: true, force: true }); }
});

test("hostile host, target, CIDR, and policy arguments are refused without shell effects", async () => {
  const marker = join(tmpdir(), `front-door-marker-${process.pid}`);
  await rm(marker, { force: true });
  const hostileHosts = ["two words.invalid", "bad\nname.invalid", `x.invalid;touch ${marker}`, "$(false).invalid"];
  for (const host of hostileHosts) {
    const result = await run(setupScript, ["--render-haproxy", "--host", host, "--tailnet-target", "100.100.100.100", "--port", "9443"]);
    assert.notEqual(result.code, 0, host);
  }
  for (const target of ["203.0.113.4", "100.63.0.1", "100.128.0.1", "100.100.100.100;id"]) {
    const result = await run(setupScript, ["--render-haproxy", "--host", "front.example.invalid", "--tailnet-target", target, "--port", "9443"]);
    assert.notEqual(result.code, 0, target);
  }
  const cidr = await run(setupScript, ["--render-haproxy", ...baseArgs, "--allow-source", "192.0.2.0/24;id"]);
  assert.notEqual(cidr.code, 0);
  const policy = await run(process.execPath, [policyScript, "--front-door-port", "9443;id", "--web-port", "3210", "--gateway-port", "8444"]);
  assert.notEqual(policy.code, 0);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("dry-run lists changes and writes nothing", async () => {
  const harness = await createHarness("apache");
  try {
    const before = await treeSnapshot(harness.root);
    const result = await run(setupScript, [...harness.args, "--disable-old-serve", "--dry-run"], { env: harness.env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /would move apache website listeners/u);
    assert.match(result.stdout, /would save and reset the existing Tailscale Serve configuration/u);
    assert.deepEqual(await treeSnapshot(harness.root), before);
  } finally { await rm(harness.directory, { recursive: true, force: true }); }
});

test("Apache ports.conf and Caddyfile escapes are refused on apply without changes", async () => {
  for (const variant of ["apache", "caddy"]) {
    const harness = await createHarness(variant);
    try {
      const config = variant === "apache"
        ? join(harness.root, "etc/apache2/ports.conf")
        : join(harness.root, "etc/caddy/Caddyfile");
      const outside = join(harness.directory, `outside-${variant}.conf`);
      await writeFile(outside, `outside ${variant}\n`);
      await rm(config);
      await symlink(outside, config);
      const before = await treeSnapshot(harness.root);

      const result = await run(setupScript, harness.args, { env: harness.env });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /(?:Apache ports\.conf|Caddyfile) escapes the selected root/u);
      assert.equal(await readlink(config), outside);
      assert.equal(await readFile(outside, "utf8"), `outside ${variant}\n`);
      assert.deepEqual(await treeSnapshot(harness.root), before);
    } finally { await rm(harness.directory, { recursive: true, force: true }); }
  }
});

test("Apache ports.conf and Caddyfile escapes are refused on remove without changes", async () => {
  for (const variant of ["apache", "caddy"]) {
    const harness = await createHarness(variant);
    try {
      const installed = await run(setupScript, harness.args, { env: harness.env });
      assert.equal(installed.code, 0, installed.stderr);
      const config = variant === "apache"
        ? join(harness.root, "etc/apache2/ports.conf")
        : join(harness.root, "etc/caddy/Caddyfile");
      const outside = join(harness.directory, `outside-remove-${variant}.conf`);
      await writeFile(outside, `outside ${variant}\n`);
      await rm(config);
      await symlink(outside, config);
      const before = await treeSnapshot(harness.root);

      const result = await run(setupScript, ["--test-root", harness.root, "--remove"], { env: harness.env });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /(?:Apache ports\.conf|Caddyfile) escapes the selected root/u);
      assert.equal(await readlink(config), outside);
      assert.equal(await readFile(outside, "utf8"), `outside ${variant}\n`);
      assert.deepEqual(await treeSnapshot(harness.root), before);
    } finally { await rm(harness.directory, { recursive: true, force: true }); }
  }
});

test("apply, dry-run, idempotency, and remove all run with nounset enabled", async () => {
  const harness = await createHarness("nothing");
  try {
    assert.match(await readFile(setupScript, "utf8"), /^set -euo pipefail$/mu);
    const dryRun = await run(setupScript, [...harness.args, "--dry-run"], { env: harness.env });
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const applied = await run(setupScript, harness.args, { env: harness.env });
    assert.equal(applied.code, 0, applied.stderr);
    const idempotent = await run(setupScript, harness.args, { env: harness.env });
    assert.equal(idempotent.code, 0, idempotent.stderr);
    const removed = await run(setupScript, ["--test-root", harness.root, "--remove"], { env: harness.env });
    assert.equal(removed.code, 0, removed.stderr);
  } finally { await rm(harness.directory, { recursive: true, force: true }); }
});

test("missing website inputs and changed idempotent arguments fail closed", async () => {
  const missingHost = await createHarness("nginx");
  try {
    const args = missingHost.args.filter((_, index, all) => all[index - 1] !== "--website-host" && all[index] !== "--website-host");
    const result = await run(setupScript, args, { env: missingHost.env });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /at least one --website-host/u);
  } finally { await rm(missingHost.directory, { recursive: true, force: true }); }

  const missingConfig = await createHarness("nginx");
  try {
    await rm(join(missingConfig.root, "etc/nginx"), { recursive: true, force: true });
    const result = await run(setupScript, missingConfig.args, { env: missingConfig.env });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no nginx website configuration/u);
  } finally { await rm(missingConfig.directory, { recursive: true, force: true }); }

  const changed = await createHarness("nothing");
  try {
    const installed = await run(setupScript, changed.args, { env: changed.env });
    assert.equal(installed.code, 0, installed.stderr);
    const result = await run(setupScript, changed.args.flatMap(value => value === "9443" ? ["9444"] : [value]), { env: changed.env });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /different front-door installation/u);
  } finally { await rm(changed.directory, { recursive: true, force: true }); }
});

test("policy generator emits the minimal grant and fail-closed tests", async () => {
  const result = await run(process.execPath, [policyScript, "--front-door-port", "9443", "--web-port", "3210", "--gateway-port", "8444"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"src": \["tag:control-room-vps"\].*"ip": \["tcp:9443"\]/u);
  assert.match(result.stdout, /"accept": \["tag:control-room-client:9443"\]/u);
  assert.match(result.stdout, /"tagOwners"[\s\S]*"tag:control-room-vps": \["autogroup:admin"\]/u);
  for (const denied of [":22", ":443", ":3210", ":8444", ":5432", "tag:general:22"]) {
    assert.match(result.stdout, new RegExp(denied.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(result.stdout, /"sshTests"/u);
  const allowClient443 = await run(process.execPath, [policyScript, "--front-door-port", "9443", "--web-port", "3210", "--gateway-port", "8444", "--allow-client-443"]);
  assert.equal(allowClient443.code, 0, allowClient443.stderr);
  assert.match(allowClient443.stdout, /"ip": \["tcp:443"\]/u);
  const collision = await run(process.execPath, [policyScript, "--front-door-port", "443", "--web-port", "3210", "--gateway-port", "8444"]);
  assert.notEqual(collision.code, 0);
  assert.match(collision.stderr, /must not collide/u);
});
