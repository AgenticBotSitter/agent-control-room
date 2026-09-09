# Database string parameter call-site audit

2026-09-08; baseline `08f4eb6`, branch `codex/idea-abs-workflows`, with existing local research changes preserved. Source-only: no API, database, runtime or test execution, downloads, credentials, service or source changes. Root owns driver/adapter selection.

## Finding

**Blanket `sql.typed(value,25)` for every JavaScript string is not compatible with the existing SQL interface as written.** The previous eight-value driver experiment deliberately used explicit casts. Actual callers rely on PostgreSQL parameter inference for ISO timestamp strings and at least one UUID comparison. A known `text` parameter is not an unknown-type parameter; making the bytes correct for serialized JSON does not preserve inferred types elsewhere.

These are source-derived incompatibilities, not newly observed PostgreSQL failures. The strongest next finite experiment is the actual outbox timestamp comparison and queue recovery UUID comparison, alongside the already passing explicitly cast JSON values. No broad ORM evaluation is needed to establish this distinction.

## Interface and distinct semantics

`src/persistence/database.ts` exposes `query(statement:string, params?:unknown[])` without parameter type metadata. Both generic Postgres.js adaptation and `src/web/v1/private-postgres.ts` currently forward the array unchanged to `unsafe`. The private adapter fixes prepare:false/simple:false and routes failures into bounded uncertainty; that failure policy does not resolve parameter typing. `fetch_types`/cold acquisition is a separate issue from this audit.

| Context | Actual source and value | Effect of forcing all strings to text |
| --- | --- | --- |
| Serialized structured JSON | `canonical-store.ts:1270–1285` serializes entity payload and explicitly emits `::jsonb`; `idea-lab/v1/store.ts:85–88,149–151` does the same for sessions/contributions. | Text bytes followed by explicit JSONB cast is a viable narrow repair. It must preserve serialized JSON rather than quote it again. Prior driver evidence supports this sampled behavior. |
| Serialized JSON scalar string | Prior `f1-driver-contract-fit.md` tests JSON.stringify of a string separately from object/array. | The explicit JSON cast needs JSON text including its quotes; do not classify by whether the contents start with `{` or `[`. No distinct production scalar-root JSON call was established in inspected callers. |
| Ordinary text containing JSON-looking content | `task-execution-planner.ts:303` constructs JSON text as a prompt; store helpers also serialize entire records. IDs, digests, labels and prompts remain strings in their domain contexts. | Contents alone cannot identify SQL intent. Do not JSON.parse arbitrary strings or auto-convert based on syntax. Text equality/collation contexts remain compatible with text. |
| Timestamp insertion and update | `canonical-store.ts:1270–1285` casts only payload, leaving created_at/updated_at and extras uncast. `services/v1/occurrence-store.ts:45,48,66,73` passes scheduledFor/createdAt/deliveredAt strings into uncast timestamp columns. | Existing inference is replaced with explicit text. The adapter cannot assume assignment will preserve timestamp coercion; these require exact-driver testing or explicit parameter typing/casts. |
| Timestamp comparison: decisive mismatch | `delivery-store.ts:147–164` has `available_at <= $1`, `claimed_at=$1`, with `input.now:string`. Schema `db/migrations/0003_canonical_domain_delivery.sql:267–268` defines both timestamptz. | `timestamptz <= text` does not receive unknown-parameter timestamp inference. This affects actual outbox pickup, not just an optional UI query. |
| More required timestamp comparisons | `scheduler/v1/reservation-store.ts:62,70,99–100`: expires_at <=/> string now; schema0014 line19 timestamptz. `web/v1/task-assignment-coordinator.ts:259–262`: `l.expires_at>$3` with `new Date(clock()).toISOString()`. | Same issue in capacity expiry and ready-node recovery. Operator pins85, replay deletion `node-protocol/v1/persistence.ts:321`, Telegram145/148/182 and private owner preflight294 repeat the pattern; listing every duplicate adds no new semantic coverage. |
| Explicit timestamp cast: compatible alternative | `operator-surfaces/v1/read-service.ts:39–44` uses `$2::timestamptz`; ABS `postgres-store.ts:217,227–229` uses `$6/$7::timestamptz` with ISO strings. | Text input plus explicit cast preserves intended type for these cases. Their presence does not make the uncast cases safe. |
| UUID comparison: second decisive mismatch | `persistence/pg-boss-bounded-submission.ts:77–78,88–89` queries queue job `WHERE name=$1 AND id=$2`, with profile-derived string ID. Actual installed `node_modules/pg-boss/dist/plans.js:354` declares job id uuid. | Forcing ID to text makes `uuid = text` rather than inferring uuid. The direct CR recovery query is outside pg-boss's generated SQL, so passing enqueue tests alone misses it. Most core CR IDs are text; do not infer SQL UUID from string shape. |
| Arrays | `web/v1/news-collection-admission.ts:121` and ABS `postgres-store.ts:208–209` use actual JS arrays with `ANY($n::text[])`; permissions file29 also uses text[]. | Top-level string-only wrapping leaves arrays unchanged. Do not recursively wrap elements or conflate JSON serialized arrays with native SQL arrays. Existing array fixture is useful but not whole-query parity. |
| Nulls and mixed text predicates | Project-service73, task-service138, Idea store108 use `$n::text IS NULL` plus text ID comparisons. ABS214–225 uses `$5='all'`, `$8='id'` and CASE/ordering with literal text alternatives. | Null should remain null, not a typed string. These inspected text comparisons are not counterexamples to text binding. |
| Numeric comparisons / polymorphic expressions | Project-events store128–136 uses parsed numeric cursor/limit; outbox attempts and limits are numbers. Inspected `json_build_array` calls in private preflight124/130/135 operate on catalog expressions, not raw placeholders. | String-only wrapping does not change these numeric values. No concrete `to_jsonb($n)`/`json_build_*($n)` polymorphic raw-string call or uncast SQL date-only parameter was established in this search. Do not claim an invented current failure there. |

