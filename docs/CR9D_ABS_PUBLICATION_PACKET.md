# CR9D-ABS-070/080 owner publication packet

**Status:** Preparation accepted; CR9D-ABS-080 recorded `disabled`; not authorized or runnable against a public site
**Date:** 2026-08-29
**Contract:** `control-room-abs-news-publication/v1`
**Controlling decision:** ADR-061

## What exists now

Control Room can prepare one immutable publication package, bind it to an exact destination identity and article revision, run it through a protected at-most-once ledger, and prove the behavior against an injected fake destination. The fake destination has no network, credential, filesystem, deployment, or public-site client.

The current coordinator rejects configured-live destinations and owner-live authorization. Nothing in this block can mutate the ABS website.

CR9D-ABS-080 evaluated the required live evidence below and found every gate missing. The exact digest-bound disposition is recorded in `CR9D_ABS_080_DISABLED_DISPOSITION.md`. It records no attempt, no mutation, no effect, no retry permission, and no authority. A future owner-attended rehearsal requires a new current assessment; this disposition cannot be promoted into a pass.

## Publication package

Each package fixes:

- the exact project, story, and source-evidence digests;
- the exact draft artifact ID and digest without embedding the draft body;
- one content revision and content digest;
- the final title, URL slug, and bounded excerpt;
- the Completion Gate target, accepted-review digest, and named verification digests; and
- the preparation timestamp and package digest.

The package says that editorial acceptance was declared but also requires authoritative Completion Gate resolution before any live use. It contains no credential or draft body and grants no approval, execution, or publication authority.

## Destination and duplicate protection

A destination record freezes one exact public HTTPS origin, `/articles/` route prefix, adapter identity and release digest, environment, and credential-reference digests. The record itself is not authorization.

The publication request derives one stable destination idempotency key from the exact destination identity, final path, content revision, and content digest. Changing the revision, content, path, or destination changes the key. Changing only a delivery or request ID cannot create a second semantic publication.

Duplicate protection exists at two boundaries:

1. The protected Control Room ledger claims the stable publication identity before the adapter can run and returns terminal replay without a second call.
2. The destination adapter must independently absorb the same idempotency key and return the same destination truth.

Control Room does not claim exactly-once publication. If destination truth is uncertain after the pre-effect marker, the result is terminal ambiguity and no automatic retry is allowed.

## Required live evidence

Before an actual publication rehearsal can be eligible, all of these must be frozen and reviewed together:

- the exact real ABS public origin, route, destination identity, and adapter release;
- an immutable content artifact and exact publication package;
- authoritative resolution of the package's Completion Gate target, accepted review, and every required verification;
- a high-risk strong owner approval bound to the exact operation;
- a separately signed node attestation and ordinary node admission required by the core effect contract;
- credential-reference-only custody through the node-local broker, if the destination needs a credential;
- a destination adapter that supplies stable idempotency and independently verifiable receipts;
- timeout, cleanup, rollback/withdrawal, and ambiguity-reconciliation procedures; and
- a single-use owner-attended rehearsal window.

The repository does not yet contain that live adapter or its native qualification evidence.

## Terminal outcomes

- `succeeded`: the exact fake receipt and destination revision are recorded.
- `definite_failure`: the destination rejected the request before mutation; the result is terminal.
- `ambiguous`: the call crossed the marker but its truth is unknown, including malformed evidence, timeout, crash, restart, or transport uncertainty. It is never automatically retried.

Every terminal outcome has an authenticated cleanup receipt. Full terminal records remain available for replay. A later retention policy may compact them only under the existing CR-5C tombstone rules.

## Explicitly outside this packet

Public ABS website mutation, live destination credentials, DNS or HTTP activity, deployment, rollback execution, article withdrawal, analytics, social/newsletter publication, live source collection, provider calls, agent dispatch, and every other external effect remain separate gates.
