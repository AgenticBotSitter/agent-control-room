# Owner actions

Only steps the bots cannot do. Each item is numbered and copy-paste ready.

## 1. One-time Tailscale ACL edit for the private database route

**Status (2026-09-25):** needed. Revision 1 of `docs/claude/SECURE_DB_ROUTE.md`
assumed no owner action was needed here; live testing showed the Mac's tagged
device identity is not covered by the existing Tailscale SSH rule, so the
route was redesigned (see revision 2 in that file). The new route still keeps
PostgreSQL bound to the VPS loopback address and still never opens the
database port itself on the tailnet — but it does need one small, one-time
Tailscale admin-console change, because that policy file can only be edited
by a signed-in administrator.

What to do: sign in to the Tailscale admin console, open the ACL policy file,
and add **one** line granting `tag:general` (the Mac) TCP access to
`tag:control-room-vps` (the VPS) on the one new dedicated port Codex has set
up for the restricted database-only SSH forwarding account — Codex will give
you the exact port number to paste at that point, since it is not fixed by
this document. Do **not** touch the existing `ssh` policy stanza, and do not
grant access to port 5432 itself — the new rule targets only the new
forwarding port.

Everything else in the one-time setup (the dedicated VPS account, its SSH key
restrictions, the launchd tunnel on the Mac) is something Codex can do
without the owner. This is the one step that needs an owner's Tailscale
admin session.

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
