// Renders the three supported scheduler definitions.
//
// These functions only produce text. Installing them is a separate, explicitly authorized
// action, so nothing in this module writes to a scheduler directory, and no generated
// artifact contains a credential: token use stays inherited from an owner-controlled
// environment, and the produced files carry a comment saying so.
import { join } from "node:path";

import { workerSlug } from "./runtime.mjs";

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// systemd treats "%" as a specifier and interprets quotes itself, so both must be escaped
// or a path such as "50% work" or "My Files" changes the command systemd runs.
export function systemdQuote(value) {
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%");
  return `"${escaped}"`;
}

export function windowCommandLine(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

export function iso8601Duration(seconds) {
  const total = Math.max(1, Math.round(seconds));
  if (total % 60 === 0) return `PT${total / 60}M`;
  return `PT${total}S`;
}

export function launchdLabel(workerId) {
  return `com.agent-control-room.worker-inbox.${workerSlug(workerId)}`;
}

export function systemdUnitBase(workerId) {
  return `agent-control-room-worker-inbox-${workerSlug(workerId)}`;
}

export function windowsTaskName(workerId) {
  return `AgentControlRoomWorkerInbox-${workerSlug(workerId)}`;
}

function watchArguments({ workerId, repository, runtimeDirectory, signalDirectory, tokenFromGh }) {
  const values = [
    "--once",
    "--worker-id", workerId,
    "--repository", repository,
    "--runtime-root", runtimeDirectory,
  ];
  if (signalDirectory) values.push("--signal-directory", signalDirectory);
  if (tokenFromGh) values.push("--token-from-gh");
  return values;
}

export function renderLaunchdPlist(options) {
  const {
    workerId, repository, nodePath, scriptPath, runtimeDirectory, workingDirectory,
    intervalSeconds = 300, standardOut, standardError,
  } = options;
  const arguments_ = [nodePath, scriptPath, ...watchArguments(options)];
  const lines = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(launchdLabel(workerId))}</string>`,
    "  <!-- No credentials are embedded. Authentication is inherited from the environment",
    "       the operator controls, or from `gh auth` when --token-from-gh was used. -->",
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...arguments_.map(value => `    <string>${xmlEscape(value)}</string>`),
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${Math.max(1, Math.round(intervalSeconds))}</integer>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(workingDirectory)}</string>`,
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(standardOut)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(standardError)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ];
  return lines.join("\n");
}

export function renderSystemdService(options) {
  const {
    workerId, repository, nodePath, scriptPath, runtimeDirectory, workingDirectory,
  } = options;
  const exec = [nodePath, scriptPath, ...watchArguments(options)].map(systemdQuote).join(" ");
  return [
    "[Unit]",
    `Description=Agent Control Room worker inbox watcher for ${workerSlug(workerId)}`,
    `Documentation=https://github.com/${repository}/blob/main/docs/contributors/worker-inbox/README.md`,
    "",
    "[Service]",
    "Type=oneshot",
    "# No credentials are embedded. The optional environment file is owned and populated by",
    "# the operator; the leading \"-\" means the service still runs when it is absent.",
    // systemd splits on unquoted whitespace for these settings too, so a runtime directory or
    // working directory containing a space must be quoted or the unit silently misparses.
    `EnvironmentFile=-${systemdQuote(join(runtimeDirectory, "env"))}`,
    `ExecStart=${exec}`,
    `WorkingDirectory=${systemdQuote(workingDirectory)}`,
    "Nice=10",
    "",
  ].join("\n");
}

export function renderSystemdTimer(options) {
  const { workerId, intervalSeconds = 300 } = options;
  const base = systemdUnitBase(workerId);
  return [
    "[Unit]",
    `Description=Run the Agent Control Room worker inbox watcher for ${workerSlug(workerId)} periodically`,
    "",
    "[Timer]",
    "OnBootSec=2min",
    `OnUnitActiveSec=${Math.max(1, Math.round(intervalSeconds))}s`,
    "AccuracySec=30s",
    "Persistent=false",
    `Unit=${base}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

export function renderWindowsTaskXml(options) {
  const {
    workerId, repository, nodePath, scriptPath, workingDirectory, intervalSeconds = 300,
    startBoundary = new Date().toISOString().replace(/\.\d{3}Z$/, ""),
  } = options;
  // Task Scheduler passes Command and Arguments straight to CreateProcess, so quoting is
  // well defined and no batch wrapper is needed. That keeps every generated artifact
  // declarative and locally checkable, instead of shipping a shell script this repository
  // cannot verify off Windows.
  const arguments_ = [scriptPath, ...watchArguments(options)].map(windowCommandLine).join(" ");
  const interval = iso8601Duration(intervalSeconds);
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
    "  <RegistrationInfo>",
    `    <Description>Agent Control Room worker inbox watcher for ${xmlEscape(workerId)} in ${xmlEscape(repository)}. Read-only; no credentials are embedded.</Description>`,
    `    <URI>\\${xmlEscape(windowsTaskName(workerId))}</URI>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <TimeTrigger>",
    `      <StartBoundary>${xmlEscape(startBoundary)}</StartBoundary>`,
    "      <Enabled>true</Enabled>",
    "      <Repetition>",
    `        <Interval>${interval}</Interval>`,
    "        <StopAtDurationEnd>false</StopAtDurationEnd>",
    "      </Repetition>",
    "    </TimeTrigger>",
    "  </Triggers>",
    "  <Principals>",
    "    <Principal id=\"Author\">",
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    "  <Actions Context=\"Author\">",
    "    <Exec>",
    `      <Command>${xmlEscape(nodePath)}</Command>`,
    `      <Arguments>${xmlEscape(arguments_)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
}

const REQUIRED_INPUTS = ["workerId", "repository", "nodePath", "scriptPath", "runtimeDirectory", "workingDirectory"];

// Fails with a named error rather than a bare TypeError when a caller passes the wrong
// option name. `runtimeRoot` and `runtimeDirectory` are easy to confuse, and a
// "Cannot read properties of undefined" here would be hard to place.
function assertInputs(platform, options, required) {
  for (const name of required) {
    if (typeof options[name] !== "string" || options[name] === "") {
      throw new Error(`worker_inbox_platform_artifact_input_missing:${platform}:${name}`);
    }
  }
}

export function artifactsFor({ platform, ...options }) {
  const { workerId } = options;
  if (!PLATFORMS.includes(platform)) throw new Error("worker_inbox_platform_platform_invalid");
  assertInputs(platform, options, REQUIRED_INPUTS);
  if (platform === "launchd") {
    return [{ name: `${launchdLabel(workerId)}.plist`, content: renderLaunchdPlist(options) }];
  }
  if (platform === "systemd") {
    const base = systemdUnitBase(workerId);
    return [
      { name: `${base}.service`, content: renderSystemdService(options) },
      { name: `${base}.timer`, content: renderSystemdTimer(options) },
    ];
  }
  if (platform === "windows") {
    return [{ name: `${windowsTaskName(workerId)}.xml`, content: renderWindowsTaskXml(options) }];
  }
  throw new Error("worker_inbox_platform_platform_invalid");
}

export const PLATFORMS = Object.freeze(["launchd", "systemd", "windows"]);
