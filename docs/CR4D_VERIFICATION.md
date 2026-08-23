# CR-4D verification

Run from the repository root:

```bash
pnpm db:verify
pnpm test
pnpm check
pnpm lint
pnpm test:build
```

The CR-4D test suite proves that audit events chain per tenant/month, replay safely, reject altered event IDs and secret metadata, resist row mutation through the append-only trigger, verify against the durable chain head, and accept only an anchor matching the locked current head. It also proves that projection-originated audit writes use the same chain and that production configuration fails closed.

Before production, repeat the tests against a disposable real PostgreSQL instance and add a crash/restart rehearsal around event/head updates and anchor publication. Do not treat an unanchored local chain as protection against a database-superuser rewrite.
