// Start, inspect, stop, and uninstall instructions for each supported platform.
//
// These are printed or written as documentation. Nothing here installs, enables, or starts
// a scheduler: producing the instructions is the deliverable, and the operator performs any
// installation deliberately. Quoted forms are shown so paths containing spaces work as
// written.
import { launchdLabel, systemdUnitBase, windowsTaskName } from "./artifacts.mjs";

export function instructionsFor({ platform, workerId, artifactDirectory, runtimeDirectory, repository }) {
  const uninstall = `node scripts/worker-inbox-platform/worker-inbox-uninstall.mjs --worker-id ${workerId}`;
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
    // PATH a tick runs with - the flag then fails even though it works in a terminal. Windows Task
    // Scheduler runs with the user environment and does not have this problem; launchd and systemd
    // user services do.
    ...(platform === "windows" ? [] : [
      "  Scheduler PATH: this scheduler does not inherit your shell environment, so",
      "  --token-from-gh only works if `gh` is on the PATH the tick runs with. If it is not, the",
      "  tick fails loudly with worker_inbox_platform_gh_token_unavailable and exit 1 - it does not",
      "  fall back to anonymous requests. Fix it by supplying the token through the environment file",
      "  the unit reads, or by adding the directory holding `gh` to PATH. See the platform page.",
    ]),
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
