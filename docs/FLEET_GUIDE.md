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
- *The network dropped during join:* run the same join command again within
  the code's 10-minute lifetime. The pending credential file keeps the same
  secret and client nonce, so Control Room returns the already-created worker
  instead of creating another one. A different machine still cannot reuse it.
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

## Let a machine do the work with Codex, Claude Code or Hermes

When you add the machine, pick its kind: **Codex**, **Claude Code** or
**Hermes**. `run` then does the work itself: it takes one offered task at a
time, gives it to that bot on the machine, and sends the answer back to you
for review.

It only does this when the person at that machine has switched the bot on.
Write a settings file next to the key file
(`~/.config/control-room/harnesses.json`) that only you can change:

```json
{
  "schema": "control-room.fleet-harnesses/v1",
  "adapterModule": "/path/to/control-room/src/fleet/v1/harness-adapters.ts",
  "harnesses": {
    "codex": { "enabled": true, "executablePath": "/opt/homebrew/bin/codex",
      "workingDirectory": "/path/to/an/empty/work/folder", "deadlineMs": 1800000 }
  }
}
```

Then, from a Control Room checkout on that machine: `pnpm fleet:worker`
(the same as `node --import tsx scripts/fleet/connector.mjs run`).

- `deadlineMs` is the longest one task may run (at most one hour).
- Codex and Claude Code can also take `"model"` and `"effort"`
  (Claude Code also needs `"supportsEffort": true` or `false` with them).
  Hermes needs `"profile"`, `"model"` and `"provider"`.
- A bot that is missing from the file, or set to `"enabled": false`, is never
  started. `run` says so and takes no work.

What you will see:

- The machine's card on the Workers page shows its latest note:
  **Started on Codex on this machine**, then "still working" about once a minute.
- A finished answer arrives in the red **needs you** box. Nothing is accepted
  until you accept it.
- If the bot fails, crashes, runs out of time, or gives an answer over 64 KiB,
  its card shows a red **Blocked** note saying so, and the task goes back to the queue for
  another machine. It is never shown as a result. That machine does not pick
  the same task again until `run` restarts.
- If a bot ignores its own time limit, `run` stops taking work until someone
  checks the machine.
- When Control Room is paused, draining or stopped, machines take no new
  tasks, and Stop cancels the task that is running. (This follows the
  server-side Pause switch once it is connected to the fleet gateway.)
- **Remove** the machine and it stops at once; its running task is dropped
  and goes back to the queue when its time runs out.

The connector never hands the bot the machine's key, and it talks only to
your Control Room address. The bot itself uses its own normal sign-in (for
example your Codex or Claude account) and its own network access.

Codex runs read-only, but read-only still means it can **read** files,
including this machine's key file, if a task tells it to. The connector checks
every answer and refuses to send one that contains the key written out plainly.
It cannot catch a key that Codex was told to disguise (for example base64 or
split into pieces), so only give a Codex machine tasks you wrote or trust. If a
result contains a long string that looks like code or random letters and you
did not ask for one, reject it and rotate the machine's key. Claude Code and
Hermes run with no tools at all, so they cannot read files in the first place.
Running the connector under its own OS user account keeps your personal files
(`~/.ssh`, other sign-ins) out of Codex's reach. It does not hide the machine's
own key, which Codex can always read.

## Connect a new agent over MCP

Any agent that speaks MCP (Claude Code, Codex, Hermes and others) can use a
joined machine's connector as its Control Room toolbox. See the one-page
[`Connect an AI agent to Control Room`](CONNECT_AI_AGENT_MCP.md) guide for the
complete setup and client examples. The minimal generic configuration is:

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
| `list_eligible_work` | Lists tasks it may claim now |
| `claim` | Claims one task (safe to retry) |
| `post_progress` | Posts a short progress note and keeps the claim alive |
| `submit_result` | Sends an answer and up to 8 files from its working folder for your review |
| `report_blocker` | Says it is stuck; can hand the task back |
| `propose_work` | Suggests S1 work; nothing starts until you approve it |

The MCP tools use the same queue, permissions and records as the website.
Files are only sent from inside the folder the agent was started in, at most
256 KB each and 1 MB in total.

## For the person running Control Room

The connector talks to the **fleet gateway**, a small service on the Control
Room computer: `pnpm fleet:gateway <config.json>`. It listens on this computer
only (`127.0.0.1`); publish it through Tailscale Serve or your tunnel. Its
config names its own database login (`control_room_fleet`), which can only do
fleet work. Owner enrollment, offer, review and revocation records use a
different protected login in `control_room_fleet_owner_authority`; the normal
web and gateway logins have no direct write grant on those records. Workers
never see either login.

The unauthenticated join endpoint accepts at most 4 KiB, defaults to 8 attempts
per client address and 80 attempts total per minute, and shares a 16-request
pre-authentication concurrency ceiling with credential checks. Rejections happen
before a request body or database lookup. Because the gateway binds to loopback,
it accepts `CF-Connecting-IP` or the first `X-Forwarded-For` address only from
that loopback proxy; a non-loopback peer cannot supply its own rate-limit identity.
