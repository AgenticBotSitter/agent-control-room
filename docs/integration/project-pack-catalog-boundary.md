# Project-pack catalog boundary

A future free catalog stores packs, never authority. This file defines the
stable boundary that catalog must hold; the inert v1 format is specified in
`project-packs.md` and implemented in `src/project-packs/v1/project-pack.ts`.

## What a catalog entry may store

Exactly the reviewed v1 fields, nothing else:

- `schema` — the literal `control-room.project-pack/v1`. Unknown versions
  are refused visibly and never reinterpreted as v1.
- `title`, `summary`, `setupGuidance` — printable descriptive text under
  fixed ceilings, screened for credential-shaped, authority-shaped, and
  executable content.
- `optionalModules` — deduplicated, canonically ordered, drawn from the
  product-configuration module list. Unknown modules are refused.
- `attribution` (optional, ≤120 chars) — a source label such as a club or
  author name. Screened like all other free text.
- `license` (optional, ≤40 chars, SPDX-shaped) — a license identifier such as
  `MIT` or `CC-BY-4.0`. Shape-checked, never interpreted: the catalog does
  not grant rights, it records the author's declaration.
- The domain-separated digest (`projectPackDigestV1`) as the entry's stable
  identity. A changed meaning changes the digest; key-ordering differences
  do not.

Raw inputs over 65536 bytes are refused before any other check
(`project_pack_input_oversized`).

## What a catalog must never store or infer

Project IDs, tasks, results, reviews, credentials, worker identities, host
paths, credentialed URLs, authority grants, schedules, live connector
settings, database identifiers, executable code — or anything derived from
them. Prototype-pollution keys are refused at any depth.

## Preview before import

Import resolves a pack against the trusted local product configuration and
returns an inert preview: supported vs unsupported modules, explicit
`module_not_supported_locally:<module>` warnings, and the pack's
attribution/license for the human to read. Import creates no project and
grants no permissions. Unsupported modules warn; they never enable.
