# F1 database-driver source diagnosis and alternatives

2026-09-08. Independent source-only review of current CR driver/submission files, installed postgres3.4.7 and pg-boss12.30.0 implementations, and root's synthetic fixture. No SQL/service/test/native execution or downloads. Root supplied the subsequent diagnostic SQL22023 observation; the retained initial fixture evidence separately reports the application's safe submission failure. This review does not claim an observed production failure.

## 1. JSON scalar failure: source chain supports the diagnosis

`pg-boss/dist/manager.js:createJob:797–798` submits `JSON.stringify([job])` as a parameter. Its actual SQL uses `json_to_recordset($1::json)` (`plans.js:1772`). This is a pre-serialized JSON **string containing an array**, as expected by node-postgres-style parameter binding.

Current `src/persistence/database.ts:89–118` creates Postgres.js with prepare:true and forwards params directly to unsafe(). In postgres3.4.7:

- `types.js:220–228` infers plain string parameter type0 (unspecified).
- `connection.js:221–235` sets describeFirst for parameters without a cached prepared statement; disabling prepare does not inherently disable this.
- `ParameterDescription:606–613` fills unspecified parameter OIDs from the server.
- `Bind:928–946` applies the serializer selected for that OID.
- `types.js:16–21` maps JSON/JSONB OIDs114/3802 to JSON.stringify.

Thus a pre-serialized array string inferred as JSON is serialized again into a JSON string scalar. `json_to_recordset` then refuses it with SQL22023. This matches root's logging-only diagnostic; it is not evidence that pg-boss generated malformed array JSON or the approved canonical packet was wrong. The application intentionally collapses the driver error to `native_task_submission_unavailable`, which masks diagnosis but does not authorize bypassing submission checks.

## Production path is different, but not shown immune

`src/web/v1/private-postgres.ts` uses reserve(), prepare:false, fetch_types:false, max_pipeline1, fixed session timeouts and target_session_attrs:primary; each lease query explicitly uses `{prepare:false,simple:false}`. Generic createPostgresClient uses begin() with default fetch_types:true. The root's original generic-driver result is therefore **not a full production-driver reproduction**.

However, the actual build()/ParameterDescription/Bind path still describes parameter types with prepare:false. fetch_types controls initial **array-type catalog discovery**, not disabling built-in JSON serializers. A source-based expectation that production extended-protocol binding may show the same double-serialization is justified, but must be labeled an inference pending the actual private-driver seam. Simply setting prepare:false or fetch_types:false is not an established fix.

## 2. Cold reserve with fetch_types:false: separate lifecycle risk

`postgres/src/index.js:203–222` queues a `{reserve:resolve,reject}` request when no connection is already open. `onopen:402–412` is the ordinary point that dequeues such a request and resolves its reserved connection.

On the initial ReadyForQuery, `connection.js:523–549` checks target-session state, then array-type discovery. With needsTypes:true and an initial reserve it clears initial and issues fetchArrayTypes; a subsequent ready cycle can reach onopen. With needsTypes:false, the branch only executes initial when it is **not** a reserve, then clears initial and returns. In the inspected path there is no direct reserve resolution/onopen before that return. The connect timer has also been cancelled earlier in ReadyForQuery.

This is a concrete source explanation for root's reported cold-reserve timeout, distinct from JSON serialization. target_session_attrs may introduce additional state queries, so exact scheduling/connection state still requires root's diagnostic before naming an observed production defect. Warm ordinary-query-then-reserve and fetch_types:true are useful discriminating controls, not approved workarounds: warming adds a new acquisition query and enabling type fetching changes startup effects. Do not implement either as an invisible retry or alter private-driver semantics in this research.

## Maintained integration choices

| Choice | Actual available interface and cost | Important retained work |
| --- | --- | --- |
| node-postgres Pool/Client | pg-boss already uses pg internally; its public IDatabase executeSql adapter can call pool.query or an explicitly acquired transaction Client.query. Root's earlier worker fixture used real pool.query successfully. Avoids redundant JSON serialization of ordinary string binds and the Postgres.js reserve path. | CR DatabaseSession and bounded transaction/precommit/rollback, no-retry/uncertainty, settings and release semantics must be adapted and tested. Sending through a different pool inside an application transaction would break atomicity. Declare intentional direct dependency if chosen; no whole driver replacement accepted here. |
| Postgres.js public typed parameter | Shipped README documents sql.typed(value,OID). Explicit text OID25 for already serialized string values prevents server inference from changing that parameter into a JSON serializer; the pg-boss `$1::json` SQL provides an explicit cast. This is a narrow maintained binding interface, not editing pg-boss SQL. | Root must test actual JSON/JSONB/text/UUID/date/array/null call sites and transaction effects. Wrapping every string without checking SQL contexts is not approved; cold reserve is a separate unresolved issue. |
| Postgres.js custom types configuration | Public `types` option merges serializer/parser handlers (`types.js:193–207`). A narrowly specified raw-JSON serialized-input policy could avoid double encoding. No upstream fork is intrinsically required. | Global JSON override can change legitimate object/string semantics and response parsing across the client. Do not blindly replace JSON.stringify with String, which corrupts object inputs. Need explicit intended input contract and full binding regression; still does not fix reserve lifecycle. |
| pg-boss maintained ORM adapters | Actual exports are fromKnex/fromKysely/fromDrizzle/fromPrisma/fromPglite. They implement placeholders/result conversion for their named APIs. There is **no direct fromPostgresJs adapter** in this pin. | Installing an ORM solely to bridge current unsafe() is a larger dependency/transaction change. fromDrizzle can use different database drivers, so its existence alone is not proof that a Postgres.js-backed route changes JSON serialization. PGlite adapter is not a real PostgreSQL driver substitute. |

The lowest-risk next comparison is actual node-postgres transaction-client binding versus the supported Postgres.js typed bind at the **same existing CR query/transaction contract**, retaining the private-driver lifecycle probe separately. This is not an engine winner: replacing pg-boss would not automatically correct a generic DB adapter used elsewhere. Reusing maintained pg is materially different from inventing a wire protocol or custom parameter serializer.

## Finite acceptance and removal boundary

Require literal array/object/scalar JSON, text/UUID/array/null and existing pg-boss insert/output queries through actual chosen binds; assert server-observed values/types and stored data, not only absence of22023. Then actual marker+queue INSERT rollback under precommit rejection must leave neither row. Commit case must retrieve exact operational ID/data and worker output. Cold first acquire, release/reacquire, query failure and bounded shutdown remain distinct lifecycle checks; no prepared-plan transparent repeat or replay after uncertainty may be added casually.

Potential replacement is the DatabaseSession transport/binding adapter and, only if chosen, Postgres.js-specific connection/reserve plumbing. Retain canonical submission IDs, queue profile validation, approval/precommit checks, exact session coupling, authority/error handling and outbox/occurrence stores. Current files affected would be `src/persistence/database.ts` and/or `src/web/v1/private-postgres.ts` plus dependency/lock/notices and their focused tests; no schema, provider or pg-boss scheduler rewrite follows from this evidence. Cost remains unmeasured. Root owns design, implementation authorization and whether later actual diagnostics confirm either production-seam concern.
