# Marvin H2: website route inventory (P2/P4), read-only

Plan: `docs/MAC_LOCAL_CRITICAL_PATH.md`. Work in `~/work/acr-mac-local` and read files only.

## Scope
Cover every page and API route under `app/` and `private-app/`. Also cover the handlers in `src/web/v1/` that those routes call.

## For each route, record
1. The URL path.
2. What the owner does there. Use these journey steps:
   - sign in
   - project list
   - create project
   - create task
   - assign worker
   - approve
   - status
   - result
   - accept
   - request correction
   - cancel
   - worker status
3. The service function it calls, as a file and function name.
4. Its data source: `installed` (a real PostgreSQL service), `preview` (`app/local-preview`), or `fake` (repository fake or fixture).

## Report
- A table with one row per route.
- Then list the journey steps that have **no** installed route. Those are the gaps.
- At most 120 lines.
- Do not run the website or tests.
