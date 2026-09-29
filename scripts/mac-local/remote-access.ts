import { execFileSync } from "node:child_process";
import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadMacLocalProtectedConfigurationFromRootV1 } from "../../src/web/v1/mac-local-protected-loader";
import type { MacLocalProtectedConfigurationV1 } from "../../src/web/v1/mac-local-protected-configuration";

/**
 * Owner setup helper for reaching the Mac-local website from a phone
 * (Tailscale Serve) or from the owner's other computers (Cloudflare Tunnel +
 * Access). It never runs `tailscale` or `cloudflared` and never installs
 * anything: it prints the exact commands, writes the one cloudflared config
 * file into the protected root, and checks what is on disk.
 *
 *   plan               print the owner steps for the configured paths
 *   write-cloudflared  write <root>/config/cloudflared.yml (mode 0600)
 *   check              dry-run check of configuration, files and the repo
 */
type Command = "plan" | "write-cloudflared" | "check";
export type RemoteAccessArguments = Readonly<{ command: Command; protectedRoot: string; tunnelId?: string;
  credentialsFile?: string; repository?: string }>;

const safePath = (value: string | undefined) => typeof value === "string" && isAbsolute(value) && resolve(value) === value
  && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function parseRemoteAccessArguments(args: readonly string[]): RemoteAccessArguments | { help: true } {
  if (args.length === 0 || args.includes("--help")) return { help: true };
  const [command, ...rest] = args;
  if (command !== "plan" && command !== "write-cloudflared" && command !== "check") throw new Error("remote_access_arguments_invalid");
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index], value = rest[index + 1];
    if (!name || value === undefined || !["--protected-root", "--tunnel-id", "--credentials-file", "--repository"].includes(name)
      || values.has(name)) throw new Error("remote_access_arguments_invalid");
    values.set(name, value);
  }
  const protectedRoot = values.get("--protected-root");
  if (!safePath(protectedRoot)) throw new Error("remote_access_arguments_invalid");
  if (command === "write-cloudflared" && (!uuid.test(values.get("--tunnel-id") ?? "") || !safePath(values.get("--credentials-file"))))
    throw new Error("remote_access_arguments_invalid");
  if (command !== "write-cloudflared" && (values.has("--tunnel-id") || values.has("--credentials-file")))
    throw new Error("remote_access_arguments_invalid");
  if (values.has("--repository") && (command !== "check" || !safePath(values.get("--repository"))))
    throw new Error("remote_access_arguments_invalid");
  return Object.freeze({ command, protectedRoot: protectedRoot!,
    ...(values.has("--tunnel-id") ? { tunnelId: values.get("--tunnel-id")! } : {}),
    ...(values.has("--credentials-file") ? { credentialsFile: values.get("--credentials-file")! } : {}),
    ...(values.has("--repository") ? { repository: values.get("--repository")! } : {}) });
}

const loopbackService = (configuration: MacLocalProtectedConfigurationV1) => `http://127.0.0.1:${configuration.port}`;

/** The complete cloudflared configuration. One hostname, one loopback
 * service, cloudflared's own Access check on top of Control Room's, and a
 * final 404 rule so no other hostname reaches the Mac. */
