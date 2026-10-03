# Install-night owner guide

This is one owner evening in your normal macOS account: practice first, then the real install. Before the evening, the lead creates the new read-only project token, saves the token in your password manager, sends the reviewed 40-character commit to your phone, and prepares one paste file containing every long command with all lead-supplied values filled in. You need an Apple silicon Mac (Intel is not supported by this install-night route) on power, your phone with Face ID available, and Apple Terminal open in your **normal account**. Keep the evening clear for about two hours.

Paste each labelled command block from the lead's one paste file. In Terminal, type only your Mac password, the six confirmation words, and the six-character code; paste the project token from your password manager when asked. Do not type long commands. After installation, copy each short-lived bot line from the signed-in Connect a bot page when asked; never save that line in the paste file.

If you run the paste file from an unreviewed terminal, its shell chain will be listed too; the only reviewed terminals are Apple Terminal and iTerm at their reviewed bundle locations.

# Part 1: rehearsal

The rehearsal is a practice install that proves the Mac returns to its starting state. Follow the exact commands in [the E2E-2 rehearsal kit](install/E2E2_REHEARSAL.md); do not shorten, substitute, or repeat them.

## First: Pause all bots

The lead stops every bot job. You or the lead then turn Control Room's own bots to **Stop**. Quit Claude and ChatGPT before pasting the kit's read-only bot check. It lists any codex, claude, hermes or opencode worker process under your account and never kills one. Continue only when it prints `PASS: no codex/claude/hermes/opencode worker processes under the owner's uid.`

Before the password step, quit the Claude app and the ChatGPT app (Cmd-Q). Also quit Image Lab and ComfyUI (Cmd-Q) before the bot check. The lead is not available from here until the installer prints Ready (or rolls back). If something fails: do not retry, copy the last lines of the Terminal into a note, reopen Claude afterwards and show the lead.

In plain words: **your Mac password is typed only after every bot has stopped**. The password block repeats the stopped-process check immediately before its first privileged command. Every unverified process may be a bot and must be quit first; folders are left alone. Keep worker supervisors in **Stop** and worker apps closed until Ready or rollback. The check includes processes born between its scans, but it cannot prevent a later launch.

The same normal account captures the live snapshot, keeps its checksum, checks that the live phone service has not changed, runs the isolated rehearsal, and performs the real install. There is no account handoff. Keep the snapshot and every `Serve and hostname unchanged` check.

The rehearsal never changes Tailscale, and your phone keeps working during it. It uses a separate practice name and a fresh database. The practice install does the phone’s part by itself; you need no phone and do not approve Face ID or type a code. Wait for `Practice passkey registered. No phone was used.` If it says `Practice passkey did not register`, stop and show the lead after reopening Claude.

The real install does change one phone route. When it succeeds, the usual `:443` phone address moves from the old Control Room on port 7864 to the new Control Room on port 3210. The separate `:8443` preview stays on port 3310 throughout. If the install stops before healthy, rollback puts `:443` back on exactly port 7864 and still leaves `:8443` alone. The real install starts with a fresh database; it does not copy the old Control Room's data.

Start the real install only when the rehearsal kit says every result is `PASS`, its final system diff is empty (apart from the retained rehearsal record), and the owner-account check still shows the same checksum.

# Part 2: the real install

Quit Image Lab and ComfyUI (Cmd-Q), and any other bot program the installer lists, before pasting the install command. The check refuses with `STOP: bot worker processes are still running under the owner's uid:` while a listed process remains. Some entries show a program and folder because the check cannot identify them with certainty; it treats them as bots. Stop each listed process or quit its app, then repeat the check. If you do not recognise one, do not continue: show the lead after reopening Claude. The check never kills processes, and their folders are left alone.

The lead's paste file contains this live-install block with `COMMIT40` replaced by the reviewed commit. Do not reconstruct or edit it at the Terminal:

