# Add a machine or an agent

Control Room can hand work to bots on other computers. Each computer joins
once with a short code, then talks to Control Room on its own. It never gets a
database password and never gets your login.

## What changed — 2026-10-02

Today's review branches add a choice of bots when offering work, including
offline bots that can pick it up later, and distinguish your rejection from
your cancellation. These changes must be in your installed update to appear.
**Last seen** reports real contact; **Last seen unknown** means no usable contact
time. Contact alone does not prove the bot is working, and old status can
become stale or unknown. See the [connection recovery table](INSTALL_NIGHT_OWNER_GUIDE.md#connection-failure-messages)
if creating a code or joining fails.

## Add a new machine

1. In Control Room, open **Workers** and choose **Connect a bot**.
2. Give it a name, pick what kind of agent it is and its operating system, tick the projects it may work
   on, and tick what it may do (for example *Change code* or *Research*).
   Before creating the code, decide whether to turn on **Let this bot pick up
   approved work on its own**. It is off by default and available only for
   Codex, Claude Code and Hermes. For unattended Hermes, first fill in the
   lead's checked **Profile**, **Model** and **Provider**.
3. Choose **Create code**. You get one command. It works **once** and
   **stops working after 10 minutes**.
4. On the new machine (with Node 20 or newer), paste the
   command into a terminal. It looks like this:

   ```sh
   # Use the complete line shown by Control Room. It downloads the versioned
   # connector and manifest, verifies their displayed digest, then joins.
   ```

   The page shows one line for the operating system you selected; on Windows paste it into PowerShell.
5. The verified line runs `install` for every bot kind. Follow the exact final
   action shown for your bot and operating system. If you chose unattended work
   before **Create code**, the line includes `--unattended` and creates one profile-scoped per-user login
   service on macOS, Windows or Linux. That service starts `launcher.mjs launch
   run`, so a healthy signed update is relaunched safely. The task host never
   starts the bot. The machine shows as **Connected** within a minute.

Each installed bot keeps its own key in a private file
(`~/.config/control-room/bots/<name>.json`, readable only by you). The key
renews itself every few weeks while `run` is going.

**If something goes wrong**

- *The code was refused:* it was already used, cancelled, or more than 10
  minutes old. Make a new one.
- *The network dropped during join:* run the same join command again within
  the code's 10-minute lifetime. The pending credential file keeps the same
  secret and client nonce, so Control Room returns the already-created worker
  instead of creating another one. A different machine still cannot reuse it.
- *A machine is lost or you are unsure about it:* open its **Details** and choose
  **Remove**. Access is revoked immediately. Running work is asked to stop when the connector next notices, normally on a later polling tick; confirm local process exit separately, especially on a disconnected machine. Unfinished work can return to the queue when its lease expires; removal does not mark it done.
- *You want a fresh key without removing it:* **Details → Give it a new key**, then
  run the new command on that machine. The old key stops working.

Your Control Room address must be reachable from the machine. Tailscale Serve
works well (`https://<name>.<tailnet>.ts.net`). The generated Cloudflare browser tunnel does not support the worker route: it requires a browser Access token across the hostname. Have the lead prepare a separately reviewed fleet route before using Cloudflare for workers; see [the browser-tunnel limit](owner-guides/open-from-other-computers.md#if-you-also-join-worker-machines).

## Give work to other machines

On a task that has not started yet, choose **Offer to other machines** and the
skill it needs. By default any connected bot with that skill and access to the
project may take it. Under **Who can take it**, **Choose bots** limits the offer
to the bots you tick (up to 20); the list shows only bots in that project with the
chosen skill, offline ones included, and an offer to an offline bot waits until it
reconnects. **Any connected bot** goes back to the default. Offering is your permission for an
eligible bot to run it. A refused request keeps your choices for retry; if a
reply is lost, choose **Check saved offer** before offering again. One machine
works on it at a time.
When the result comes back it appears in the red **needs you** box on the Workers page:

- **Accept** closes the task.
- **Ask for changes** (write what you want) sends it back; the same or another
  machine picks it up again.
- **Reject** closes the task without accepting it. The updated task wording is
  **Rejected by you**. A cancelled task shows **Job cancelled**, which does not
  say who cancelled it.

A machine can never accept its own work, approve anything, merge, or give
itself more access.

## Let a machine do the work with Codex, Claude Code or Hermes

When you add the machine, pick its kind: **Codex**, **Claude Code** or
**Hermes**. `run` then does the work itself: it takes one offered task at a
time, gives it to that bot on the machine, and sends the answer back to you
for review.

It only does this when the person at that machine has switched the bot on.
The per-bot installer writes a private settings file beside that bot's key
(`~/.config/control-room/bots/<name>.harnesses.json`). A manual connector can
use the same schema with `run --harnesses <path>`:

```json
{
  "schema": "control-room.fleet-harnesses/v1",
  "harnesses": {
    "codex": { "enabled": true, "executablePath": "/opt/homebrew/bin/codex",
      "workingDirectory": "/path/to/an/empty/work/folder", "deadlineMs": 1800000 }
  }
}
```

Then use the `launcher.mjs launch run` command printed by `install`, or select
**Let this bot pick up approved work on its own** on the Connect a bot page to
install a per-user login worker that uses that launcher for this profile. Its
reviewed Codex, Claude Code and Hermes adapters are inside the same file; the
machine needs no Control Room checkout and the settings cannot select a
replacement adapter module. The login worker re-reads this file, so it is safe
to enable or disable the harness after installation. Starting a downloaded
connector directly with `run` does not self-update.

Hermes unattended setup asks for its local profile, model and provider before
creating the join code. Invalid or missing worker choices, executable paths,
deadlines, service platforms and per-user identities are refused before the
single-use code can be redeemed.

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
  tasks, and Stop asks running work to stop; confirm remote process exit separately. (This follows the
  server-side Pause switch once it is connected to the fleet gateway.)
- **Remove** revokes access immediately; it does not confirm remote process exit. The connector asks running work to stop when it next notices, normally within its 60-second polling interval while connected. Confirm the local stop separately. Unfinished work can return to the queue when its lease expires.

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
complete setup and client examples. Use the MCP command installed by `install`;
it starts the launcher shared by profiles in the current account, which verifies and selects the current
connector. A hand-written configuration that starts a downloaded
`control-room-connector.mjs mcp` file directly does not self-update. That direct
form is shown below only for deliberately unmanaged setups:

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
Room computer. The current `pnpm fleet:gateway` package command is not a usable owner launch recipe: it first builds a connector without the required release trust, then builds the app, then calls an attended protected-root entry point. A positional config file does not fit that entry point. Changing the arguments alone cannot fix the preceding build refusal.

Have the lead reconcile and verify the installed gateway launch flow before connecting remote machines. Do not run a second gateway or bypass release verification. The following release-signing notes are operator prerequisites, not a replacement launch command. At installation, create the shared key and trust record once with
`pnpm install:release-key`. Keep `releaseTrust` in the gateway config and the
private key with the upgrader. Build the connector from a clean checkout with
`pnpm build:fleet-connector -- --release-trust <release-trust.json>`, then sign
the assembled release with `pnpm release:sign`. The public trust is embedded in
the verified connector bundle, so enrollment cannot substitute a key. The
gateway refuses missing, altered or incorrectly signed `connector-release.json`
files at startup.

The release-key identity is pinned to each connector machine. Version floors may
only rise and do not change that identity. Control Room v1 does not rotate the
release key on an enrolled machine: changing the installation release key
requires reinstalling the connector on every machine. On each machine,
uninstall every profile with `uninstall --bot <kind> --name <label>` before
installing the connector signed by the new key; the last uninstall clears the
machine trust, installed versions, launcher and current pointer. If every profile was removed by an older connector, run
`reset-machine --i-am-the-installer` before retrying the new join code. A connector that sees a rotation record refuses it
and keeps the last runnable version and key pin.
The gateway config names its own database login (`control_room_fleet`), which
can only do fleet work. Owner enrollment, offer, review and revocation records use a
different protected login in `control_room_fleet_owner_authority`; the normal
web and gateway logins have no direct write grant on those records. Workers
never see either login.

The unauthenticated join endpoint accepts at most 4 KiB, defaults to 8 attempts
per IPv4 `/24` or IPv6 `/64` and 80 attempts total per minute. Enrollment has its own four-request concurrency limit; unknown-credential checks have a separate 16-request limit. Together they can hold 20 requests, not a shared ceiling of 16.
Enrollment rejections happen before a request body or database lookup. Failed
credential checks have their own per-network and global budget. Successfully
authenticated workers use a separate per-worker reserve which failed credentials
can never consume or fill. The gateway remembers only the verified credential
digest after enrollment or authentication, never the bearer secret. Unknown
credentials provisionally spend the failure budget before a database lookup;
a successful or interrupted lookup refunds that charge. On startup, active
unexpired credential digests are loaded through the same least-privilege fleet
database login, so already-enrolled machines retain this reserve after restart.

Forwarded client-address headers are not trusted by default, including from a
loopback peer. If the gateway is behind a known proxy, set both
`trustedProxyAddresses` (an array of the proxy's exact socket IP addresses) and
exactly one `trustedClientHeader`: `"cf-connecting-ip"` for Cloudflare, or
`"x-forwarded-for-rightmost"` for a proxy which appends the immediate client to
X-Forwarded-For. Do not enable both header formats. A forwarded header is ignored
unless the request's immediate socket peer is in the configured proxy list.
