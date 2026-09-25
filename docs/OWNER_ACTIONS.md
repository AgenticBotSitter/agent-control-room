# Owner actions

Only steps the bots cannot do. Each item is numbered and copy-paste ready.

## 1. Confirm the Mac's effective Tailscale tag

**Status (2026-09-25):** the owner reports that the policy grant and Mac tag
were applied. However, the Mac's last successful local status read showed
`tag:general` but not `tag:control-room-client`. The protected database files
are therefore still pointed at the old loopback tunnel address. No route or
database change was made. Do not edit the policy again unless its current
contents show the grant is missing.

Before the Mac database can be re-pointed, the owner needs to make the already
approved tag assignment visible to the running Tailscale client (for example,
refresh the Mac's Tailscale status after confirming the assignment in the
admin console). Keep `tag:general`; do not change the phone, PC, or VPS. Then
ask Codex to rerun the no-SSH `--repoint-only` step. If the client still does
not show the tag, stop and report the mismatch rather than restoring SSH or
changing the policy.

After the tag is effective, no further Tailscale changes are needed for
updates, migrations, or certificate renewals. A future Control Room computer
needs the same approved client tag.

Do not paste a password, access key, database address, certificate, or
terminal output here.

## Optional: let Marvin perform free independent source reviews

The currently selected Marvin model is reached through OpenCode Go, which is
outside this Mac. The desktop safety boundary therefore requires a direct
owner decision before it may receive even the sanitized public Control Room
source for a bounded review. This is optional: Codex can continue building
locally without it.

The owner authorized sanitized-source reviews on 2026-09-24. The dedicated
`cr` profile has no separate OpenCode Go entry, so Hermes correctly reads the
existing main Hermes credential pool as its read-only fallback. On that date,
the profile reported OpenCode Go as logged in and a minimal Marvin connection
check succeeded with `space-bunny-free`.

**No additional key, key copy, or chat message is needed.** Do not put a key
in this repository or paste it into chat. If the existing Hermes sign-in is
ever removed or expires, restore it through Hermes's normal sign-in flow; the
`cr` profile should continue to inherit it unless the owner deliberately adds
a profile-specific credential.

For future owners, reply in this chat with the following sentence if you want
those reviews:

> I authorize sharing sanitized Agent Control Room source with Marvin through OpenCode Go for bounded build reviews and source maps. Do not share credentials, protected configuration, private paths, or production data.

Future activation steps will be added here only when source work is complete
and a real, owner-attended action is necessary.
