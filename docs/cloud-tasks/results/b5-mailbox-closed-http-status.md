# b5-mailbox-closed-http status

DONE

Reason: I added two tests, "B5 closed mailbox HTTP" refusal and in-flight drain. The focused run passed 3/3 and the full module passed 75/75 with 0 skipped. `tsc` (VPS project) exited 0. In a copied graph, removing the `handle` `need(!closed, "B5_DEVICE_CLOSED")` fence fails both new tests at their exact rejection assertions; the existing F03b test still passes under that mutation. Restoring the guard turned the copy green again. Details are in `docs/cloud-tasks/b5-mailbox-closed-http-findings.md`.

- Base: `6f18fd11c57bc90387b79c4b6c1629e6dfddd38e` (parent `9a8a5491da9b9dff1b47ef2486c6a2ccfdda61b3`)
- Implementation commit: `8af6c5d`

## Setup

- `git fetch origin cloud/queue`: exit 0. `git ls-remote --heads origin cloud/*`: exit 0. Claimed with `git checkout -B` plus `git push`: exit 0.
- `npm ci`: exit 1, because the repo has no package-lock.json (it uses pnpm).
- `pnpm install --frozen-lockfile` (pnpm 11.19.0, the repo's own lockfile): exit 0.
- Node v22.23.4.
- PostgreSQL: none installed, built or run. The task is pure unit/in-memory and forbids native PostgreSQL, so no PG17 checks apply, and no `builder` user or ownership handoff was needed. Tests ran as the container's current uid.
- Private-name guard: SKIP, because no list was configured.
