// Start, inspect, stop, and uninstall instructions for each supported platform.
//
// These are printed or written as documentation. Nothing here installs, enables, or starts
// a scheduler: producing the instructions is the deliverable, and the operator performs any
// installation deliberately. Quoted forms are shown so paths containing spaces work as
// written.
import { launchdLabel, systemdUnitBase, windowsTaskName } from "./artifacts.mjs";

// The scheduler-PATH caveat, per platform. The failure is the same everywhere, but the fix is not:
// launchd reads no environment file, so on macOS the remedy is a PATH inside the property list,
// while the systemd unit already points EnvironmentFile= at the runtime env file. Windows Task
// Scheduler is omitted deliberately - it runs with the user's persistent environment.
const schedulerRemedies = {
  launchd: [
    "  Scheduler PATH: launchd does not inherit your shell environment, so --token-from-gh only",
    "  works if `gh` is on the PATH the tick runs with. If it is not, the tick fails loudly with",
    "  worker_inbox_platform_gh_token_unavailable and exit 1 - it does not fall back to anonymous",
    "  requests. Fix it by adding the directory holding `gh` (often /opt/homebrew/bin) to an",
    "  EnvironmentVariables PATH in the generated property list before bootstrapping it; launchd",
    "  reads no environment file. See the macOS page.",
  ],
  systemd: [
    "  Scheduler PATH: the service does not inherit your shell environment, so --token-from-gh only",
    "  works if `gh` is on the PATH the tick runs with. If it is not, the tick fails loudly with",
    "  worker_inbox_platform_gh_token_unavailable and exit 1 - it does not fall back to anonymous",
    "  requests. Fix it by putting GITHUB_TOKEN in the runtime env file the unit's EnvironmentFile=",
    "  reads, or by adding the directory holding `gh` to the unit's PATH. See the systemd page.",
  ],
};

export function instructionsFor({ platform, workerId, artifactDirectory, runtimeDirectory, repository, signalDirectory }) {
  // Uninstall removes the extra signal file only when the operator names its directory, so the
  // command printed here has to carry that flag when one was configured - otherwise an operator
  // following these instructions leaves the file behind and is never told why.
  const signalFlag = typeof signalDirectory === "string" && signalDirectory.trim()
    ? ` --signal-directory "${signalDirectory}"` : "";
  const uninstall = `node scripts/worker-inbox-platform/worker-inbox-uninstall.mjs --worker-id ${workerId}${signalFlag}`;
  const common = [
    "",
    "Read-only operation:",
    "  The watcher never writes a label, issue, comment, or pull request. It reads the public",
    "  inbox and writes only local files under the runtime directory.",
    "",
    "Honest limitation:",
    "  This cannot wake an idle agent. GitHub cannot wake a local process, so the signal is a",
    "  bounded local file plus one console line. Something already running must act on it.",
    "",
    "Credentials:",
    "  No token is generated, copied, printed, or stored by this tool. Set GITHUB_TOKEN in the",
    "  environment you control, or pass --token-from-gh to use `gh auth token` in memory.",
    // A scheduler does not inherit the interactive shell environment, so `gh` may not be on the
    // PATH a tick runs with, and the flag then fails even though it works in a terminal. The
    // REMEDY differs by platform and the wording must too: launchd has no environment file to
    // read, so its fix is a PATH in the property list. Windows Task Scheduler runs with the
    // user's persistent environment and needs no caveat here.
    ...(schedulerRemedies[platform] ?? []),
    `  Runtime files: "${runtimeDirectory}"`,
    `  Repository: ${repository}`,
  ];

  if (platform === "launchd") {
    const label = launchdLabel(workerId);
    return [
      `launchd (macOS) — worker ${workerId}`,
      "",
      "Start (the operator installs; this tool does not):",
      `  cp "${artifactDirectory}/${label}.plist" "$HOME/Library/LaunchAgents/${label}.plist"`,
      `  launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/${label}.plist"`,
      "",
      "Inspect:",
      `  launchctl print gui/$(id -u)/${label}`,
      `  tail -n 40 "${runtimeDirectory}/watch.log"`,
      "",
      "Stop (keep files, keep ownership):",
      `  launchctl bootout gui/$(id -u)/${label}`,
      "",
      "Uninstall (stop, remove the agent, remove owned files):",
      `  launchctl bootout gui/$(id -u)/${label} || true`,
      `  rm -f "$HOME/Library/LaunchAgents/${label}.plist"`,
      `  ${uninstall}`,
      ...common,
    ].join("\n");
  }

  if (platform === "systemd") {
    const base = systemdUnitBase(workerId);
    return [
      `systemd user timer (Linux) — worker ${workerId}`,
      "",
      "Start (the operator installs; this tool does not):",
      `  mkdir -p "$HOME/.config/systemd/user"`,
      `  cp "${artifactDirectory}/${base}.service" "${artifactDirectory}/${base}.timer" "$HOME/.config/systemd/user/"`,
      "  systemctl --user daemon-reload",
      `  systemctl --user enable --now ${base}.timer`,
      "",
      "Inspect:",
      `  systemctl --user list-timers ${base}.timer`,
      `  journalctl --user -u ${base}.service -n 40 --no-pager`,
      `  tail -n 40 "${runtimeDirectory}/watch.log"`,
      "",
      "Stop (keep files, keep ownership):",
      `  systemctl --user disable --now ${base}.timer`,
      "",
      "Uninstall (stop, remove the units, remove owned files):",
      `  systemctl --user disable --now ${base}.timer || true`,
      `  rm -f "$HOME/.config/systemd/user/${base}.service" "$HOME/.config/systemd/user/${base}.timer"`,
      "  systemctl --user daemon-reload",
      `  ${uninstall}`,
      ...common,
    ].join("\n");
  }

  if (platform === "windows") {
    const task = windowsTaskName(workerId);
    return [
      `Windows Task Scheduler — worker ${workerId}`,
      "",
      "Start (the operator installs; this tool does not):",
      `  schtasks /Create /TN "${task}" /XML "${artifactDirectory}\\${task}.xml" /F`,
      "",
      "Inspect:",
      `  schtasks /Query /TN "${task}" /V /FO LIST`,
      `  type "${runtimeDirectory}\\watch.log"`,
      "",
      "Stop (keep files, keep ownership):",
      `  schtasks /Change /TN "${task}" /DISABLE`,
      "",
      "Uninstall (stop, delete the task, remove owned files):",
      `  schtasks /End /TN "${task}"`,
      `  schtasks /Delete /TN "${task}" /F`,
      `  node scripts\\worker-inbox-platform\\worker-inbox-uninstall.mjs --worker-id ${workerId}`,
      ...common,
    ].join("\n");
  }

  throw new Error("worker_inbox_platform_platform_invalid");
}
