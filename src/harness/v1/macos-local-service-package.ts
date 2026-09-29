import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

const safePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && normalize(value) === value
  && !/[\u0000-\u001f\u007f]/u.test(value));
const label = z.string().regex(/^xyz\.agentcontrolroom\.[a-z0-9-]+$/);
const xmlEscape = (value: string) => value.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);

export type MacosLocalServicePackageV1 = Readonly<{
  label: string;
  plist: string;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

/** Creates, but never installs or starts, the owner-reviewed LaunchAgent for
 * the local Control Room host. It deliberately has no shell, environment
 * secrets, task arguments, or retry policy of its own. */
export function createMacosLocalServicePackageV1(input: unknown): MacosLocalServicePackageV1 {
  const parsed = z.object({ label, nodePath: safePath, launcherPath: safePath, configurationPath: safePath,
    workingDirectory: safePath, standardOutPath: safePath, standardErrorPath: safePath }).strict().parse(input);
  const args = [parsed.nodePath, parsed.launcherPath, "--configuration", parsed.configurationPath];
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>Label</key>', `<string>${xmlEscape(parsed.label)}</string>`,
    '<key>ProgramArguments</key>', '<array>', ...args.map(value => `<string>${xmlEscape(value)}</string>`), '</array>',
    '<key>WorkingDirectory</key>', `<string>${xmlEscape(parsed.workingDirectory)}</string>`,
    '<key>RunAtLoad</key>', '<true/>',
    '<key>KeepAlive</key>', '<dict><key>SuccessfulExit</key><false/></dict>',
    '<key>ThrottleInterval</key>', '<integer>15</integer>',
    '<key>ProcessType</key>', '<string>Background</string>',
    '<key>Umask</key>', '<integer>63</integer>',
    '<key>StandardOutPath</key>', `<string>${xmlEscape(parsed.standardOutPath)}</string>`,
    '<key>StandardErrorPath</key>', `<string>${xmlEscape(parsed.standardErrorPath)}</string>`,
    '</dict></plist>',
  ].join("\n");
  return Object.freeze({ label: parsed.label, plist, startsWork: false, grantsExecutionAuthority: false });
}
