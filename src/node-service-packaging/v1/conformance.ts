import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ServicePackageConformanceResult {
  platform: "linux" | "macos" | "windows";
  file: string;
  checks: string[];
}

const forbidden = ["curl ", "wget ", "npm install", "pnpm install", "sudo ", "rm -rf", "0.0.0.0", "listen="];
const placeholders = ["{{CONTROL_ROOM_NODE_RUNTIME}}", "{{CONTROL_ROOM_NODE_RELEASE_DIR}}", "{{CONTROL_ROOM_NODE_CONFIG_PATH}}"];

function requireText(text: string, value: string, label: string, checks: string[]): void {
  if (!text.includes(value)) throw new Error(`${label} is missing`);
  checks.push(label);
}

function rejectForbidden(text: string): void {
  const matched = forbidden.find((value) => text.toLowerCase().includes(value));
  if (matched) throw new Error(`forbidden package content: ${matched}`);
}

async function readPackage(relativePath: string): Promise<string> {
  return readFile(resolve("packages/control-room-node-service", relativePath), "utf8");
}

export async function verifyServicePackages(): Promise<ServicePackageConformanceResult[]> {
  const linux = await readPackage("linux/control-room-node.service.template");
  const macos = await readPackage("macos/com.control-room.node.plist.template");
  const windows = await readPackage("windows/control-room-node-service.xml.template");
  const results: ServicePackageConformanceResult[] = [];
  for (const [platform, file, text] of [
    ["linux", "linux/control-room-node.service.template", linux],
    ["macos", "macos/com.control-room.node.plist.template", macos],
    ["windows", "windows/control-room-node-service.xml.template", windows],
  ] as const) {
    rejectForbidden(text);
    const checks: string[] = [];
    for (const placeholder of placeholders) requireText(text, placeholder, `placeholder ${placeholder}`, checks);
    results.push({ platform, file, checks });
  }
  requireText(linux, "NoNewPrivileges=true", "linux no-new-privileges", results[0].checks);
  requireText(linux, "KillMode=control-group", "linux process-group cancellation", results[0].checks);
  requireText(linux, "RestartSec=5", "linux bounded restart", results[0].checks);
  requireText(macos, "LimitLoadToSessionType", "macOS Aqua session guard", results[1].checks);
  requireText(macos, "<string>Aqua</string>", "macOS excludes LaunchDaemon context", results[1].checks);
  requireText(macos, "ThrottleInterval", "macOS bounded restart", results[1].checks);
  requireText(windows, "<id>control-room-node</id>", "windows stable identity", results[2].checks);
  requireText(windows, "<stoptimeout>30sec</stoptimeout>", "windows bounded stop", results[2].checks);
  await readPackage("windows/JOB_OBJECT_CANCELLATION.md");
  return results;
}
