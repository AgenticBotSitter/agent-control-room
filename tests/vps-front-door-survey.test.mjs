import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const survey = join(repositoryRoot, "deploy/front-door/vps-survey.sh");

function executable(directory, name, source) {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${source}\n`);
  chmodSync(path, 0o755);
}

function runSurvey({ server = "none", listeners = "", serve = false, secret = false } = {}, environment = process.env) {
  const root = mkdtempSync(join(tmpdir(), "vps-survey-test-"));
  try {
    // Only portable text utilities reach the survey; host-installed web servers
    // must not change which fixture variant is being exercised.
    for (const name of ["awk", "sort", "paste", "grep", "tr"]) {
      const source = ["/usr/bin", "/bin"].map(directory => join(directory, name)).find(existsSync);
      assert.ok(source, `required text utility is available: ${name}`);
      symlinkSync(source, join(root, name));
    }
    executable(root, "ss", `printf '%s\\n' '${listeners}'`);
    executable(root, "tailscale", `
case "$1 $2" in
  version*) printf '%s\\n' '1.82.0' ;;
  'debug prefs') printf '%s\\n' '"ShieldsUp": true' '"AcceptRoutes": false' ${secret ? "'API_KEY=survey-test-secret'" : ""} ;;
  'serve status') ${serve ? "printf '%s\\n' '{\"TCP\": {\"443\": {}}}'" : "printf '%s\\n' '{}'"} ;;
esac`);
    executable(root, "ufw", "printf '%s\\n' 'Status: active' '80/tcp ALLOW Anywhere' '443/tcp ALLOW Anywhere'");
    executable(root, "df", "printf '%s\\n' 'Filesystem 1K-blocks Used Available Use% Mounted on' '/dev/test 1000 100 900 10% /'");
    executable(root, "free", "printf '%s\\n' '               total        used        free      shared  buff/cache   available' 'Mem:          1000         100         100          10         800         900'");
    if (server === "nginx") executable(root, "nginx", "printf '%s\\n' 'nginx version: nginx/1.24.0'");
    if (server === "apache") executable(root, "apache2ctl", "printf '%s\\n' 'Server version: Apache/2.4.58'");
    if (server === "caddy") executable(root, "caddy", "printf '%s\\n' 'v2.8.4'");
    const result = spawnSync("/bin/sh", [survey], {
      encoding: "utf8",
      env: { ...environment, PATH: root },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("survey reports nginx on public IPv4 HTTPS and recommends its FD-7 variant", () => {
  const output = runSurvey({ server: "nginx", listeners: "LISTEN 0 511 0.0.0.0:443 0.0.0.0:*", serve: true });
  assert.match(output, /web_servers=nginx/u);
  assert.match(output, /listeners_443=0\.0\.0\.0:443/u);
  assert.match(output, /serve=configured/u);
  assert.match(output, /fd7_variant=nginx: move existing HTTPS website listener to loopback/u);
});

test("survey distinguishes Apache and IPv6", () => {
  const output = runSurvey({ server: "apache", listeners: "LISTEN 0 511 [::]:443 [::]:*" });
  assert.match(output, /web_servers=apache/u);
  assert.match(output, /listeners_443=\[::\]:443/u);
  assert.match(output, /ipv6_present=yes/u);
  assert.match(output, /fd7_variant=apache: move existing HTTPS website listener to loopback/u);
});

test("survey recommends the Caddy variant", () => {
  const output = runSurvey({ server: "caddy", listeners: "LISTEN 0 511 127.0.0.1:80 0.0.0.0:*" });
  assert.match(output, /web_servers=caddy/u);
  assert.match(output, /fd7_variant=caddy: move existing HTTPS website listener to loopback/u);
});

test("survey recommends a clean HAProxy listener when nothing is listening", () => {
  const output = runSurvey();
  assert.match(output, /web_servers=none found/u);
  assert.match(output, /listeners_80=none/u);
  assert.match(output, /listeners_443=none/u);
  assert.match(output, /fd7_variant=no existing public HTTPS listener: install HAProxy/u);
});

test("survey never prints a key-shaped value from a command response", () => {
  const output = runSurvey({ secret: true });
  assert.doesNotMatch(output, /API_KEY=survey-test-secret/u);
  assert.match(output, /ShieldsUp/u);
});

test("survey has no write or service-changing command", () => {
  const source = readFileSync(survey, "utf8");
  assert.doesNotMatch(source, />/u);
  assert.doesNotMatch(source, /\btee\b|sed -i|systemctl\s+(?:start|stop|restart)|tailscale\s+(?:set|up|serve\s+reset|funnel)/u);
  assert.doesNotMatch(source, /\brm\b/u);
});

test("survey fixtures exclude web servers from an inherited host PATH", () => {
  const host = mkdtempSync(join(tmpdir(), "vps-survey-host-"));
  try {
    for (const name of ["nginx", "apache2ctl", "haproxy", "caddy"])
      executable(host, name, "exit 97");
    const output = runSurvey({}, { ...process.env, PATH: `${host}:${process.env.PATH}` });
    assert.match(output, /web_servers=none found/u);
    assert.match(output, /fd7_variant=no existing public HTTPS listener: install HAProxy/u);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});
