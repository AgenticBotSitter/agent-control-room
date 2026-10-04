# E2E-2 real-root rehearsal

This is the practice half of one owner evening on an Apple silicon Mac. The install-night bootstrap refuses Intel or non-macOS systems with `bootstrap_platform_refused`; check this before scheduling the evening. The rehearsal never changes Tailscale, never switches tailnets, and never runs a Serve mutation command. Run the entire rehearsal and the real install from the owner's normal account in one Apple Terminal window. Run the live checks and isolated rehearsal blocks there in order; quit other Terminal windows if their shells are listed by the stopped-process check. The lead prepares one paste file; the owner pastes its labelled blocks. The owner, not the lead, enters the password for anything that invokes `sudo`.

The rehearsal is blocked until the installer reports the exact capability contract in this guide. A supported `--rehearsal-config` forces the installer's Serve capture, activation, and restoration steps to record `skipped (rehearsal)`. Do not substitute live names, edit generated JSON, or approximate missing controls with environment variables.

## Lead preparation

The lead stages the reviewed kit read-only at `/Users/Shared/control-room-e2e2/source` and a reviewed executable Node distribution at `/Users/Shared/control-room-e2e2/node/bin/node`. The staging folder `/Users/Shared/control-room-e2e2` itself must be writable by the normal owner account so the snapshot can be created. Every parent of the staged paths must be searchable by the owner. The staged source includes its `.git` directory. The guide does not use a checkout under another user's home and never changes global Git configuration.

The lead creates one file, `/Users/Shared/control-room-e2e2/INSTALL_NIGHT_PASTE.txt`, readable by the owner. It contains every block below with all lead-supplied values already filled in; the owner never edits or dictates a long command. It includes an owner variable header for every Terminal window, so opening a new window never depends on variables left in an old one. The lead pre-fills:

- `COMMIT40`: the reviewed 40-character commit on `main`;
- `REHEARSAL_TAILNET`: a reserved DNS identity containing a `rehearsal` label, with a different tailnet suffix from the live hostname; it is identity input only and is never selected or configured;
- `LIVE_PORTS`: every live listener, comma-separated (including 3310, 3311, and 7864 when those remain current);
- `LIVE_LABEL_PREFIXES`: every live launchd family, comma-separated (including `com.agent-control-room.,com.controlroom.` when those remain current);
- the exact root-owned rehearsal bootstrap and uninstall lines for `COMMIT40`;
- the exact live-install line, for use only after rehearsal PASS.

The lead confirms that `TMPDIR` is the system temporary directory, no prior rehearsal process is running, and the staged Node and source tree are readable by the owner. Before the evening proceeds, the owner runs `/usr/local/bin/tailscale status --json`; stop if it is missing, refuses, or prints a warning. The owner writes down the two private working-directory paths as soon as they appear. If a new Terminal window is opened, first paste the owner variable header from the same paste file; after the setup and before-snapshot steps, the lead adds the printed `REHEARSAL_TMP` and `SNAPSHOT_DIR` paths to that header before it is reused. No command below enables `errexit`; every refusal prints `STOP`, returns to the prompt, and leaves the Terminal window open.

## Commands, in order

### 1. Pause all bots

The lead stops every bot job. The owner or lead then turns Control Room's own bots to **Stop** and confirms that nothing bot-related is running. Before the password step, quit the Claude app and the ChatGPT app (Cmd-Q). Also quit Image Lab and ComfyUI (Cmd-Q) before the bot check. The lead is not available from here until the installer prints Ready (or rolls back). If something fails: do not retry, copy the last lines of the Terminal into a note, reopen Claude afterwards and show the lead.

Paste this read-only check from the lead's one paste file:

