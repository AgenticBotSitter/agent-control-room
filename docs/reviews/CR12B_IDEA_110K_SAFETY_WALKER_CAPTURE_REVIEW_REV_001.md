# CR12B-IDEA-110K safety-walker capture independent review — REV-001

**Disposition:** `remediation_required`

**Reviewed product commit:** `2aa4f8e0dce52045100a2a10394d86bb934df93e`

**Review checkout head:** `4efd764`

**Frozen packet SHA-256:**
`8a5d2f18615f796dcedef27dc004e7720aa26c18a337e8592d24d93cc4f72296`

## Independence and effect boundary

The completed reviewer was different from every IDEA-110F through IDEA-110K contributor and prior completed reviewer.
Two earlier replacement-review attempts were stopped by the platform before producing evidence and do not count. The
completed reviewer made no repository edit, commit, push, install, download, network request, native launch, provider
call, credential access, or external effect.

## Findings

### CR12B-110K-REV001-FINDING-001 — High — captured regex methods still dynamically resolve mutable exec

**Exact source:** `src/security/redaction.ts:17`, `src/contracts/v1/validators.ts:120`, and
`src/idea-lab/v1/exact.ts:11` at the reviewed commit.

**Reproducible input:** After module import, replace `RegExp.prototype.exec` with a function returning `null`, then pass
`api_key=unsafe-value-123` through no-secret assertion, safe projection, redaction, and the shared exact parser. Repeat
with a selective replacement through the actual connector prompt path. A throwing replacement supplies a unique
sentinel and is retained through cleanup.

**Observed result:** Both assertions returned, redaction retained the secret, and the exact parser returned it. The
selective connector reproduction reached private open, session-create, and prompt-submit calls. A throwing replacement
escaped its exact sentinel, and the same dependency could stop cleanup dispatch.

**Violated invariant / affected boundary:** Capturing `RegExp.prototype.test` or `[Symbol.replace]` is insufficient
because those standard methods still dynamically resolve `exec`. Secret detection, safe projection, exact error
classification, schema validation, connector prompt admission, provider-result filtering, and cleanup can all change
after import.

**Missing regression:** IDEA-110K replaced `test` and `[Symbol.replace]` but never replaced `RegExp.prototype.exec` with
dishonest and throwing implementations through direct and end-to-end paths.

**Smallest safe remediation:** Capture `RegExp.prototype.exec` and invoke it directly for pattern checks; structurally
avoid regex replacement for key normalization; replace Idea Lab Zod regex/datetime refinements with captured guards;
and add direct, prompt, provider-result, error-classification, and cleanup regressions.

### CR12B-110K-REV001-FINDING-002 — Low — indexed redaction materializes sparse-array holes

**Exact source:** `src/security/redaction.ts:85` at the reviewed commit.

**Reproducible input:** Redact an array whose length is one and which has no own index zero.

**Observed result:** The input had no own index zero; the output had an own index zero with value `undefined`.

**Violated invariant / affected boundary:** Replacing array `map` with unconditional indexed assignment changed ordinary
sparse-array topology, enumeration, and structural equality.

**Missing regression:** No sparse-array topology test existed.

**Smallest safe remediation:** Preserve length and define projected indexes only when the source owns that index, using
captured descriptor operations.

## Verification

Stage zero, TypeScript, lint, CR12B 163/163, the complete npm lifecycle, production build, 3/3 rendered routes, all 32
migrations/110 PostgreSQL tables, and whitespace validation passed. Passing producer checks do not override either
finding. IDEA-110K remains rejected and grants no connector, native, provider, live-panel, deployment, or production
authority.
