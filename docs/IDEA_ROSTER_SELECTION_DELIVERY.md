# Idea Lab participant selection

The New Idea form now shows configured participants before saving. The owner can
choose three to six, including the skeptic required by the existing Idea Lab
contract. Names, perspectives and harness labels describe configuration, not
proof of a connected or authorized bot.

The form loads `/api/v1/ideas/options` through the normal protected application.
The operation requires existing owner create/read permissions and the scoped
workspace. It returns only safe display fields and a per-participant descriptor
digest. It does not return identity digests, connection addresses or credentials.
Options reads may register the normal web session but do not create ideas or work.

## Exact choice and recovery

New browser requests include `participantSelections`, an ordered array of configured
participant IDs and their opaque descriptor digests. The server reconstructs every
participant from its own configuration and rejects missing, duplicate, changed or
unknown entries. Clients cannot supply a new bot descriptor or change runtime
authority. Existing clients omitting selection retain the previous default-roster
behavior; the new form always sends its reviewed selections.

After a save succeeds, retry resolves against that saved roster rather than a
later deployment configuration. The same key cannot change the resulting session
digest. Browser uncertainty retains the exact original body/key; reading options
does not replace it, and options reload is disabled until the save is resolved.
If a fresh selection becomes stale, reload options, review the roster and explicitly
save again. No automatic save, provider call or new project is triggered.

## Integration and evidence

The existing task coordinator exposes the operation through its normal lifecycle
wrapper and verified Idea-creation pool. The website-only profile still does not
configure Idea creation or providers. No new role grant, migration, dependency,
host setup or production operation was introduced.

Local tests cover safe options, denied/logged-out access, mounted routes and
coordinator startup, three-of-four selection, stale descriptors, unchanged replay
after deployment changes, forged/duplicate/changed selections, and the existing
skeptic constraint. An injected start test records only the chosen three
participants and confirms replay makes no new calls. That is synthetic execution,
not live Hermes/Codex acceptance. Static rendering/client tests are not mounted
browser interaction proof. Independent backend and UI source reviews found no
concrete defect in the reviewed changes.