```sh
pause_bots_step() {
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  test -x "$NODE_BIN" && test -r "$KIT_ROOT/scripts/install/rehearsal/check-bots-stopped.mjs" || {
    printf '%s\n' 'STOP: staged Node or bot check is unreadable; show the lead after reopening Claude.'; return 1;
  }
  "$NODE_BIN" "$KIT_ROOT/scripts/install/rehearsal/check-bots-stopped.mjs" || {
    printf '%s\n' 'STOP: one or more bots may still be running; stop every listed bot and paste this check again.'; return 1;
  }
}
pause_bots_step
```

If a worker remains, the check lists its PID, parent PID, and its family. A process it cannot identify is listed as `unidentified` together with its real program and the folder it works in, so you can see exactly what it is. It never prints command arguments and never kills a process. Continue only after it prints `PASS: no codex/claude/hermes/opencode worker processes under the owner's uid. This check did not kill anything.` In plain words: **your Mac password is typed only after every bot has stopped**.

**The check denies by default.** Every process of your account may be a bot — quit it first — unless its real executable has Apple system signing evidence inside a System Integrity Protection (SIP) path or a verified code signature for a specifically reviewed browser, editor or terminal product. A folder called `.app`, a signing team by itself, a readable script, and a program's own display name cannot make it safe. Claude, ChatGPT, Image Lab and ComfyUI are not exempt. Node, Python, Ruby, Perl, Bun, Deno, Java and shells running scripts are listed, including generic modules such as `python -m pkg`, unless they belong to a verified reviewed app. The check's own process tree and the verified Apple shell chain connecting it to the reviewed terminal are exempt; other shells may need to be quit too. If you run the paste file from an unreviewed terminal, its shell chain will be listed too; the only reviewed terminals are Apple Terminal and iTerm at their reviewed bundle locations.

System-image treatment requires the exact Software Signing (or macOS Software Signing), Apple Code Signing Certification Authority, and Apple Root CA chain plus a 40-hex CDHash inside `/System` (excluding the writable `/System/Volumes/Data` volume), `/bin`, `/sbin`, `/usr` (excluding `/usr/local`), or `/Library/Apple`. The real path and unchanged mapped file must remain bound to that evidence. A Platform identifier is optional there only when one bounded `/usr/bin/csrutil status` read per check reports exactly `System Integrity Protection status: enabled.`. Disabled, custom or unrecognised status, warnings, and a missing, failed or timed-out tool all require the Platform identifier. The check then prints: “SIP is not fully on, so Apple background programs may be listed. Show the lead.” Copies in writable locations remain listed.

Family evidence still helps identify what to quit: `claude`, `codex`, `hermes` and `opencode` names in programs, scripts, bot homes or working folders. A process found only by the folder it works in — for example a project folder called `hermes-data` — is shown with its program and folder. Quit these programs; folders are left alone. An ordinary program without a verified exemption is listed as `unidentified`. If you recognise it, quit that program and paste the check again; if you do not recognise it, show the lead. The check never prints command arguments or kills anything.

The check uses the union of two process-list and kernel-file scans, then scans once more after signature verification. A process born during signature verification is also listed; new or changed executables receive no cached exemption. It includes processes born between those scans, even if only the kernel-file scan saw them. Missing executable evidence cannot produce PASS. Each command has a hard deadline, and the whole check has a 30-second deadline. If the Mac refuses inspection, the check refuses to continue.

The lead may pin the existing PostgreSQL executable in the install paste-file input as `postgresql: {"executable": "/absolute/reviewed/path/postgres", "sha256": "reviewed-full-file-sha256"}`. Only that exact real path, matching full-file digest and valid code signature is exempt. Without that reviewed configuration, PostgreSQL is listed too. Never replace a listed program with a different name to get PASS.

The rehearsal and live install commands repeat this same check immediately before the first privileged command in their own password block. An earlier PASS is not permission to enter the password later. Keep worker supervisors in **Stop** through Ready or rollback, and leave worker apps closed: a process check cannot prevent an arbitrary program from launching after its last scan.

### 2. Owner account: capture the live snapshot

