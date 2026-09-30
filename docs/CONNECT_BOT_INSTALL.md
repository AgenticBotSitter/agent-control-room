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
does not create a daemon, login item, or system service.

## Registration and the owner's next action

| Kind | Installer action | Owner action after success |
| --- | --- | --- |
| Claude Code | `claude mcp add --scope user` | Open Claude Code and ask it to list Control Room work. No restart is required. |
| Codex | `codex mcp add` | Open Codex and ask it to list Control Room work. No restart is required. |
| Hermes | `hermes mcp add`, followed by a saved-entry check | Open Hermes and ask it to list Control Room work. No restart is required. |
| Cursor | Merge one entry into the user's Cursor MCP JSON | Close and reopen Cursor. |
| Claude Desktop | Merge one entry into the platform's Claude Desktop MCP JSON | Close and reopen Claude Desktop. |
| Generic MCP | Write one entry to `%APPDATA%\control-room\generic-mcp.json` on Windows or `$XDG_CONFIG_HOME/control-room/generic-mcp.json` on macOS/Linux (`~/.config` when XDG is unset) | Import that named entry into the chosen MCP host. |

Re-running the exact line is idempotent for the same profile. Once enrollment
has succeeded, it reuses the saved credential, refreshes the launcher and the
same registration entry, then proves the credential with a heartbeat. A line
that fails release verification performs no enrollment or installation.
