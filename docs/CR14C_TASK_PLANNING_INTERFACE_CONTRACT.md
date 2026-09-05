# CR14C — protected task preparation interface

Status: independently accepted repository integration at `f1d1856a6a295f4dd6f9a5d70bffe0b21f396afe`.
Predecessor: PR #294. Production configuration remains unavailable.

## Owner journey

Each private task page reads current planning availability. An eligible owner can select
**Prepare saved task** to save the existing proposal as a separate proposed execution bundle.
The receipt links to that prepared task. Preparation is not approval, assignment, admission,
dispatch, provider execution or quality acceptance. Refresh, focus and reconnect only read.

`GET /api/v1/projects/:project/tasks/:source/plan` returns a bounded scope/input-bound hint:
available, not configured, or not eligible. Available means the owner/source/project are eligible
and a planning operation is supplied; it does not promise current template/profile acceptance.
`POST` accepts only `{expectedInputDigest}` (1 KiB maximum). It cannot select a template,
executor, credential, node, destination or instructions. The existing planner performs current
owner/grant/source/profile checks and atomic materialization. First save returns 201, exact
source reconciliation 200. Receipts include both original and prepared input digests, no template
or private authority details. Responses are no-store/noindex; shared Access and logout apply.

## Composition and least privilege

`TaskExecutionPlanner.webOperation()` supplies only a frozen, scope-labelled planning method.
`createPrivateWebProcess` rejects mismatched tenant/workspace configuration and snapshots that method.
The ordinary web task service retains its restricted SQL client. No role grants, migrations,
native imports, listeners or production credentials are added. The planning operation rechecks
the verified identity in its own trusted transaction; browser availability is never authority.

The optional operation is an in-process integration seam for the trusted coordinator, not an
additional database pool created by the web process. Its resources and shutdown remain owned by
that coordinator. The existing production startup profile owns only the restricted web pool and
explicitly rejects planning configuration before opening a pool. Production coordinator composition
and its bounded lifecycle remain unfinished; the interface is not claimed enabled on an installation.
An absent operation remains visibly not configured and refuses writes. No web role can insert
execution plans merely because this interface exists.

## Failure and reconciliation

The browser keeps one exact pending source/input in task-page memory. Lost/malformed/oversized
replies and 5xx responses retain uncertainty. Reads cannot clear this hold. A subsequent denial
also cannot settle an earlier uncertain save. Only an explicit exact preparation check may replay;
database source uniqueness prevents another bundle. A first definitive rejection releases the hold.
Invalid scope/input/authority flags in receipts cannot count as success.

Failed task or availability reads hide planning data and actions, while the stable keyed page
retains pending identity. The user must restore access before reconciliation. Leaving/reloading
the page discards in-memory state; preparing the same immutable source still reconciles in SQL.
No timer, refresh, uncertain response or page navigation starts an agent or retries a native run.

## Acceptance boundaries

Require disposable process/SQL tests, restrictive-role refusal, request validation and logout,
browser-client replay/concurrency/malformed response tests, rendered component checks, TypeScript,
lint, both builds and existing regression suites. Compiled/in-process tests are not observed
browser-click evidence. No deployment, physical database, native credentials or provider call is
part of this block. Admission/approval/dispatch and revision submission remain separate work.
