# Local pack browse-and-preview surface (issue #318)

Client-side-only surface for browsing a project pack pasted or loaded
locally. Nothing is uploaded, no project is created, no catalog or network
is contacted, and no executable content is evaluated.

## Pieces

- `src/project-packs/v1/browse-preview.ts` — `browseProjectPackV1` runs the
  canonical `parseProjectPackV1` / `previewProjectPackV1` unmodified through
  a call-scoped `Buffer` bridge: the parser measures bytes with
  `Buffer.byteLength`, which does not exist in browsers, so the bridge
  provides a `byteLength` shaped object backed by Web-standard `TextEncoder`
  for the duration of one synchronous call, then restores the prior global
  in a `finally` block. Byte ceiling (`project_pack_input_oversized` at
  65536 bytes) and every guard semantic are the parser's own.
- `private-app/app/project-pack-catalog-preview.tsx` — unwired presentational
  panel. Pure function of the browse outcome: ready previews render title,
  summary, guidance, attribution, license, and supported/unsupported module
  splits; refusals render a human sentence plus the canonical reason code.
  Inert by construction: no buttons create anything, nothing executes.
- `tests/project-pack-catalog-preview.test.tsx` — 9 tests, lane-registered
  in `test:contracts`. The canonical parser is exercised end to end with
  `Buffer` absent (the browser reality): valid pack, oversized refusal,
  executable-content refusal, distinct refusal rendering, inert preview.

## Refusal surface

Every canonical refusal maps to a human sentence via `refusalTextV1`; unknown
future codes fall back to `The pack was refused: <code>` so no refusal is
ever opaque. Empty input refuses with `project_pack_empty` before parsing.

## Limits

Preview-only: producing a real project from a pack, catalog listing, and
wiring the panel into a route are explicitly out of scope and remain
unbuilt. The `Buffer` bridge covers only the byte-length call the parser
makes; any future parser dependency on other Node globals needs its own
scoped bridge.
