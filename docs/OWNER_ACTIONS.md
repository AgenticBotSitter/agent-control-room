# Owner actions

Only steps the bots cannot do. Each item is numbered and copy-paste ready.

## 1. One-time Tailscale change for the private database route

**Status (2026-09-25):** needed, owner-approved plan (`docs/claude/SECURE_DB_ROUTE.md`
revision 3.1). **The VPS side is ready (2026-09-25); do this now.** Two parts, once:

1. **Tailscale admin console → Access controls.** Make two small additions
   and leave everything else, especially the `ssh` section, exactly as it is:
   - Inside the existing `"tagOwners": { ... }` block, add this line:
     ```json
     "tag:control-room-client": ["autogroup:admin"],
     ```
   - Inside the existing `"grants": [ ... ]` list, add this entry:
     ```json
     { "src": ["tag:control-room-client"], "dst": ["tag:control-room-vps"], "ip": ["tcp:5432"] },
     ```
     If your file has an `"acls": [ ... ]` list instead of `"grants"`, add this
     entry there instead:
     ```json
     { "action": "accept", "src": ["tag:control-room-client"], "dst": ["tag:control-room-vps:5432"] },
     ```
   The console checks the file when you save; if it reports an error, don't
   force it, and tell Claude or Codex what it says.
2. **Machines → the Mac mini → Edit ACL tags.** Add `tag:control-room-client`.
   **Keep `tag:general`.** Do not change the phone, PC, or VPS.

After this, no further Tailscale changes are needed for updates, migrations,
or certificate renewals. A future Control Room computer needs only step 2.

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