Run this in the owner's normal account. It is the only identity-generation step that reads the owner's live Control Room files, listeners, Tailscale hostname, and Serve status. Paste the labelled snapshot block from the lead's paste file. Its three lead-supplied values—`COMMIT40`, `LIVE_PORTS`, and `LIVE_LABEL_PREFIXES`—are already filled in.

```sh
owner_snapshot_step() {
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  LIVE_SNAPSHOT='/Users/Shared/control-room-e2e2/owner-live-snapshot.json'
  test -x "$NODE_BIN" && test -r "$KIT_ROOT/scripts/install/rehearsal/live-snapshot.mjs" || {
    printf '%s\n' 'STOP: staged Node or rehearsal kit is unreadable; show the lead after reopening Claude.'; return 1;
  }
  cd "$KIT_ROOT" || { printf '%s\n' 'STOP: cannot enter the staged kit; show the lead after reopening Claude.'; return 1; }
  test "$(/usr/bin/git -c safe.directory="$KIT_ROOT" rev-parse HEAD 2>/dev/null)" = 'COMMIT40' || {
    printf '%s\n' 'STOP: staged commit does not match COMMIT40; show the lead after reopening Claude.'; return 1;
  }
  "$NODE_BIN" scripts/install/rehearsal/live-snapshot.mjs create \
    --live-ports 'LIVE_PORTS' \
    --live-label-prefixes 'LIVE_LABEL_PREFIXES' \
    --output "$LIVE_SNAPSHOT" || {
      printf '%s\n' 'STOP: owner live snapshot failed; leave any file in place and show the lead after reopening Claude.'; return 1;
    }
  /bin/ls -l "$LIVE_SNAPSHOT" || { printf '%s\n' 'STOP: cannot inspect the owner snapshot; show the lead after reopening Claude.'; return 1; }
}
owner_snapshot_step
```

Good: the command prints `OWNER LIVE SNAPSHOT SHA256: ...`; the file listing shows the snapshot. The hostname is read from real `tailscale status --json`, not typed. Write down the 64-character checksum as `LIVE_SNAPSHOT_SHA256`. The file contains only the normalized hostname, ports, labels, collision identities, Serve status, and source count. If the output file already exists, the command refuses rather than replacing it.

Keep this owner Terminal open. Replace `LIVE_SNAPSHOT_SHA256` below with the checksum just printed, then define the read-only check once:

```sh
serve_check() {
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  LIVE_SNAPSHOT='/Users/Shared/control-room-e2e2/owner-live-snapshot.json'
  cd "$KIT_ROOT" || { printf '%s\n' 'STOP: cannot enter the staged kit; show the lead after reopening Claude.'; return 1; }
  "$NODE_BIN" scripts/install/rehearsal/live-snapshot.mjs check-serve \
    --input "$LIVE_SNAPSHOT" --checksum 'LIVE_SNAPSHOT_SHA256' || {
      printf '%s\n' 'STOP: Serve, hostname, or the snapshot file changed; do not continue; show the lead after reopening Claude.'; return 1;
    }
}
serve_check
```

Good: `PASS: Serve and hostname unchanged; snapshot SHA256: ...`, with the same checksum the owner just wrote down.

### 3. Owner account: create the private working directory

Paste the labelled owner setup block. `COMMIT40` is already filled in. Paste the checksum just printed only into the short `LIVE_SNAPSHOT_SHA256` field.

