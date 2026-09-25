# Owner actions

Only steps the bots cannot do. Each item is numbered and copy-paste ready.

## One owner action needed before the private database route

The owner-approved Tailscale SSH connection is working. Control Room's
database migrations and four restricted Mac-local login accounts are already
present on the VPS. The remaining W1 work is a secure, Mac-to-VPS database
connection that Codex must build and verify: a private Tailscale route, a
trusted database certificate, and a Mac-only network rule.

1. In the existing Chrome **Tailscale** tab, sign in to the Tailscale admin
   console and leave that tab open. Do not change a setting. Then reply
   **"Tailscale admin ready"** here. Codex will inspect the existing rule
   first and ask for confirmation immediately before any rule is changed.

The website must not be represented as connected until its four real login
checks pass.

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
