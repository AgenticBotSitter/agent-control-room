# Owner actions

Only steps the bots cannot do. Each item is numbered and copy-paste ready.

## 1. Confirm the Mac's effective Tailscale tag

**Status (2026-09-25): RESOLVED. No action needed.**

The Mac's Tailscale client now reports both `tag:control-room-client` and
`tag:general`, verified from the Mac itself. The database files were
re-pointed afterwards and the four-role check passes, so the tag is doing
its job.

This item previously said the tag was not visible to the client and that the
database was still pointed at the old address. That is now history; see item
2 for the policy rule that completed the route.

Do not re-apply or re-check the tag unless a later update actually fails to
reach the database. Keep `tag:general` on this Mac. A future Control Room
computer needs the same approved client tag and no other change.

## 2. Confirm the tailnet policy really allows the Mac to reach the database

**Status (2026-09-25): RESOLVED. No further action needed on the grant.**

The owner applied the single rule letting `tag:control-room-client` reach
`tag:control-room-vps` on the database port only. Verified from the Mac
afterwards: the database port connects, and `mac:check-database` returned
`ok` for all four roles. Check 4 of `MAC_LOCAL_FINISH_PLAN.md` Phase 1 is
therefore a REAL pass, not a pending item.

The earlier diagnosis in this file is kept in the progress log rather than
here, because it is now history: the port was being dropped by the tailnet
policy, and adding the one rule fixed it. No SSH fallback was used, and no
password was moved or changed to make the connection work.

**Recorded for check 3 (owner-attested, not machine-verified):** the policy
diff is one new rule, from `tag:control-room-client` to
`tag:control-room-vps` on `tcp:5432`, with all existing rules unchanged. This
is the owner's attestation. It has not been machine-verified against the
served policy file, because the tailnet admin console is not reachable from
the Mac.

Do not re-open the policy. If a future update needs another machine on the
route, add the same approved client tag to that machine and nothing else.

## 3. W1 checks 7, 8 and 9 — owner or VPS operator

**Status (2026-09-25): pending. Check 4 and check 5 now pass, so only these
three remain for Phase 1 to close.**

**Check 7 — the leak test, and the one that matters most.** From the phone or
the PC (not the Mac), try to connect to the VPS on the database port. It must
**fail**. If it connects, the client tag is not the only path in and the
database is exposed off the Mac, which fails the whole route design. Report
only "connected" or "refused/timeout".

**Check 8 — restarts and sleep.** Three drills, then `mac:check-database` after
each, which must still print `ok` for all four roles:
1. Put the Mac to sleep and wake it, then run `pnpm mac:check-database <protected-root>`.
2. Restart PostgreSQL on the VPS.
3. Restart Tailscale on the VPS.
Steps 2 and 3 are VPS-operator actions and cannot be run from the Mac. If you
cannot reach the VPS operator, say so and this stays pending rather than
being marked passed.

**Check 9 — certificate renewal.** The VPS operator force-runs the certificate
renewal job. `mac:check-database` must still pass afterwards **with no
configuration change on the Mac**. If it only passes after editing the Mac's
protected files, that is a real defect, not a workaround.

Do not paste a password, access key, database address, MagicDNS name,
certificate, or terminal output here. Reporting the outcome of each drill in
one word is enough.

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
