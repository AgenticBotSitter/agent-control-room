# Add a machine or an agent

Control Room can hand work to bots on other computers. Each computer joins
once with a short code, then talks to Control Room on its own. It never gets a
database password and never gets your login.

## Add a new machine

1. In Control Room, open **Workers** and choose **Add a worker**.
2. Give it a name, pick what kind of agent it is, tick the projects it may work
   on, and tick what it may do (for example *Change code* or *Research*).
3. Choose **Create join code**. You get one command. It works **once** and
   **stops working after 10 minutes**.
4. On the new machine (macOS or Linux, with Node 20 or newer), paste the
   command into a terminal. It looks like this:

   ```sh
   curl -fsSL https://<your-control-room>/fleet/v1/connector.mjs -o control-room-connector.mjs \
     && node control-room-connector.mjs join --server https://<your-control-room> --code crj_…
   ```

   On Windows, use the PowerShell line shown under **Windows** on the same page.
5. Keep it connected: `node control-room-connector.mjs run`. The machine shows
   as **Connected** on the Workers page within a minute.

The machine keeps its own key in a private file (`~/.config/control-room/connector.json`,
readable only by you). The key renews itself every few weeks while `run` is going.

**If something goes wrong**

- *The code was refused:* it was already used, cancelled, or more than 10
  minutes old. Make a new one.
- *A machine is lost or you are unsure about it:* open its **Details** and choose
  **Remove**. It stops working at once. Anything it was doing goes back to the
  queue when its time runs out; nothing is marked done.
- *You want a fresh key without removing it:* **Details → Give it a new key**, then
  run the new command on that machine. The old key stops working.

Your Control Room address must be reachable from the machine. Tailscale Serve
works well (`https://<name>.<tailnet>.ts.net`). A Cloudflare Tunnel also works;
the connector signs in with its own key, so the `/fleet/` path must not sit
behind the browser login page.

## Give work to other machines

On a task that has not started yet, choose **Offer to other machines** and the
skill it needs. Any connected machine with that skill, in that project, can
claim it. One machine works on it at a time. When the result comes back it
appears in the red **needs you** box on the Workers page:

- **Accept** closes the task.
- **Ask for changes** (write what you want) sends it back; the same or another
  machine picks it up again.
- **Reject** closes the task without accepting it.

A machine can never accept its own work, approve anything, merge, or give
itself more access.

## Connect a new agent over MCP

Any agent that speaks MCP (Claude Code, Codex, Hermes and others) can use a
joined machine's connector as its Control Room toolbox. First join the machine
as above, then add this MCP server to the agent:

```json
{ "mcpServers": { "control-room": {
    "command": "node",
    "args": ["/path/to/control-room-connector.mjs", "mcp"] } } }
```

For Claude Code, the same thing from a terminal:

```sh
claude mcp add control-room -- node /path/to/control-room-connector.mjs mcp
```

The agent then has these tools, and only these:

| Tool | What it does |
| --- | --- |
| `control_room_whoami` | Shows this worker's projects and skills |
| `control_room_list_work` | Lists tasks it may claim now |
| `control_room_claim_task` | Claims one task (safe to retry) |
| `control_room_post_progress` | Posts a short progress note and keeps the claim alive |
| `control_room_report_blocker` | Says it is stuck; can hand the task back |
| `control_room_submit_result` | Sends a summary and up to 8 files from its working folder for your review |
| `control_room_my_claims` | Shows your decision on each result, including changes you asked for |
| `control_room_propose_work` | Suggests new work; nothing starts until you approve it |

The MCP tools use the same queue, permissions and records as the website.
Files are only sent from inside the folder the agent was started in, at most
256 KB each and 1 MB in total.

## For the person running Control Room

The connector talks to the **fleet gateway**, a small service on the Control
Room computer: `pnpm fleet:gateway <config.json>`. It listens on this computer
only (`127.0.0.1`); publish it through Tailscale Serve or your tunnel. Its
config names its own database login (`control_room_fleet`), which can only do
fleet work. Workers never see that login.
