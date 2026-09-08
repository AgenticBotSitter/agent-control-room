# Actual build notice omissions: reuse existing evidence

2026-09-08. Root read-only reconciliation against the completed staged build's
actual per-environment callback records. No build rerun, download, package mutation
or release assembly. Staging root retained temporarily for independent review.

The actual build reports21 unique name/version identities. Four have no full
license text from the plugin. **All three third-party omissions already have
retained original texts**; no new license search or replacement collector is needed
merely because package-root filename discovery omitted them.

| Actual missing record | Environments | Reuse source and verified exact text |
| --- | --- | --- |
| @vitejs/plugin-rsc0.5.26 | client, RSC, SSR | `docs/research/pinned-upstream-notice-texts.json`, commit65d378fc4d9bd8d383dc7598817261b3bdcb0861,1103bytes, SHA25629b68325fe026047d13e187b44c33b2acacf7dc647dec4583702e59f235e13b5 |
| postgres3.4.7 | RSC | Same retained index, commit9b92b65da6a5121545581a6dd5de859c2a70177f,1212bytes, SHA256b5065838cbac452dfc855ba6e6e031481ad2c68406f70d21ead9321374653e6c |
| @nodable/entities3.0.0 | RSC | `f9-entities-MIT.txt`,1064bytes, SHA256750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40; retain source manifest2.2.0 versus registry3.0.0 discrepancy documented in entities follow-up |
| control-room0.1.0 | client, RSC, SSR | Explicit project-license/NOTICE packaging, not a third-party text fetch. Staging deliberately omitted notice inputs; this result does not adjudicate the original project's complete licensing. |

The root check matched exact name/version from actual callback records, verified
retained text byte counts/hashes and located the three original sources. It does
not prove whole published-package/source equivalence for postgres or plugin-rsc;
their retained provenance qualifications remain. A checksum confirms unchanged
evidence, not independent legal clearance.

## Concrete implementation direction

Use actual rollup-plugin-license records for bundled package discovery. Configure
separate environment instances and collect all callbacks; an early empty callback
must not erase a later populated one. Deduplicate by exact identity and text digest,
reject conflicting texts and resolve only named, pinned exceptions from retained
evidence. A missing file must never silently become a newly written generic license.

Keep three explicit additional inputs:

1. The chosen original project license/NOTICE and copied Control Center file map.
   A project package record does not automatically attribute the borrowed modules.
2. Installed external-runtime closure from the selected prepared pnpm graph and
   text gatherer. The staged field named `externals` also contains internal chunk
   filenames; do not use it as a verified dependency set.
3. Copied/embedded code and emitted CSS/favicon/other assets with provenance. An
   artifact checksum is not ownership or license evidence.

Reuse existing text/hash/index primitives plus maintained plugin/collector APIs.
Do not add another generic graph walker, replace working build tools, or redownload
resolved texts. No need to repeat the successful application build to establish
these three source locations.

The release acceptance batch must still exercise final assembly with missing-text,
changed-hash, conflicting-record, stale-lock/build, omitted copied-file and external
closure negatives, and include the actual resulting notice files in the distribution.
The current113-file artifact hash inventory is a research result, not a published or
notice-complete release. Independent full-build review remains pending.
