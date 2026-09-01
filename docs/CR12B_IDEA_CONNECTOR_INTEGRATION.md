# CR12B Idea Lab and provider-disabled Hermes connector — integration record

## Integration scope

This main-target integration carries the complete CR12B Idea Lab project flow and the provider-disabled Hermes 0.21
connector stack from common main base `f7c4b20dcfd40b4747276bc435373c1f84365f4c` through accepted connector product
`e028d6b4cd5ee55c053561a880fbf65d897dc2ad` and its durable acceptance checkpoint.

The product includes the Idea Lab session/project workflow, protected operator and owner boundaries, durable authority and
spend stores, provider-neutral filtered driver contracts, reviewed Hermes source pins, signed locator-free connection
enrollment, one-use qualification policy, the fixed local/SSH bridge contract, guarded Mac connector composition,
captured cancellation/host/chronology/canonicalization operations, exact roster construction, and recursively immutable
returned connection evidence.

## Accepted evidence

- accepted connector product: `e028d6b4cd5ee55c053561a880fbf65d897dc2ad`;
- frozen review packet SHA-256: `d8e205f0fb7c5a28a5f1d25c72618368f4c3372521c80d296fc6d484c8c3b417`;
- accepted independent report SHA-256: `7cbd2f982956ff418e35dfacf71ee616a763fe60e20eb0b4d40acf553581af3f`;
- accepted-product CR12B verification: 171/171;
- integration verification under the exact CI baseline Node `22.13.0`: 172/172 CR12B tests;
- repository lifecycle under Node `22.13.0`: 769/769 pretests, 418 core passes with two intentional platform skips,
  251/251 posttests;
- TypeScript, full lint, production build, and 3/3 rendered routes: pass;
- database verification: all 32 migrations and 110 PostgreSQL tables;
- macOS stage zero and whitespace validation: pass.

All rejected connector snapshots and their immutable negative reports remain in the history. This integration does not
reinterpret any negative review as a pass and does not drop the evidence that caused each remediation.

## CI baseline portability repair

The first main-target CI run exposed one runtime-shape difference rather than six independent connector failures. Node
`22.13.0` publishes `globalThis.AbortController` through a paired lazy accessor, while the newer Mac Node runtime publishes
it as an own data property. The connector previously captured only the data-property form and therefore failed closed
before dispatch on the CI baseline.

The integration repair captures either form once during trusted module initialization, validates the resulting constructor
and its prototype operations through the existing Proxy-rejecting host boundary, and continues to ignore every post-import
global or prototype substitution. A dedicated regression installs a paired lazy accessor, proves exactly one getter call
and zero setter calls, opens the fixed route, and restores the host descriptor. The focused connector suite passes 19/19
under both Node `22.13.0` and the Mac runtime. This repair adds no provider, process, network, filesystem, credential,
locator, signer, route, or live authority.

## Authority boundary

This is a provider-disabled repository integration. It configures no signer, private port, route, SSH connection, native
runtime, provider, credential, live-panel authority, production PostgreSQL service, deployment, hosting, DNS, or
external effect. The future owner-attended native qualification still requires effect-free preflight, refreshed exact
pins and packet, a new exact owner authorization, and the attached-Terminal ceremony. Acceptance of this integration is
not permission to run that qualification.

## Next dependency

After this integration lands on `main`, the independently accepted CR13A Project Activity product can be restacked onto
the integrated base. That UI stage exposes project-specific recent work, decisions, blockers, evidence, and links but
does not widen connector or execution authority.