```sh
live_install_step() {
  COMMIT40='COMMIT40'
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  "$NODE_BIN" "$KIT_ROOT/scripts/install/rehearsal/check-bots-stopped.mjs" --password-handoff || {
    printf '%s\n' 'STOP: processes may have started since the earlier check; quit every listed program first.'; return 1;
  }
  BOOTSTRAP_ROOT="$(/usr/bin/sudo /usr/bin/mktemp -d /var/root/cr-boot.XXXXXX)" || {
    printf '%s\n' 'STOP: bootstrap folder creation failed; show the lead after reopening Claude.'; return 1;
  }
  /usr/bin/sudo /bin/sh "$KIT_ROOT/scripts/install-night/bootstrap.sh" "$COMMIT40" "$BOOTSTRAP_ROOT" || {
    printf '%s\n' 'STOP: install failed. Do not retry. Keep the Terminal message and show the lead after reopening Claude.'; return 1;
  }
}
live_install_step || return 1
```

1. After the lead checks the rehearsal results, quit Claude and ChatGPT again (Cmd-Q). In Apple Terminal in your normal account, paste the labelled live-install line from the lead's paste file. Enter your Mac password and paste the read-only token from your password manager when asked. Do not type a made-up version or paste only part of the line.
2. Wait several minutes while the source is fetched and built. Compare the printed commit with the reviewed commit the lead sent to your phone. Then type the six words it shows; you get three tries.
3. Scan the terminal QR code with your phone, approve with Face ID, then type the six-character code shown by your phone. Delete or Backspace corrects a typo; Ctrl-C stops code entry. If a bad code is rejected and the installer prints a fresh QR/link, use that new link and its new phone code. Do not rerun the install.
4. The health check runs before passkey registration. After registration, wait for `Ready: Control Room release <id> is current. Self-update is Off.` The three successful installer health samples and this Ready line are the install check. Sign in on the Mac as described below, then open Home. Its **Local worker evidence** section does not prove that a worker is running; **Self-update: Off** describes the updater only. If passkey setup stopped, the last line instead starts `Not ready: Face ID is NOT set up`; the install is still present, but follow the Face ID row below. Opening Home uses an owner-code session; it does not test Face ID. There is no separate read-only Face ID test in this release. Do not request an update or rollback just to test it.

## If something goes wrong

| What you see | Do this |
| --- | --- |
| `bootstrap_platform_refused` | This route requires Apple silicon and macOS. Stop and show the lead after reopening Claude; an Intel Mac cannot use this install-night recipe. |
| The six words are wrong three times. | It stops. If the Terminal says the attempted install was undone, rollback finished; if it says it could not be fully undone, leave all files in place. Keep the message on screen and show it to the lead after reopening Claude; there is no fourth try. |
| Face ID setup fails, or the last line says `Not ready: Face ID is NOT set up`. | Control Room may remain installed. Do not retry or reload the phone page. Keep the Terminal message and show the lead after reopening Claude. Do not run `passkey add` yourself: it selects initial mode only when no passkey has ever been recorded. Any existing key, even a revoked one, selects add mode; without an active key approval, the new key is inactive for 24 hours. An unreadable key list stops the command. |
| Terminal closes or power is lost. | Do not retry. Copy the last available Terminal lines into a note, then show the lead after reopening Claude. If power was lost, record what you remember and any saved output. |
| The line says this Mac is already installed. | Do not reinstall. Stop and show the lead after reopening Claude. The lead must check the recorded passkeys before choosing recovery. |
| The install undoes itself. | Only the message “The attempted install was undone” confirms rollback finished. “The install could not be fully undone” means recovery still needs the lead. Keep the message on screen and show it to the lead after reopening Claude. |
| Home shows a red line other than the Face ID reminder. | Stop and show that line to the lead after reopening Claude. |

Never delete files or try a different install line during the evening.

## After install: connect your bots

