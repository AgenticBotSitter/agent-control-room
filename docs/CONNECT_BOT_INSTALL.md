# Connect a bot installation contract

The signed-in **Connect a bot** page emits one server-built line. The browser
does not assemble or amend it. That line downloads the connector and manifest,
checks the release version, source commit, byte size, and SHA-256, then runs
`connector install` non-interactively with the one-time code and
`--i-am-the-installer`.

## Profile and workspace policy

Each enrollment gets a shell-safe profile name derived from the owner-visible
display name plus the final 12 hexadecimal characters of the worker ID. Raw
display names never enter shell or PowerShell text. A rekey retains the same
profile name because the worker ID is stable.

Every kind uses a separate private workspace:

- macOS and Linux: `~/ControlRoomWork/<profile>`
- Windows: `$HOME\ControlRoomWork\<profile>`

The connector passes that exact directory to the registered MCP server. The
MCP host launches the connector over stdio when it needs it, so the installer
does not create a background worker by default.

The page also has an off-by-default **Let this bot pick up approved work on
its own** choice for Claude Code, Codex and Hermes. Those are the kinds with a
reviewed local harness. Cursor, Claude Desktop and Generic MCP remain
interactive because they have no unattended harness, and the server refuses
an unattended command for those kinds rather than promising work it cannot
run.

When selected, the same verified line adds `--unattended` and installs exactly
one login-scoped worker for that profile. Its service identity is a stable
16-character SHA-256 prefix of the validated profile, so platform name
normalization cannot make two profiles collide:

- macOS: `~/Library/LaunchAgents/xyz.agentcontrolroom.connector.<digest>.plist`
- Windows: a least-privilege `AgentControlRoomConnector-<digest>` scheduled
  task with a logon trigger
- Linux: `~/.config/systemd/user/control-room-connector-<digest>.service`,
  enabled with `systemctl --user`

It is never a root, machine or system service. Failure restarts are delayed;
a successful exit is not restarted. Logs are kept under the user's local
state directory and rotated to one bounded backup. The worker runs
`connector run` for the exact profile and re-reads the owner-controlled
`<profile>.harnesses.json` beside the profile credentials before taking work.
The installer writes that file through the same parser used at startup.

Hermes unattended setup requires the local profile, model and provider on the
Connect a bot page before a join code is created. Codex and Claude Code may use
their local defaults; the installer also retains the reviewed model, effort,
deadline and executable inputs for deliberate command-line configuration.

## Registration and the owner's next action

| Kind | Installer action | Owner action after success |
| --- | --- | --- |
| Claude Code | `claude mcp add --scope user` | Open Claude Code and ask it to list Control Room work. No restart is required. |
| Codex | `codex mcp add` | Open Codex and ask it to list Control Room work. No restart is required. |
| Hermes | `hermes mcp add`, followed by a saved-entry check | Open Hermes and ask it to list Control Room work. No restart is required. |
| Cursor | Merge one entry into the user's Cursor MCP JSON | Close and reopen Cursor. |
| Claude Desktop | Merge one entry into the platform's Claude Desktop MCP JSON | Close and reopen Claude Desktop. |
| Generic MCP | Write one entry to `%APPDATA%\control-room\generic-mcp.json` on Windows or `$XDG_CONFIG_HOME/control-room/generic-mcp.json` on macOS/Linux (`~/.config` when XDG is unset) | Import that named entry into the chosen MCP host. |

For an unattended install, the result instead says that the login worker is
running and prints the exact profile uninstall command. `uninstall` first
stops and removes only that profile's LaunchAgent, scheduled task or systemd
user unit, then removes the matching MCP registration and credential. Other
profiles and unrelated services are not named or removed.

Re-running the exact line is idempotent for the same profile. Once enrollment
has succeeded, it reuses the saved credential, refreshes the launcher and the
same registration entry, then proves the credential with a heartbeat. A line
that fails release verification performs no enrollment or installation.
The unattended service identity is also stable, so retrying or running the
same line concurrently refreshes one service rather than creating duplicates.

The standing worker takes one task at a time. That is within every worker's
`maxConcurrent` setting, and the gateway/database claim guard remains the
authoritative ceiling if another connector process is started manually. Pause,
Drain and Stop prevent new claims; Stop also cancels the active harness. A
revoked credential makes the worker exit successfully, so failure-only restart
policies do not crash-loop it. A broken or missing harness settings file takes no
work and is checked again on the next pass.

## What changed — 2026-10-02

For the owner, sign-in, permission, invalid choices and refused codes need
different next steps. See the [connection failure messages](INSTALL_NIGHT_OWNER_GUIDE.md#connection-failure-messages)
for what to do, including the older generic-message limitation found in review.
A dropped reply can leave the outcome uncertain; check whether the bot joined
before creating another profile. A verification failure means stop and show
the lead, rather than bypassing the check.