```sh
owner_setup_step() {
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  LIVE_SNAPSHOT='/Users/Shared/control-room-e2e2/owner-live-snapshot.json'
  LIVE_SNAPSHOT_SHA256='LIVE_SNAPSHOT_SHA256'
  test -x "$NODE_BIN" && test -r "$KIT_ROOT/scripts/install/rehearsal/config.mjs" && test -r "$LIVE_SNAPSHOT" || {
    printf '%s\n' 'STOP: staged Node, kit, or owner snapshot is unreadable; show the lead after reopening Claude.'; return 1;
  }
  cd "$KIT_ROOT" || { printf '%s\n' 'STOP: cannot enter the staged kit; show the lead after reopening Claude.'; return 1; }
  test "$(/usr/bin/git -c safe.directory="$KIT_ROOT" rev-parse HEAD 2>/dev/null)" = 'COMMIT40' || {
    printf '%s\n' 'STOP: staged commit does not match COMMIT40; show the lead after reopening Claude.'; return 1;
  }
  umask 077
  REHEARSAL_TMP="$(/usr/bin/mktemp -d "${TMPDIR%/}/control-room-e2e2-owner.XXXXXX")" || {
    printf '%s\n' 'STOP: private working directory creation failed; show the lead after reopening Claude.'; return 1;
  }
  printf 'WRITE THESE DOWN NOW:\nREHEARSAL_TMP=%s\nLIVE_SNAPSHOT=%s\n' "$REHEARSAL_TMP" "$LIVE_SNAPSHOT"
}
owner_setup_step
```

Good: the exact two paths are printed and written down. The per-command `safe.directory` value is the exact staged path; no global setting or wildcard is used.

### 4. Owner account: verify the snapshot and generate the isolated identity

Paste block 4, “Generate the isolated rehearsal identity”; the lead has already filled in the rehearsal tailnet:

```sh
config_step() {
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  LIVE_SNAPSHOT='/Users/Shared/control-room-e2e2/owner-live-snapshot.json'
  "$NODE_BIN" scripts/install/rehearsal/config.mjs \
    --tailnet-name 'REHEARSAL_TAILNET' \
    --live-snapshot "$LIVE_SNAPSHOT" \
    --live-snapshot-digest "$LIVE_SNAPSHOT_SHA256" \
    --output "$REHEARSAL_TMP/rehearsal-config.json" || {
      printf '%s\n' 'STOP: checksum or isolated identity verification failed; show the lead after reopening Claude.'; return 1;
    }
  "$NODE_BIN" -e 'const c=require(process.argv[1]); console.log(JSON.stringify(c,null,2)); if(c.liveSourcesRead<1||c.liveSnapshotSha256!==process.argv[2]||c.missingInstallerFlags.length||c.tailscale?.mode!=="skip"||c.tailscale?.mutationAllowed!==false) process.exitCode=2' \
    "$REHEARSAL_TMP/rehearsal-config.json" "$LIVE_SNAPSHOT_SHA256" || {
      printf '%s\n' 'STOP: generated config failed inspection; leave it in place and show the lead after reopening Claude.'; return 1;
    }
}
config_step
```

Good: the generated config prints the same `liveSnapshotSha256` shown in the snapshot Terminal and `live sources read: N` where `N` is at least 1. The config reads the pinned snapshot rather than rediscovering live state. The printed identity has:

- root `/Library/Application Support/Control Room Rehearsal`;
- accounts `_controlroom_rehearsal`, `_crdb_rehearsal`, `_crbuild_rehearsal`;
- labels under `xyz.agentcontrolroom.rehearsal.`;
- ports 13210 and 13211;
- fresh database and software authenticator;
- `tailscale.mode` `skip`, `mutationAllowed` `false`, outcome `skipped (rehearsal)`;
- `missingInstallerFlags` `[]`.

The generator refuses a changed checksum, malformed snapshot, case/prefix/path variants, port overlap, the same tailnet suffix, or zero relevant live sources. `--no-live-install yes` exists only for a Mac known to have no live install; do not use it on this Mac.

### 5. Owner account: prove the installer supports the no-Tailscale contract

C6 must make the reviewed installer print its capability document without root or mutation:

```sh
capability_step() {
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  "$NODE_BIN" src/updater/v1/cli.mjs --print-capabilities > "$REHEARSAL_TMP/installer-capabilities.json" || {
    printf '%s\n' 'STOP: installer capability probe failed; keep both working-directory paths and show the lead after reopening Claude.'; return 1;
  }
  "$NODE_BIN" scripts/install/rehearsal/verify-capabilities.mjs --input "$REHEARSAL_TMP/installer-capabilities.json" || {
    printf '%s\n' 'STOP: installer does not meet the no-Tailscale contract; keep both paths and show the lead after reopening Claude.'; return 1;
  }
}
capability_step
```