export function renderCloudflaredConfig(configuration: MacLocalProtectedConfigurationV1, tunnelId: string, credentialsFile: string): string {
  const cloudflare = configuration.remoteAccess?.cloudflare;
  if (!cloudflare || !uuid.test(tunnelId) || !safePath(credentialsFile)) throw new Error("remote_access_cloudflare_not_configured");
  const hostname = new URL(cloudflare.origin).hostname;
  const teamName = new URL(cloudflare.teamDomain).hostname.split(".")[0]!;
  return [
    "# Written by `pnpm mac:remote-access write-cloudflared`. Private: keep this file out of any repository.",
    "# cloudflared only dials out to Cloudflare. Nothing on this Mac listens on a public address.",
    `tunnel: ${tunnelId}`,
    `credentials-file: ${JSON.stringify(credentialsFile)}`,
    "no-autoupdate: true",
    "ingress:",
    `  - hostname: ${hostname}`,
    `    service: ${loopbackService(configuration)}`,
    "    originRequest:",
    `      httpHostHeader: ${hostname}`,
    "      access:",
    "        required: true",
    `        teamName: ${teamName}`,
    "        audTag:",
    `          - ${cloudflare.audience}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

export function remoteAccessPlan(configuration: MacLocalProtectedConfigurationV1, protectedRoot: string): string[] {
  const access = configuration.remoteAccess;
  const lines: string[] = [];
  if (!access) return ["Remote access is off. Control Room answers only on this Mac at "
    + `${configuration.localOwnerSession.origin}. Add a "remoteAccess" block to config/mac-local.json to turn a path on.`];
  if (access.tailscale) {
    lines.push("PHONE (Tailscale Serve, private to your tailnet)",
      `  1. tailscale serve --bg --https=443 ${loopbackService(configuration)}`,
      "  2. tailscale serve status",
      `     It must show ${access.tailscale.origin} proxying to ${loopbackService(configuration)}.`,
      "  Never run `tailscale funnel`: Funnel would publish the address to the internet.",
      `  Then open ${access.tailscale.origin} on the phone and sign in with your owner code.`,
      "  Turn it off: tailscale serve --https=443 off", "");
  }
  if (access.cloudflare) {
    const hostname = new URL(access.cloudflare.origin).hostname;
    lines.push("OTHER COMPUTERS (Cloudflare Tunnel + Access)",
      "  Access application (Zero Trust dashboard, once): self-hosted app for exactly",
      `  ${hostname}; one Allow policy whose only rule is Emails = ${access.cloudflare.ownerEmail};`,
      "  login method with authenticator-app MFA; session duration 24 hours.",
      "  Copy the Application Audience (AUD) tag into remoteAccess.cloudflare.audience.",
      "  1. cloudflared tunnel login",
      "  2. cloudflared tunnel create control-room",
      `  3. pnpm mac:remote-access write-cloudflared --protected-root ${protectedRoot} --tunnel-id <TUNNEL-ID> --credentials-file <PATH-TO-TUNNEL-ID.json>`,
      `  4. cloudflared tunnel route dns control-room ${hostname}`,
      `  5. pnpm mac:remote-access check --protected-root ${protectedRoot}`,
      `  6. cloudflared tunnel --config ${join(protectedRoot, "config", "cloudflared.yml")} run control-room`,
      `  Then open ${access.cloudflare.origin} on the other computer: Cloudflare login + MFA, then your owner code.`,
      "  Sign out: the Sign out link in Control Room ends both sessions.", "");
  }
  return lines;
}

type CheckRuntime = Readonly<{
  lstat: typeof lstat; readFile: typeof readFile;
  trackedFiles(repository: string): string[];
}>;
const production: CheckRuntime = Object.freeze({ lstat, readFile,
  trackedFiles: (repository: string) => execFileSync("git", ["-C", repository, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0").filter(Boolean) });

/** Dry-run check. It reads files only; it never starts a proxy or tunnel. */
export async function checkRemoteAccess(configuration: MacLocalProtectedConfigurationV1, protectedRoot: string,
  repository: string | undefined, runtime: CheckRuntime = production): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const pass = (line: string) => lines.push(`PASS  ${line}`);
  const fail = (line: string) => { ok = false; lines.push(`FAIL  ${line}`); };
  const access = configuration.remoteAccess;
  pass(`the website binds only to ${configuration.localOwnerSession.origin}`);
  if (!access) { pass("no remote path is configured; only this Mac can open Control Room"); return { ok, lines }; }
  if (access.tailscale) pass(`Tailscale origin ${access.tailscale.origin} is a tailnet (.ts.net) address`
    + (access.tailscale.ownerLogin ? " and requires your tailnet login" : ""));
  if (access.cloudflare) {
    pass("Cloudflare Access tokens are verified against the team keys, AUD tag, issuer, time and owner email");
    const path = join(protectedRoot, "config", "cloudflared.yml");
    try {
      const entry = await runtime.lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error("mode");
      const text = await runtime.readFile(path, "utf8");
      const tunnel = /^tunnel: (\S+)$/mu.exec(text)?.[1] ?? "";
      const credentials = /^credentials-file: (".*")$/mu.exec(text)?.[1];
      const credentialsFile = credentials ? JSON.parse(credentials) as string : "";
      if (text !== renderCloudflaredConfig(configuration, tunnel, credentialsFile)) throw new Error("content");
      pass("cloudflared.yml has one hostname, a loopback service, cloudflared's Access check and a final 404 rule");
      const secret = await runtime.lstat(credentialsFile);
      if (!secret.isFile() || (secret.mode & 0o077) !== 0) fail("the tunnel credentials file must be readable only by you (chmod 600)");
      else pass("the tunnel credentials file is private");
      if (repository && resolve(credentialsFile).startsWith(`${resolve(repository)}/`))
        fail("the tunnel credentials file is inside the repository; move it to the protected root");
    } catch (error) {
      fail(error instanceof Error && error.message === "mode" ? "cloudflared.yml must be a private file (chmod 600)"
        : "cloudflared.yml is missing or was edited; run write-cloudflared again");
    }
  }
  if (repository) {
    const needles = [access.tailscale?.origin, access.cloudflare?.origin, access.cloudflare?.audience,
      access.cloudflare?.teamDomain].filter((value): value is string => !!value).map(value => value.replace(/^https:\/\//u, ""));
    const leaks: string[] = [];
    for (const file of runtime.trackedFiles(repository)) {
      let text: string;
      try { text = await runtime.readFile(join(repository, file), "utf8"); } catch { continue; }
      if (needles.some(needle => text.includes(needle))) leaks.push(file);
    }
    if (leaks.length) fail(`private address details appear in tracked files: ${leaks.slice(0, 5).join(", ")}`);
    else pass("no tracked repository file (including the public site) names the private addresses");
  }
  return { ok, lines };
}

export async function writeCloudflaredConfig(configuration: MacLocalProtectedConfigurationV1, protectedRoot: string,
  tunnelId: string, credentialsFile: string): Promise<string> {
  const path = join(protectedRoot, "config", "cloudflared.yml"), temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, renderCloudflaredConfig(configuration, tunnelId, credentialsFile), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return path;
}

async function main() {
  const parsed = parseRemoteAccessArguments(process.argv.slice(2).filter(value => value !== "--"));
  if ("help" in parsed) {
    console.log("Usage: pnpm mac:remote-access plan|check --protected-root ABSOLUTE_PATH [--repository ABSOLUTE_PATH]\n"
      + "       pnpm mac:remote-access write-cloudflared --protected-root ABSOLUTE_PATH --tunnel-id UUID --credentials-file ABSOLUTE_PATH");
    return;
  }
  const configuration = await loadMacLocalProtectedConfigurationFromRootV1(parsed.protectedRoot);
  if (parsed.command === "plan") { console.log(remoteAccessPlan(configuration, parsed.protectedRoot).join("\n")); return; }
  if (parsed.command === "write-cloudflared") {
    console.log(`Wrote ${await writeCloudflaredConfig(configuration, parsed.protectedRoot, parsed.tunnelId!, parsed.credentialsFile!)}`);
    return;
  }
  const repository = parsed.repository ?? fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
  const result = await checkRemoteAccess(configuration, parsed.protectedRoot, repository);
  console.log(result.lines.join("\n"));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => { console.error(`mac-remote-access: ${error instanceof Error ? error.message : "failed"}`); process.exitCode = 1; });
}
