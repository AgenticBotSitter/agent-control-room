# Project packs (v1)

Portable, inert project descriptors. A pack lets one Control Room
installation describe a reusable project purpose so another installation can
preview it locally before deciding to adopt anything. This is the effect-free
foundation for later community sharing (parent outcome #221). It is not a
marketplace, upload, installer, or project creator.

## Format

Schema id: `control-room.project-pack/v1`. Fields:

- `title` (1–120 chars), `summary` (1–2000 chars) — sanitized descriptive text.
- `optionalModules` — subset of the product-configuration module names
  (`ideaLab`, `news`, `sessionObservations`), in that canonical order.
- `setupGuidance` — up to 10 human-readable setup hints, each up to
  1000 chars.

Serialization is deterministic canonical JSON; identity is a domain-separated
SHA-256 digest (`sha256:` + hex) over `{namespace, value}` using the shared
`src/security/canonical-digest.ts` helper. A changed byte that changes meaning
changes the digest; key-ordering differences do not.

## Security boundary

- The export builder accepts only explicitly supplied descriptive fields. It
  never reads a project record and never copies runtime data.
- The parser fails closed on: malformed input, oversized fields, duplicate
  modules, unknown schema versions (refused visibly, never reinterpreted as
  v1), unknown keys, non-canonical module order, executable content (`<script`,
  `javascript:` URLs, inline event handlers, `$(` substitution),
  credential-shaped text (private-key armor, credentialed URLs,
  `key/secret/password`-style assignments), authority-shaped text (access/role
  grants, `sudo`/`chmod`-style commands, `role:` assignments), control
  characters, and prototype-pollution keys (`__proto__`, `constructor`,
  `prototype`) at any depth.
- Local resolution compares requested modules against the trusted local
  product configuration and returns a preview (supported, unsupported,
  warnings, proposed title/summary). It performs no write and grants no
  permission.

## Future catalog

A future catalog may store only these inert packs plus attribution/license
metadata, after separate review. Packs themselves carry no attribution,
identity, or executable material by design.
