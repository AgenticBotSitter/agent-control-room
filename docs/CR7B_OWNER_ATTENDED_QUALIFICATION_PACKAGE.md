# CR-7B owner-attended qualification package

**Status:** Preparation contract only. This document does not authorize key creation, service installation, credential access, network changes, a native process, or a provider call.

## Purpose

This package defines the exact handoff between effect-free repository proof and one later owner-attended native qualification. A native attempt may begin only after independent review accepts the repository implementation and the owner separately approves the named host operations.

## Package contents

The reviewed package must pin all of the following before any host change:

1. repository revision and clean-tree evidence;
2. signed Codex binary version and CodeDirectory hash;
3. exact broker, executor, and native-collector service definitions;
4. owner public-key fingerprint and qualification identifier;
5. revision-one trust-pin manifest digest;
6. private database locations for the credential ledger, replay guard, and trust-pin chain;
7. disposable profile and empty-workspace targets;
8. broker-only provider destination and executor-deny network policy;
9. maximum calls, duration, input bytes, and provider-enforced output tokens;
10. sanitized evidence schema, cleanup targets, and rollback owner.

Any missing, changed, or unreviewed value stops the attempt. Repository fixtures, generated test keys, topology declarations, and self-reported process identity are never accepted as owner trust.

## Approval stops

The owner must approve each group separately and may stop after any group:

| Stop | Owner-authorized action | Must remain forbidden |
|---|---|---|
| A | Create or select distinct broker, executor, collector, and owner signing identities | Reading or recording private-key material |
| B | Create private state directories and install reviewed service definitions | Starting services or changing network policy |
| C | Apply reviewed broker egress allowlist and executor egress denial | Provider calls and credential access |
| D | Load services and collect signed identity/readiness evidence | Model turn, workspace write, or production effect |
| E | Create one disposable profile and empty Git workspace | Reusing a normal profile or project checkout |
| F | Make the exact approved read-only provider call | Additional calls, tools, MCP servers, plugins, or writes |
| G | Stop services and remove only the exact disposable targets | Broad or recursive cleanup outside those targets |

An earlier approval does not imply a later one. The owner must be present at the attached Mac Terminal for owner phrases, Keychain prompts, and service-control confirmation. An agent cannot supply or claim those actions.

## Preflight acceptance

Before Stop D or later, the operator and reviewer must confirm:

- the owner-signed manifest is active, unexpired, revision one for this qualification, and stored in the private durable registry;
- database and parent-directory ownership/modes are private and their real-path identities match the reviewed package;
- broker, executor, and collector keys are distinct and match the manifest fingerprints;
- the executor cannot read broker credentials, credential ledger, replay database, or trust-pin database;
- only the broker can reach the exact provider destination, while the executor has no provider egress;
- the app-server child and remote executor launch specifications match their reviewed digests;
- replay and provider-call ledgers are empty for the new qualification;
- cleanup targets do not contain, equal, or resolve through the repository, user home, normal Codex profile, or another live workspace;
- the qualification bundle verifier still returns `nativeQualificationAuthorized: false` until real signed evidence is supplied and separately accepted.

## Native evidence required

One successful attempt must produce only sanitized evidence:

- active trust-manifest digest and revision;
- mutually authenticated channel-binding digest;
- signed native child/path evidence digest;
- provider hard-output-authority digest;
- executor turn-receipt digest with exact terminal truth;
- atomic qualification-bundle digest;
- confirmed provider-call count and terminal ledger disposition;
- confirmed remote cancellation and descendant absence when cancellation is exercised;
- exact cleanup result for the disposable profile and workspace.

Prompts, responses, commands, raw paths, raw host identity, raw thread/turn IDs, credentials, private keys, rollout data, and service logs must not enter retained evidence.

## Stop and rollback rules

Stop immediately on signature drift, identity mismatch, stale evidence, replay, clock regression, unexpected service output, readable credentials or private state, missing provider hard limit, executor egress, uncertain thread ownership, unconfirmed cancellation, cleanup ambiguity, or any unreviewed prompt.

After a stop:

1. make the provider call terminally ambiguous when completion is not proven; never redispatch it;
2. tombstone every uncertain provider thread before clearing its raw broker-private handle;
3. record and apply an owner-signed terminal revocation manifest when a pinned identity or key may be compromised;
4. stop only the package services using owner-attended controls;
5. remove only the exact disposable profile and workspace after real-path and device/inode revalidation;
6. retain only bounded safe codes, digests, counts, and cleanup truth;
7. return to independent review before another attempt.

Deleting or replacing the complete trust-pin database can roll its local history backward. Native deployment therefore requires the separately owner-signed high-water checkpoint defined by `isolated-trust-high-water.ts` to be stored and supplied by an owner-controlled source outside that database. The repository verifier detects rollback and substitution but deliberately does not pretend to provide the independent native storage.

## Advancement rule

Completing this checklist does not itself pass CR-7B. Codex must compare the signed native bundle to the reviewed package, an independent reviewer must accept the evidence and rollback result, and the build record must explicitly change the native gate. Until then, Codex execution remains disabled.
