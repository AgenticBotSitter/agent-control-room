# Project, executor, provider, and node boundaries

## Project packs

A project pack describes bounded workflow knowledge and evidence expectations. The current public packages do not expose a project-pack publisher or loader. Keep project examples fabricated and free of host identity, destinations, private history, and production artifacts.

## Executors

Execution remains private. The public observation SDK intentionally has no start, steer, cancel, resume, command, or generic callback. A future executor package requires its own authority, idempotency, audit, recovery, and independent security contract.

## Provider adapters

Provider contact remains private and disabled. Do not add endpoints, account identifiers, access material, destination configuration, or provider clients to a public candidate.

## Node packages

Node enrollment, host identity, capability evidence, supervisor control, and protected storage remain outside the public candidate. A public node package cannot be derived from an observation adapter.

## Contribution rule

When proposing one of these future surfaces, begin with a new versioned contract and hostile conformance tests. Do not extend the observation SDK to bypass the missing authority boundary.