Good: exactly `PASS: installer rehearsal capabilities include no Tailscale mutation`.

Mandatory stop: do not start the before snapshot unless both the config gate and this installer-reported capability gate pass.

### 6. Owner account: capture the before snapshot

```sh
before_step() {
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  SNAPSHOT_DIR="$("$NODE_BIN" scripts/install/rehearsal/snapshot.mjs before)" || {
    printf '%s\n' 'STOP: before snapshot failed; keep REHEARSAL_TMP and show the lead after reopening Claude.'; return 1;
  }
  test -n "$SNAPSHOT_DIR" && test -d "$SNAPSHOT_DIR" || {
    printf '%s\n' 'STOP: snapshot path is missing; keep REHEARSAL_TMP and show the lead after reopening Claude.'; return 1;
  }
  printf 'WRITE THIS DOWN NOW:\nSNAPSHOT_DIR=%s\n' "$SNAPSHOT_DIR"
}
before_step
```

Good: the snapshot is mode 0700 and records users with uid, groups with gid, real system launchd rows and disabled services, LaunchAgents, LaunchDaemons, sudoers, newsyslog, cron/at deny files, `/usr/local/bin`, Control Room roots, `tailscale serve status --json`, and `Self.DNSName`.

Mandatory stop: in the owner Terminal run `serve_check` again. Do not start the installer unless it passes with the original checksum. Stop on any error or pre-existing rehearsal artifact. Do not delete the snapshot.

### 7. Owner account: run the rehearsal installer

Quit Image Lab and ComfyUI (Cmd-Q), and any other bot program the installer lists, before pasting the install command. The check refuses with `STOP: bot worker processes are still running under the owner's uid:` while a listed process remains. Some entries show a program and folder because the check cannot identify them with certainty; it treats them as bots. Stop each listed process or quit its app, then repeat the check. If you do not recognise one, do not continue: show the lead after reopening Claude. The check never kills processes, and their folders are left alone.

Paste block 7, “Practice the install”, from the lead's paste file. It identifies `COMMIT40`, creates the required root-owned bootstrap folder, and passes the generated config plus the owner evidence directory. It must not contain a Tailscale command. You will be asked for the Mac password and then the read-only project token. Paste the token from your password manager; do not type it character by character.

```sh
install_step() {
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  COMMIT40='COMMIT40'
  "$NODE_BIN" "$KIT_ROOT/scripts/install/rehearsal/check-bots-stopped.mjs" --password-handoff || {
    printf '%s\n' 'STOP: processes may have started since the earlier check; quit every listed program first.'; return 1;
  }
  BOOTSTRAP_ROOT="$(/usr/bin/sudo /usr/bin/mktemp -d /var/root/cr-boot.XXXXXX)" || {
    printf '%s\n' 'STOP: bootstrap folder creation failed; show the lead after reopening Claude.'; return 1;
  }
  /usr/bin/sudo /bin/sh "$KIT_ROOT/scripts/install-night/bootstrap.sh" "$COMMIT40" "$BOOTSTRAP_ROOT" \
    --rehearsal-config "$REHEARSAL_TMP/rehearsal-config.json" \
    --fresh-database yes --authenticator software \
    --e2e2-evidence-log "$REHEARSAL_TMP/e2e2-evidence.jsonl" || {
    printf 'STOP: install failed. Preserve REHEARSAL_TMP=%s and SNAPSHOT_DIR=%s; show the lead after reopening Claude.\n' "$REHEARSAL_TMP" "$SNAPSHOT_DIR"; return 1;
  }
}
install_step || return 1
```

Good, in order (the evidence-only items are confirmed by the PASS table in step 8, not by invented screen messages):

