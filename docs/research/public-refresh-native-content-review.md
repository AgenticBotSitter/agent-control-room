# Native source public-refresh disclosure review

## Result and exact scope

No embedded disclosure blocker was identified in the **25 changed/new source files (280,798 bytes: 14 new, 11 changed)** in the assigned native cohort. Each was read in full, using bounded, nontruncated content chunks; the final two schema files were re-read separately after a combined output was unavailable. This is an independent source-content observation, not final security, licensing or publication approval.

Selection came from `docs/research/public-refresh-build-closure.json`, private baseline `bc0a61a0fc22e1b58a5322bde52df8bf74ab9b5b`, restricted to `src/harness/`, `src/node-bridge/`, `src/node-control/`, `src/node-policy/`, and `src/node-protocol/`. Files identical to the isolated public-main worktree at `42ecea2` were excluded. The companion `public-refresh-native-content-review.json` records all exact paths, byte counts, SHA-256 hashes, baseline hashes where present, and individual `fullContentRead: true` observations. All 25 current hashes were rechecked against the closure manifest after full reading and matched.

The baseline comparison establishes which files are changed/new; it is not a full-content reread of their old public versions. Hash coverage must be recomputed if the export bytes change.

## Disclosure observations

- **Credentials:** No embedded passwords, private keys, usable bearer tokens, authentication cookies or real credential-store contents observed. `https-transport.ts` constructs authorization from supplied enrollment data; the header mechanism is code, not a shipped token. `server-node-session.ts` uses generated random values and injected signing material, not literal real keys.
- **Owner/customer data:** No concrete owner/customer identity, personal email, customer project content or saved agent transcript observed. Tenant/node/project identifiers are parameterized fields and validation rules. Treating those schema names as disclosed identities would be incorrect.
- **Private addresses and paths:** No concrete private host/IP, personal home directory or deployment-specific credential path observed. `private-native-configuration.ts` validates caller-supplied absolute paths and filesystem ownership/modes. Generic Unix/Windows path syntax and protocol routes are intentionally reusable architecture, not this owner's infrastructure.
- **Stored state:** `node-bridge/journal.ts`, `run-journal.ts`, and the admission/effect/execution stores contain SQL, serialization and validation behavior, not stored production rows. `:memory:` and the `durable-read-validation` sentinel are generic implementation values. This observation does **not** authorize exporting their runtime databases or journals.
- **Approval/policy contracts:** The owner-approval helpers and both schema files specify signed envelopes, key references, ceilings, lease identity, digests and expiry checks. Those are public parameterized mechanisms. No issued real attestation or private owner pin was embedded in these files.

## Attribution and release boundary

No copied-source copyright/license header or embedded upstream source attribution was observed in these exact 25 files. That absence is not proof of original authorship and does not waive an obligation attached to any separately known source derivation. No code or notice was removed during this review.

The cohort references Node standard modules, Zod and repository-internal modules; invoking these interfaces is not evidence that their implementation bodies are vendored here. Preserve the public project's existing Apache-2.0 `LICENSE` and project `NOTICE`, and preserve applicable third-party notices for the actual distribution. The public baseline `NOTICE` was read in full and its license heading checked; it explicitly retains third-party terms. `docs/PUBLIC_DEPENDENCY_LICENSE_STATUS.md` distinguishes source-only delivery from later generated/native artifacts and records dependency-notice work. This review does not repeat or replace that whole-deliverable dependency/provenance assessment.

Imported modules outside this exact cohort, packaged dependencies, generated bundles, private configuration, credentials, journals, logs and repository history are outside this content review. In particular, publishing the generic connector code does not make real profile/approval/enrollment files public-safe. No candidate execution, install, network access, service operation or source alteration was performed. Only this report and its companion receipt were added. Root retains final disclosure, attribution and publication decisions.
