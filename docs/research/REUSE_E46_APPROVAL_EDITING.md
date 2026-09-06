# E46 — approval editing continuity

2026-09-06. Local implementation; no deployment or native qualification.

Matching authorized task refreshes now retain the unsigned approval review and a
selected signed file in React memory. The UI hides that state while a fresh approval
read is unresolved. A failed approval read, saved receipt, changed project/task version,
changed input or attempt, inactive project, non-leased attempt, or deadline reached
at the server observation clears editing continuity. No browser storage is used.

The small editor helper is custom product glue: its comparison uses Control Room's
existing project/task/attempt and approval records. A new form framework or upstream
workflow engine would not supply these semantics. Existing browser transport and
server validation are retained without modification.

An asynchronous file read must match both the original review instance and its scope.
This prevents an old file from attaching to a newly prepared, otherwise identical
review. Selection ordering still fences older reads. UTF-8 content is bounded to
24,576 bytes and display names to 180 characters. No upload occurs until explicit save.

This comparison is not approval validation. It does not renew a lease or deadline,
sign permission, retry a command, or start work. Server validation remains authoritative
even if a deadline passes between fresh observations. Secure owner signing is still
not connected to the page. A missing parent detail hides the component; failed approval
reads clear its editor. Interactive browser event timing remains to be verified.

Verification: all 15 focused editor/client/panel checks pass, including same-scope review
replacement and changed/expired scope. TypeScript, targeted lint, production build and
all 35 compiled regressions pass. These are not a real browser file-selection test.
Explicit focused command: `pnpm run test:approval-editor`.

During registration, two existing `posttest` keys were discovered. JSON parsing kept
the later legacy list and silently discarded the earlier six reuse test files. Both
lists are now combined into one command, retaining every original path and adding
the editor tests and a script-key regression. No dependency/lockfile changes.
`pnpm run posttest` passes all 479 checks, with no failures or skips, including actual
installed queue-package simulations and the legacy checks. The script-inventory test
also passes independently after a lint-only regex spacing correction. Targeted lint
and whitespace checks pass. This does not claim the entire main `pnpm test` suite ran.

No downloads, provider calls, credentials, services, GitHub or production changes.
Real PostgreSQL, live agents, interactive UI and the broader completion program remain open.