**What it does:** the installed Control Room sends work to bots connected from your normal Mac account. Connect Codex, Claude Code and Hermes separately. Each gets its own private workspace and access only to the projects and kinds of work you choose. The real install does not enroll them for you.

Start only after Ready and Mac sign-in. Face ID registration and Mac sign-in are separate steps. The lead must first check that Node, curl and the three bot commands are available in this account, and that each bot is already signed in and usable. These are the owner's bot commands, not the installed service account's commands. On **Home**, under **Pause, drain or stop**, choose **Stopped** while connecting; this prevents new work from being taken.

### Sign in on the Mac

The phone does not sign in your Mac browser. In the installer Terminal, find the address printed under **Open this address if you cannot scan the QR code**. Open that same website on the Mac with `/session` in place of everything from `/setup` onward. The page says **Enter the local owner code to continue**.

From the original Terminal address, copy only the letters and numbers after `#code=` and before `&reg=` into **Owner code**, then choose **Sign in**. This is the long owner code, not the six-character phone code. It opens Projects. Keep the code and setup link private: do not save them in the paste file, send them to the lead, or include them in screenshots. If the original address is missing, has no `#code=`, or sign-in is refused, stop and show only the refusal message to the lead. Do not reinstall to get a code.

### Connect each bot

1. Open **Workers → Connect a bot** (`/workers/connect`) on the Mac. Have one active test project ready in **Projects**; the new installation starts without the old projects. If there is no project to choose, create one before continuing.
2. Enter **Name for this bot**, choose **Codex**, and select **macOS**. Choose only the test project and **Writing** for this first check. Turn on **Let this bot pick up approved work on its own**. This is off by default; turning it on creates one worker that starts when you sign in to this Mac account. Leaving it off only connects the bot for interactive use.
3. Select **Create code**, then **Copy line**. Paste the whole line into Apple Terminal in your normal account before it expires. The line already contains the enrollment code: do not type a separate code, edit flags, or put the line in the lead's saved paste file. It downloads and verifies the connector before installing this bot's profile. No Mac administrator password is needed for this step.
4. Repeat with a different name and **Claude Code**, then a different name and **Hermes**. For Hermes, fill in **Profile**, **Model** and **Provider** under **Hermes worker selection** before creating the code. Use the lead's checked local values, not guesses. Codex and Claude Code use their local defaults.

**What you should see:** Terminal says `Connected as` and that the worker is installed. Return to **Workers**, under **Other machines**, and look for each chosen name with **Connected** and a recent **Last seen**. This is the online indication; **Working** means there is evidence of a current task. In the reviewed screen update, **Last seen** means real contact, not an edit to the bot record. **Last seen unknown** means no usable contact time is available; **Online — workload unknown** means contact alone does not establish whether it is busy. Old status may become stale or unknown. The board checks every 30 seconds. The Connect a bot page also has **Connected bots**, but reload that page to check again. A pending code or a successful install message alone does not prove the worker stays online.

### Run one small test task

In **Projects**, open the test project and choose **New task**. Save a task titled “Connection check” with instructions: “Write one sentence confirming that you received this test. Do not change files or run commands.” On its task page, under **Other machines**, set **Skill needed** to **Writing**. When you are ready to let a bot run this exact task, choose **Offer to other machines** and choose **Running** on Home. Offering is your permission for an eligible connected bot to claim and execute the task; it is not just saving a draft. By default any of the three bots with Writing access to that project may take it. If you want particular bots, under **Who can take it** choose **Choose bots** and tick them (up to 20); the list shows only bots in that project that have the chosen skill, including offline ones, and an offer to an offline bot waits until it reconnects. **Any connected bot** goes back to the default, and leaving it selected is the same as “any bot”.

