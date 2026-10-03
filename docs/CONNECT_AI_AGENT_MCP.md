# Connect an AI agent (Claude Code, Codex, any MCP client) to Control Room

Control Room exposes one local stdio MCP server through the fleet connector. It
uses the machine's existing fleet credential and the same project scope,
capabilities, queue, leases, results and audit chain as the website. MCP is not
a second scheduler or permission system.

## 1. Join the machine

In Control Room, open **Workers**, choose **Connect a bot**, choose the bot kind and operating system, set its projects and
capabilities, then choose **Create code** and **Copy line**. Run that complete verified
`install` line on that machine. Follow [the worker guide](owner-guides/join-another-machine.md) first. The
connector stores the generated credential in its private configuration file and
installs a launcher shared by profiles in the current account and MCP shim. Do not copy the credential file
to another machine or put its contents in an MCP configuration.

Confirm the connection before adding an MCP client:

```sh
node /path/printed/by/install/launcher.mjs launch status --config /path/printed/by/install/bot.json
```

## 2. Configure the MCP client

Use the MCP shim path registered or printed by `install`:

```sh
/path/printed/by/install/bin/control-room-mcp --profile BOT_NAME --config /path/printed/by/install/bot.json --workspace /work/project
```

Start it with the agent's project directory as its working directory. Result
files can only come from inside that directory. The shim starts the verified
launcher shared by profiles in the current account, so connector self-updates can take effect. Starting a
downloaded `control-room-connector.mjs mcp` file directly is an unmanaged setup
and never self-updates.

Generic MCP client JSON:

```json
{
  "mcpServers": {
    "control-room": {
      "command": "/path/printed/by/install/bin/control-room-mcp",
      "args": ["--profile", "BOT_NAME", "--config", "/path/printed/by/install/bot.json",
        "--workspace", "/work/project"],
      "cwd": "/work/project"
    }
  }
}
```

Codex CLI:

```sh
codex mcp add control-room \
  -- /path/printed/by/install/bin/control-room-mcp --profile BOT_NAME \
  --config /path/printed/by/install/bot.json --workspace /work/project
codex mcp list
```

Equivalent Codex `config.toml` entry:

```toml
[mcp_servers.control-room]
command = "/path/printed/by/install/bin/control-room-mcp"
args = ["--profile", "BOT_NAME", "--config", "/path/printed/by/install/bot.json", "--workspace", "/work/project"]
cwd = "/work/project"
```

Claude Code:

```sh
claude mcp add control-room -- /path/printed/by/install/bin/control-room-mcp \
  --profile BOT_NAME --config /path/printed/by/install/bot.json --workspace /work/project
claude mcp list
```

The Codex stdio command and `config.toml` field names follow the
[official Codex MCP documentation](https://developers.openai.com/codex/extend/mcp).

## 3. Available tools

| Tool | Result |
| --- | --- |
| `list_eligible_work` | Up to 50 currently claimable tasks in this machine's projects and capabilities |
| `claim` | An idempotent claim through the canonical lease path |
| `post_progress` | A bounded progress message and lease renewal |
| `submit_result` | An answer up to 64 KiB and up to 8 workspace files, 256 KiB each and 1 MiB total |
| `report_blocker` | A bounded blocker; optionally releases the task without calling it complete |
| `propose_work` | An S1 proposal for owner review; it never creates or starts work |

Every attempted tool call is written to the Control Room audit chain before
validation or execution. Revoked or expired credentials fail authentication;
foreign tenant or project records stay indistinguishable from missing records.
There are no MCP tools or fleet routes for approve, accept, review, merge,
grant, assignment or permission widening.

## Troubleshooting

- **Unauthenticated:** the machine credential is expired or revoked. Re-key it
  from the Workers page; do not paste a credential into the client config.
- **Not found:** refresh with `list_eligible_work`. The item may be outside the
  machine's scope, already claimed, withdrawn or in another project.
- **Result refused:** keep the answer and files within the limits above, and
  attach only regular allowed file types from the configured working directory.
- **Server will not start:** run the server command directly once. Protocol
  messages go to stdout; diagnostics and configuration errors go to stderr.
