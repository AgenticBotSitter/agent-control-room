# b8-default-start status
Phase: PLAN
Base: cloud-base/b8-default-start 174c5da122c2d9bf8ee470e95cb6c5b4dce302b9 (source cook/b7-providers 412d0c149fe8e272c491900d7a9164f80ecb612a)
Candidate: HEAD (full SHA in final handoff)
Spec gate: pending
Budget: 2026-11-04T15:51:34Z start, 2026-11-04T17:51:34Z deadline, about 15 minutes elapsed at handoff
Completed: D01b spec r1.1 covering items 1–8. Default pointer migration and down with a composite RESTRICT FK. Exact GET, PUT and POST `/default` API with version-0 ordering. Result grammar widening. One editPut alternative. Editable-Start flow over U81, U82 and D01a. Future BUILD tests T/N/P/B, probes G1–G10 and commands. Native packet Q1–Q4. Decisions D1–D10.
Checks: b8-default-start-evidence.md §2. git diff --check exit 0; ancestry exit 0; 27/27 cited paths; scripts verified; private-name check SKIPPED (no list); public-text scan clean.
Reviews: Claude plan-review helper on b9b09640: HIGH 1 / MEDIUM 6 / LOW 4, all fixed in r1.1 (evidence §4). No open findings. Not a substitute for Sol.
Pending qualification: PG17-later for P1–P13. PG17 was not obtainable here (proxy 403); only PG16.15 is present and it was unused. Also pending: native Q1–Q4 and the `:real` lanes; device evidence; R62/P72; Node 22 Linux CI parity. BUILD prerequisites: U81, U82 and D01a released, including the `loop_selection.manage` authority definition.
Owner questions: none (b8-default-start-owner-questions.md)
Next action: Sol spec review
Setup: pnpm install --frozen-lockfile exit 0 (npm ci exit 1, no npm lockfile); PostgreSQL 17 NOT obtained (apt and source both blocked by proxy); fallback PostgreSQL 16.15 from Ubuntu packages, unused; PG17 checks were NOT run.
Cleanup: no owned processes; temporary PGDG source removed; checkout contains only the allowed result files.
Status: PLAN-READY