Watch **Workers → Other machines** for **Working**, a progress note, and then the returned result. Open **Read the result** and check the sentence before choosing **Accept**, **Ask for changes**, or **Reject**. One returned sentence proves only the bot that took this task. To check each bot separately, choose **Choose bots**, tick just that bot for a new test task, and repeat. On an older screen without a picker, the lead should arrange separate test projects and give only the intended bot Writing access to each, then repeat. **Rejected by you** identifies a result you rejected. A cancelled task shows **Job cancelled**, which does not say who cancelled it. Return to **Stopped** after the check until you deliberately offer more work. Connecting a bot does not approve other tasks or accept its results.

### Connection failure messages

The review found that some current failures still say “Check the choices and try
again” or `Control Room refused the request (unauthenticated).` That wording
can hide the next step. Until the recovery messages are updated, use the table
below to distinguish the problem; ask the lead if the generic message gives
no way to tell which applies.

| Failure | What to do |
| --- | --- |
| Your Control Room sign-in expired. | Sign in again, then return to Connect a bot. Changing the bot choices will not restore your session. |
| You lack owner permission or required verification. | Ask the lead to check your owner access and verification. Repeatedly creating codes will not grant permission. |
| A choice is invalid or missing. | Correct the project, work category or Hermes selections, then try Create code again. |
| Terminal refuses the enrollment code. | The code may have expired or already been used. Create a new code in Connect a bot and run its new whole line. |
| The connection drops or the server fails to reply. | The outcome may be uncertain. Keep the message, check whether the bot appeared, and use the same-profile recovery described below before creating another profile. |

**Other failures:**

| What you see | Do this |
| --- | --- |
| The verified connector release is not ready, or Create code is unavailable. | Stop and show the lead. Check that a project, a work category and all Hermes selections are present. Do not invent a download command. |
| The code expired before installation. | Create a fresh code in Connect a bot and copy its new whole line. |
| The fingerprint or release verification fails. | Stop and show the lead. Do not bypass verification or assume a fresh code repairs a verification failure. |
| Node, curl or a bot command is missing, or registration fails. | Keep the message for the lead. The page assumes these tools already exist in your normal account; it does not install or sign in the bot itself. |
| Terminal closes or installation stops halfway. | Keep Control Room in Stopped and show the lead. The exact original line can retry the same profile using saved enrollment state; do not create duplicate profiles blindly. If enrollment never succeeded and its code expired, a fresh code is needed. |
| Offline, Needs a new key, or no result arrives. | Check Workers again after 30 seconds and show the status or blocker to the lead. Connected proves contact, not successful execution. A stopped Control Room, missing harness settings, bot login or model failure can prevent work. Do not start another worker manually. |
| You want to disconnect a bot. | Workers has Remove, which revokes access. To remove its local login worker too, use that profile's exact uninstall command shown by the Connect a bot result, with the lead. Remove alone does not uninstall it. |

The lead's paste file ends with these connection and recovery instructions. The actual pasteable install lines come from the signed-in page at the time, because they contain single-use enrollment codes and the current verified release. See [the connector contract](CONNECT_BOT_INSTALL.md) for the detailed flow.

## After an upgrade: rescue and downgrade

This command applies only to the installed system-service route, after the lead checks the saved pair and the possible data loss. It uses the fixed installed shim and its fixed protected root; do not substitute a checkout or a different root:

```sh
sudo /usr/local/bin/control-room rescue
```

If it prints `guard_refused:no_older_pair`, there is no earlier saved version/database pair to select. Stop and ask the lead for recovery; rerunning cannot create one.

A rescue switches Control Room back to a saved working version and its matching
saved database, then restarts and checks the local services. Allow about **19
seconds** for a successful rescue; a service that struggles to start can take
longer. Wait for the command to finish, then open Home and check that Control
Room is healthy, local services are running and the restored version is shown.
The command finishing alone is not proof that you can sign in or use the page.

An older database can lose work saved since that copy was made. If Terminal says
`This rescue selects an older database and loses newer data. Type YES to continue:`,
stop and check with the lead before typing `YES`.