1. the generated config already showed the rehearsal root, accounts, labels, ports, fresh database, and software authenticator before installer mutation;
2. it records Serve capture, activate, and restore as `skipped (rehearsal)` without invoking Tailscale;
3. the owner compares the commit with `COMMIT40` before typing the six confirmation words;
4. all three health samples pass;
5. the Face ID step needs nothing from you and no phone. The practice install has a built-in practice authenticator that does the phone's part by itself. Three lines appear on their own: `Practice install: no phone is needed for Face ID…`, then `Practice passkey code: ` followed by six letters and numbers and `(entered for you)`, then `Practice passkey registered. No phone was used.` Do not type anything. No QR code appears and Face ID is not requested. If you see a QR code, a `Type the 6-character code` prompt, or `Practice passkey did not register`, stop and show the lead after reopening Claude;
6. owner-owned mode-0600 journal and evidence copies appear under `REHEARSAL_TMP`.

Mandatory stop immediately after the installer returns: in the owner Terminal run `serve_check`. Do not collect evidence unless it passes with the original checksum. Stop on a refusal, a live name, a Face ID prompt, a skipped Seatbelt check, fewer than three health samples, any Tailscale mutation command or non-skip outcome, or a QR code or a typed-code prompt in the Face ID step. Do not improvise cleanup.

### 8. Owner account: collect the installation evidence

```sh
collect_step() {
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  "$NODE_BIN" scripts/install/rehearsal/collect-results.mjs \
    --journal "$REHEARSAL_TMP/installer-journal.jsonl" \
    --evidence "$REHEARSAL_TMP/e2e2-evidence.jsonl" \
    --output "$REHEARSAL_TMP/e2e2-results.md" || {
      printf 'STOP: evidence failed. Preserve REHEARSAL_TMP=%s and SNAPSHOT_DIR=%s; show the lead after reopening Claude.\n' "$REHEARSAL_TMP" "$SNAPSHOT_DIR"; return 1;
    }
}
collect_step
```

Good: `Overall: **PASS**` and every row says `PASS`. The collector refuses root-owned, group-readable, mixed-transaction, stale-root, stale-commit, missing, duplicate, skipped, or false evidence. Mandatory stop: in the owner Terminal run `serve_check` again before uninstall.

### 9. Owner account: validate the target, then uninstall the fresh rehearsal

Before invoking `sudo`, validate the literal target in the lead's line is exactly `/Library/Application Support/Control Room Rehearsal`. The C6 uninstall must itself refuse any root other than the authenticated rehearsal config root.

```sh
uninstall_step() {
  REHEARSAL_ROOT='/Library/Application Support/Control Room Rehearsal'
  setopt localoptions pipefail
  /usr/bin/sudo "$REHEARSAL_ROOT/runtime/node-current/bin/node" \
    "$REHEARSAL_ROOT/updater/current/bin/control-room.mjs" uninstall-fresh \
    --rehearsal-config "$REHEARSAL_TMP/rehearsal-config.json" \
    --invoking-user "$(/usr/bin/id -un)" --invoking-uid "$(/usr/bin/id -u)" --invoking-gid "$(/usr/bin/id -g)" \
    | /usr/bin/tee "$REHEARSAL_TMP/uninstall-output.txt" || {
    printf 'STOP: uninstall failed. Preserve REHEARSAL_TMP=%s and SNAPSHOT_DIR=%s; show the lead after reopening Claude.\n' "$REHEARSAL_TMP" "$SNAPSHOT_DIR"; return 1;
  }
  UNINSTALL_OUTPUT="$(/bin/cat "$REHEARSAL_TMP/uninstall-output.txt")"
  printf '%s\n' "$UNINSTALL_OUTPUT"
  RETAINED_ROOT="$(printf '%s\n' "$UNINSTALL_OUTPUT" | /usr/bin/sed -n 's/^Fresh install removed\. Retained at \(.*\)\.$/\1/p')"
  case "$RETAINED_ROOT" in
    '/Library/Application Support/Control Room Rehearsal.uninstalled-'????????T?????????Z) ;;
    *) printf 'STOP: retained path is invalid. Preserve REHEARSAL_TMP=%s and SNAPSHOT_DIR=%s; show the lead after reopening Claude.\n' "$REHEARSAL_TMP" "$SNAPSHOT_DIR"; return 1 ;;
  esac
}
uninstall_step
```