## Narrower feasible seams

The existing pg-boss `SqlPort.executeSql` bridge (`pg-boss-bounded-submission.ts:46–51`) already separates generated queue SQL from general CR stores and preserves the current transaction through AsyncLocalStorage. It is a plausible place to scope an explicitly typed serialization adaptation **after** enumerating the pinned generated query's parameter types. It is not permission to type every value to text even there; queue UUID/time queries and direct recovery paths still matter. A narrowed boundary must keep the exact original DatabaseSession and transaction/precommit behavior, not open an independent queue transaction.

For application JSON, the current dynamic canonical insert already knows which fields are JSON. An explicit parameter representation or narrowly reviewed call-site conversion could use that semantic knowledge rather than parse SQL strings or inspect value contents. That entails a deliberate interface/caller change and associated tests; this audit does not design or approve it. Widespread timestamp casts would be a larger migration of application SQL, not a free one-line driver repair.

Node-postgres preserving its demonstrated untyped text-protocol input behavior remains a strong alternative to a broad Postgres.js parameter rewrite. Its existing owned-PG contract evidence covers the tested values, not all SQL callers; it still needs the separately reviewed bounded close/active transaction behavior. Do not loosen uncertainty, identity, approval, precommit or lease rules to accommodate either driver.

## Existing test pointers and bounded next proof

- `tests/canonical-persistence.test.ts:280–298`: actual outbox claim/retry and input timestamps. File uses adaptPglite; this is test intent, not proof of OID25 network-driver compatibility.
- `tests/services-v1-occurrence-store.test.ts:50`: occurrence→outbox claim; same PGlite limitation.
- `tests/scheduler-reservation-store.test.ts:18–26,31–56`: timestamp expiry/reconciliation/release.
- `research/reuse-comparisons/f1-driver-contract-fit.ts` and retained driver-contract report/receipts: eight explicit-cast cases and precommit rollback, which should remain unchanged as positive controls.
- Actual queue recovery must exercise the `id=$2` lock/read path, not only pg-boss send/cancel. A UUID column check plus the unchanged CR call is a smaller discriminating proof than another full delivery suite.

No tests were run here. The recommended proof is limited to the two distinct uncast timestamp/UUID contexts plus preserved JSON controls; production PG17/private-role acceptance remains separate.

## Search boundary

Read both database adapters, the contract report, representative canonical/delivery/occurrence/reservation/Idea/ABS/queue consumers and schema declarations. Searched TypeScript under `src` for DatabaseSession consumers, placeholders with comparisons/casts, ANY, JSON serialization and polymorphic JSON calls; searched migrations for SQL types and inspected installed pg-boss job schema source. Some broad search outputs were capped; selected decisive queries were then read directly. This is a distinct-semantics audit, not an exhaustive AST census of every generated SQL statement, every optional backend, package plan or future caller. No source tree was modified and no public research was required.