If the saved copy fails its checks, Terminal prints this exact status:
`rescue stopped nothing and changed no selected version or database; current service state was not checked`.
Rescue did not stop services or change the selected pair. Services that were already stopped or broken may still be unavailable; have the lead check their current state. The next line starts `rescue cannot continue:`
and explains why. Keep both lines and show them to the lead; use the table below.
The file or folder name and the numbers in these messages vary.

| What you see after `rescue cannot continue:` | What to do |
| --- | --- |
| `… is missing` or `… is missing or empty` | The backup copy is incomplete. Stop; ask the lead to recover a complete saved copy. Repeating rescue cannot replace missing files. |
| `… is owned by uid …, but it must be owned by …` | The saved copy belongs to the wrong system account. Stop and ask the lead to check ownership. Do not change owners yourself or delete the copy. |
| `… is a link, not a real …`, `… is a file, but a folder is required`, or `… is not a regular file with content in it` | The saved copy has the wrong kind of file or folder. Ask the lead to check or replace it; do not bypass the check. |
| `the owner and permissions of … could not be read` or `the permissions of … could not be read` | Control Room cannot check who owns the copy or who can change it. Ask the lead to check access to the named item. |
| `… is mode …; a saved copy must not be group- or world-writable` | Other accounts can change the saved copy, or its permissions are unsafe. Ask the lead to repair the permissions before retrying. |
| `the postgres service definition … could not be read` | The database service settings cannot be read. Stop and ask the lead to check that service definition. |
| `the database account named in the postgres service definition could not be resolved to a uid` or `… did not resolve to a numeric uid` | The database service account cannot be identified. Ask the lead to check the account and service settings; another rescue attempt cannot repair them. |

A failure **after rescue starts** is different. Terminal says
`Rescue could not start or confirm service …; the same rescue can be retried.`
The named service did not start or could not be confirmed running. The version
and database may already have switched, and Control Room may be unavailable.
Keep the full message and ask the lead to fix that service, then retry the
**same rescue** when advised. It keeps the same saved version and database;
a retry does not step back to an even older copy.

### Finish updater recovery after rescue

Successful rescue leaves a recovery marker; it does not automatically clear updater uncertainty. Keep the rescue output. Before any new update, have the lead re-read the current updater status, selected version/database and service health, and check whether an update run is still active. Do not delete the marker or use a web action to clear it.

For the installed route, the explicit root fallback is:

```sh
sudo /usr/local/bin/control-room check-and-continue
```

Use it only after that current-state review. If no update run is active, the root action can clear an existing rescue/journal recovery state; it refuses when none exists. Clearing that marker is not a service-health test. With an active run, its lease must belong to this updater and it must be in a recoverable rollback or uncertain state. The command resumes rollback or measures the saved run, and clears recovery only after a confirmed terminal outcome. A missing or inconclusive measurement leaves recovery unresolved. Keep any refusal and have the lead investigate; do not repeat blindly or delete state files.

### Downgrade confirmation

Installing an older version, or one that cannot be verified as an advance from
your installed version, asks for **seven words**, not the ordinary six. Copy
exactly the phrase on Terminal's `Confirmation:` line: uppercase `DOWNGRADE`
followed by that plan's six words, in order. For example, the code can produce
`DOWNGRADE amber anchor apple arch arrow atlas`. This is only an example: the
six words change with the plan, so type the phrase on your own screen.

Confirm only if you intend that change and the lead has checked it. If you
mistype it, Terminal says `Those seven words did not match.` You get three tries
in total. Do not reuse words from another plan. This seven-word confirmation is
separate from the rescue's `YES` warning about losing newer data.

## What changed — 2026-10-02

The post-install instructions now describe the reviewed bot picker, including
waiting for offline bots, real-contact Last seen, rejection versus cancellation,
and connection recovery. These screen changes need to be included in your
installed update; the older-screen fallback remains above. See the
[Mac owner guide](OWNER_GUIDE_MAC.md#what-changed--2026-10-02) for attention,
unknown costs, phone controls and upgrade rescue.
