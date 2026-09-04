# CR13A-LIVE-220 unwired native issuer implementation acceptance

**Status:** independently accepted for ordinary owner-controlled integration of unreachable code
**Product target/tree:** `2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9` /
`bf01065eec3e66d59fbbb85be9cf792243a89113`
**Design parent:** `09e42eded661d480227325344dd9b2cabfd68b25`
**Accepted LIVE-210 product:** `c4cac41561214117161c9764604f5dc06ecd63b6`
**Accepted LIVE-210 review SHA-256:**
`c25e22dfa2c8601b23547a8a6f32b68d78da23458a696cd9461678ce084ec2c7`
**Accepted LIVE-220 review SHA-256:**
`4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30`
**Model/effort:** `gpt-5.6-sol`, `xhigh`

## Outcome

The product adds the isolated native issuer code boundary without making it callable. It captures exactly five
`node:net` primitives at module initialization and contains one fixed IPv4-loopback, one-server, one-listen, one-close
implementation behind a private `WeakMap`. The factory is stored once, never retrieved, never exported, and absent from
the safe barrel and every application/runtime consumer.

The only public construction path fails with `native_issuer_unavailable` before native behavior. Its frozen status tells
the exact negative truth: no host or port was observed, no server was created or retained, no handoff was issued or
spent, no adapter or driver was called, and no listener, persistence, timer, network, protected-read, wiring, effect,
blocker, candidate, activation, or authority state exists.

## Producer verification

Exact product `2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9` passed macOS stage zero, TypeScript, full lint,
12/12 dedicated tests, 15/15 inherited native-isolation tests, 219/219 connection tests, and 235/235 CR13A tests. The
complete lifecycle passed 769/769 pretests, 419 core passes plus two established Windows-only skips, and 392/392
posttests. All five production build phases, 4/4 rendered routes, migrations 0001-0036/119 PostgreSQL tables, and exact
product-range whitespace validation passed.

## Independent review

A different report-only reviewer executed all twelve fixed commands once against the immutable product in a fresh
local-only detached clone. All twelve review groups passed with 0 High, 0 Medium, and 0 Low findings. Focused tests
passed 27/27, the native importer/type-only importer and no-consumer lists were exact, hostile and ambient replacement
executions remained zero, and every forbidden effect and authority remained zero or false. The checkout was clean
before and after verification, and the disposable root was removed with exact absence verified. Preserve
`docs/reviews/CR13A_LIVE_220_INDEPENDENT_REVIEW.md` unchanged.

Acceptance permits ordinary integration of this exact unreachable code only. It grants no factory retrieval or
invocation, server creation, locator observation, listener open/close, handoff issue/spend, adapter or driver call,
physical attempt, runtime wiring, provider contact, deployment, blocker clearance, or production authority.
