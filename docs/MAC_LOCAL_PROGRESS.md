# Mac local build progress

Codex appends one short entry per work package (see `CODEX_MAC_BUILD_EXECUTION.md`).

- 2026-09-24 — Plan adopted. Integration branch pushed. Nothing operational yet.
- 2026-09-24 — W3 host-mode foundation: the launcher now recognizes the `mac-local` choice and accepts only the existing shared planning, approval, queue, result, and review components plus at least one local worker. It rejects the remote-only listener, session, evidence, HTTPS, and remote-worker components. Five launcher tests and the full TypeScript check pass. This is a configuration guard only: it does not load protected configuration, contact the database, start the website, or start a worker. Next in W3: the protected local configuration loader and the owner-trusted worker enablement record.
