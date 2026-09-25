# Owner actions

Only steps the bots cannot do. Each item is numbered and copy-paste ready.

There is no owner action required to continue the Mac-local source build. The
owner approved the sanitized Claude review on 2026-09-24; it was completed and
approved without receiving credentials, protected configuration, database
values, or private-machine details.

## Optional: let Marvin perform free independent source reviews

The currently selected Marvin model is reached through OpenCode Go, which is
outside this Mac. The desktop safety boundary therefore requires a direct
owner decision before it may receive even the sanitized public Control Room
source for a bounded review. This is optional: Codex can continue building
locally without it.

The owner authorized sanitized-source reviews on 2026-09-24. The dedicated
`cr` profile was verified as free of the unrelated default-profile instructions,
but it currently has no usable OpenCode Go credential for the selected
`space-bunny-free` model. Codex did not fall back to another model or reuse the
unrelated default profile.

When ready, configure the existing OpenCode Go credential for the existing
`cr` profile through Hermes's normal credential setup. Do not put a key in this
repository or paste it into chat. Once that profile reports the provider as
available, Marvin may perform the already-authorized bounded reviews.

For future owners, reply in this chat with the following sentence if you want
those reviews:

> I authorize sharing sanitized Agent Control Room source with Marvin through OpenCode Go for bounded build reviews and source maps. Do not share credentials, protected configuration, private paths, or production data.

Future activation steps will be added here only when source work is complete
and a real, owner-attended action is necessary.
