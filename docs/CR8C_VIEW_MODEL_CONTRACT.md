# CR-8C Completion Gate view-model contract

## Purpose

`src/completion-gate/v1/view-model.ts` is the read-only boundary between the CR-8B completion ledger and the Completion Gate interface. It makes quality review understandable without converting it into approval, execution authority, or an artifact download path.

## Allowed data

- immutable target identity, revision number, project, target kind, and SHA-256 digest;
- review, verification, finding, preference, and separate-approval status expressed as bounded labels, timestamps, and evidence digests;
- media metadata (MIME type, byte count, duration), diff metadata (file/add/delete counts), and report metadata (section count).

## Forbidden data and behavior

The strict input schema rejects unknown fields. Therefore it cannot carry a raw artifact, file path, URL, object locator, raw diff, report body, credential, session material, approval grant, or execution grant. Bounded display strings reject common secret-shaped values and `assertNoSecretMaterial` rechecks the parsed graph.

The resulting model always states:

- completion remains separate from consequential approval;
- it grants neither approval nor execution authority; and
- a recorded central decision still needs a separately signed node attestation before any approval-required effect.

`CompletionGatePanel` is a static read component. It renders no button, dispatch action, artifact reader, or raw locator. Preview cards show digest-addressed metadata only, even when the underlying target is media, a diff, or a report.

## Deliberate deferrals

Protected API transport, authenticated user identity, full protected artifact viewers, approval issuance, node-attestation presentation, and every live operation remain outside CR-8C-001. They need their own authority and security contracts before they can connect to this UI.
