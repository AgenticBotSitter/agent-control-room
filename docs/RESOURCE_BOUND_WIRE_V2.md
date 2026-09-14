# Resource-bound connector wire version two

**Status:** lead-owned protocol contract. The schemas in
`src/resource-bound-wire/v2` are effect-free building blocks. They are not
registered with a live node, queue, connector, or process-start path by this
change.

## Purpose

Project coordination can admit multiple workers only when every later step
retains the exact resource holder chosen by the canonical admission
transaction. A signed version-one delivery proves the older task authority,
but it does not name that resource holder. It must therefore remain historical
after resource-bound activation rather than being reinterpreted as permission
to start version-two work.

Version two carries this immutable pair through every relevant boundary:

- `resourceAdmissionId`: the server-created identity of the exact held
  admission;
- `resourceAdmissionDigest`: the digest of the exact tenant, project, job,
  attempt, lease, node, declaration, and admission identity defined by
  `projectWorkResourceAdmissionDigestV1`.

Both values are required. They are not browser inputs and they do not grant
authority by themselves.

## Version separation

Version two uses strict schemas, new schema literals, new negotiated feature
names, and new digest/HMAC purposes. Version-one objects fail version-two
parsing and version-two objects fail version-one parsing. A version-one
signature, approval, effect claim, receipt, current-admission record, or
activation cannot authorize a version-two start.

The native and Codex task payload digests include the exact resource admission
pair before the normalized operation digest and effect-claim key are produced.
Changing either resource value therefore requires a fresh canonical request and
fresh owner authorization; copying a later resource value onto an older signed
message cannot succeed.

## Required chain

The same pair must be preserved and checked across:

1. canonical project-resource admission;
2. queue intent and durable submission reference;
3. lease and start material;
4. execution binding and signed dispatch;
5. authenticated intake receipt;
6. current-admission evidence;
7. activation and exact start-admission evidence;
8. the node-private local-start binding.

Receipts and activations are evidence only. They do not independently grant
execution, retry, resume, thread-read, completion, quality acceptance, or
capacity release.

## Final current-holder check

The parallel wire contracts carry the expected resource pair; the live host
must still call its captured authenticated current-holder port immediately
before releasing native transport bytes. The returned proof is the strict
`control-room.current-resource-holder/v2` object from
`src/contracts/v1/project-coordination-boundaries.ts`. It must match the exact
run and start-authorization digest, report `held`, and be valid for no more
than ten seconds against the trusted clock.

Codex must repeat that check before workspace preparation, `thread/start`, and
`turn/start`. Native Hermes delivery must repeat it immediately before its
owned transport writes the start request. A missing, expired, substituted, or
retired holder refuses the start. It does not create a retry or reactivate an
old dispatch.

## Retirement

Disconnect, lease expiry, browser closure, transport receipt, result text, and
quality review do not retire the resource holder. Retirement requires the
exact authenticated process-retirement proof already defined by the shared
coordination boundary. The reserved no-start state remains unsupported.

## Integration order

1. Accept and merge the additive project-coordination backend from issue #175.
2. Persist the exact resource admission during the canonical claim
   transaction and construct the version-two queue/submission record.
3. Register version-two features only for a worker that explicitly advertises
   them; never downgrade or reinterpret an unstarted version-one record.
4. Add authenticated current-holder ports to the server and node compositions.
5. Wire native and Codex version-two delivery/activation/start paths.
6. Prove restart, disconnect, conflict, retirement, and mixed-version refusal
   with disposable data, then run separately authorized real PostgreSQL and
   physical connector acceptance.

Until those steps finish, the new modules prove serialization and matching
rules only. They do not claim that project coordination or parallel native
execution is live.
