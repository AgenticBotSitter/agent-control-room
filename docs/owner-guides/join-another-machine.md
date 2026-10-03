# Join another machine as a worker

Use this guide to connect a bot on another computer. It receives access only to the projects and kinds of work you choose, never your Control Room login or a database password.

## Before you begin

Sign in to Control Room and have an active project ready in **Projects**. On the new machine, have Node 20 or newer and the chosen bot installed and signed in. The machine must reach the Control Room fleet address. Tailscale Serve can provide this private route. The generated Cloudflare browser tunnel in [the other-computer guide](open-from-other-computers.md) does not support worker connections: it requires a browser Access token even on `/fleet/`. Ask the lead to check the fleet route before continuing.

## Create and use the verified line

1. Open **Workers → Connect a bot**.
2. Enter **Name for this bot**, choose the bot kind and the operating system of the new machine, then choose its projects and kinds of work.
3. Decide whether to turn on **Let this bot pick up approved work on its own**. It is off by default. Only Codex, Claude Code and Hermes offer unattended work; other kinds connect for interactive MCP use. For unattended Hermes, fill in the lead's checked **Profile**, **Model** and **Provider** before continuing.
4. Choose **Create code**, then **Copy line**. The page shows one complete line for the operating system you selected. It works once and expires after 10 minutes. Keep it private; never save or share it.
5. Paste the whole line into the terminal named by the page on the new machine. Do not reconstruct a download or `join` command. This line checks the connector manifest, file size and SHA-256 before `install` creates the profile, workspace and launcher for this account.
6. Follow the exact final action shown by the result for your bot and operating system. Interactive bots may need to close and reopen their app. Unattended installation creates one login worker for that profile; you do not need to start a second worker by hand.

If the code expires or is refused, use [the connection recovery table](../INSTALL_NIGHT_OWNER_GUIDE.md#connection-failure-messages). If verification or the fingerprint fails, stop and show only the failure message to the lead. A new code does not repair a bad release. If the network drops while joining, the pending join information can allow the same line to resume within its lifetime; first have the lead check the message and saved state rather than creating competing installations.

## Check and remove the connection

On **Workers → Other machines**, look for the chosen name, **Connected** and a recent **Last seen**. The board checks every 30 seconds. The **Connected bots** list on the connection page needs a reload to check again. Contact alone does not prove that a task ran successfully.

**Details → Remove** revokes access immediately. The connector asks running work to stop when it next notices revocation, normally on a later polling tick. A disconnected machine may still be working: confirm that its local processes have stopped separately. Unfinished work can return to the queue when its lease expires; removal does not mark it complete or uninstall its login worker. Use the profile's exact uninstall command from its result with the lead to remove that worker too.

**Details → Give it a new key** replaces access without removing the machine. Follow the new command shown for that machine; keep keys and commands private. If a change could not be confirmed, reload and inspect the saved workers, pending codes or recorded review before trying it again.

For an interactive MCP client, follow [Connect an AI agent to Control Room](../CONNECT_AI_AGENT_MCP.md) after installation. It cannot approve, merge, accept its own work or widen its access.