Stop if the path is empty, names the live root, or does not have the exact rehearsal prefix and UTC timestamp shape. Mandatory stop: in the owner Terminal run `serve_check` again before the final system diff.

### 10. Owner account: capture the after snapshot and compare

```sh
after_step() {
  NODE_BIN='/Users/Shared/control-room-e2e2/node/bin/node'
  KIT_ROOT='/Users/Shared/control-room-e2e2/source'
  "$NODE_BIN" scripts/install/rehearsal/snapshot.mjs after --state "$SNAPSHOT_DIR" --retained-root "$RETAINED_ROOT" || {
    printf 'STOP: final diff failed. Preserve REHEARSAL_TMP=%s and SNAPSHOT_DIR=%s; read diff.json and show the lead after reopening Claude.\n' "$REHEARSAL_TMP" "$SNAPSHOT_DIR"; return 1;
  }
}
after_step
```

Good: exactly `PASS: system diff empty; retained root ...`. The original rehearsal root is absent, the one new retained root is present, and all system surfaces are unchanged.

Mandatory final stop: in the owner Terminal run `serve_check` once more. Serve status and `Self.DNSName` must still match the owner-created snapshot. Stop on `snapshot_diff_not_empty`; read `$SNAPSHOT_DIR/diff.json` for added and removed items. Do not repair anything during the evening.

### 11. Begin the live install

After the practice installer prints Ready (or rolls back), reopen Claude. The lead reads the PASS table and empty diff from the screen. Only then may the owner quit Claude and ChatGPT again and paste the separately supplied live-install line. In plain terms, that live install moves the usual `:443` phone address from the old Control Room on port 7864 to the new Control Room on port 3210; the separate `:8443` preview stays on port 3310. A failed pre-health install restores exactly the old `:443` target and leaves `:8443` alone. Keep the private evidence and retained rehearsal root until the lead records the outcome. Never switch tailnets during this procedure.

## Exact C6 installer contract

`src/updater/v1/cli.mjs --print-capabilities` must exit 0, write JSON only to stdout, perform no privileged check or mutation, and include at least this exact structure:

```json
{
  "schema": "control-room.installer-capabilities/v1",
  "version": 1,
  "rehearsal": {
    "config": "control-room.e2e2-rehearsal-config/v1",
    "freshDatabase": true,
    "softwareAuthenticator": "es256-fixed-v1",
    "evidence": "control-room.e2e2-evidence/v1",
    "ownerReadableEvidence": true,
    "tailscale": {
      "mutationAllowed": false,
      "capture": "skipped (rehearsal)",
      "activate": "skipped (rehearsal)",
      "restore": "skipped (rehearsal)"
    }
  }
}
```

When `--rehearsal-config` is present, C6 must validate the config before the first mutation, bind it to the transaction, and make the Serve capture, activation, and restoration branches structurally unreachable. Each branch must emit exactly one evidence row with kind `tailscale-step`, step `capture`, `activate`, or `restore`, and outcome `skipped (rehearsal)`. It must never invoke `tailscale set`, `up`, `serve`, or `funnel` in rehearsal mode.

Every journal and evidence row copied for collection must carry the same `transactionId`, rehearsal `root`, and `commit`. C6 must create owner-owned mode-0600 copies named `installer-journal.jsonl` and `e2e2-evidence.jsonl` in the authenticated owner evidence directory; the root-only originals remain protected. The bootstrap must preserve `--rehearsal-config`, explicit `--fresh-database yes`, `--authenticator software`, and the evidence destination. Uninstall must authenticate the same config and refuse another root.
