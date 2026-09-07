# Agent Control Room architecture

Unpublished draft. Describes the intended architecture and contribution boundaries,
not a claim that a production installation or every connector is supported today.

## One application, many projects and workers

Agent Control Room coordinates projects, work, schedules, approvals, results and review.
The browser is a view of the application, not a second scheduler. Each project has its
own page and history. Archiving a project preserves its records; closing a browser tab
does not stop a worker.

The trusted controller is one modular application backed by one private PostgreSQL
primary. Queue integration uses pg-boss with the application's admission and permission
checks. PGlite supports local development and tests only. Object storage holds artifacts
and backups, not task ownership, locks or transactional coordination.

Node connectors adapt approved work to different agent runtimes. They communicate through
authenticated application interfaces and keep runtime credentials on the relevant node.
They do not receive unrestricted database access. MCP tools, where available, call the
same application services; MCP is not a separate authority or mandatory transport for
every worker. A connector is not permission to run arbitrary remote shell commands.

## Follow one task

1. An authenticated user saves a task under a project. A saved proposal has not started.
2. The application checks eligibility, permissions, dependencies and any required approval.
3. An eligible registered worker receives bounded work through the configured delivery path.
4. Runtime observations and returned artifacts are associated with that task and attempt.
5. Review evaluates the exact result. A requested revision stays linked to its predecessor.
6. Quality acceptance and permission for consequential actions remain separate decisions.

Unknown delivery outcomes must stay unknown until reconciled. Reconnecting, refreshing
the browser or losing a response must not automatically submit the same real work again.
Reported agent completion is not proof of independent verification or owner acceptance.

## Trust boundaries

- Authenticate and authorize each operation at the server, including after permissions change.
- Network membership, a private URL and a successful login do not grant unlimited execution.
- Keep private credentials out of the browser, jobs, artifacts, source and diagnostic reports.
- Run untrusted worker code outside the controller's trusted process and credentials.
- Preserve attribution, exact-result identity and meaningful failure evidence.
- Review-integrity checkpoints must live independently of the database they protect.
  An ordinary table in that database is not an independent rollback anchor.
- Separate deployment and provisioning from source tests. A passing simulated test does
  not establish real database durability, host compatibility or a safe production rollout.

## Core versus optional workflows

Core includes project/task storage, worker connectivity, results, review, permissions,
attention handling and reliable operation. A usable core needs one demonstrated live
task-to-result-to-revision journey, not just a collection of green component tests.

Idea Lab adds bounded discussions and project creation. News/research adds article
selection and follow-up tasks. Content and media workflows add domain-specific inputs
and artifacts. These modules reuse core project, task and approval services. They must
not introduce parallel queues, identity systems or global write authorities.

Prefer maintained upstream components with compatible licenses. Custom infrastructure
needs a specific requirement that suitable existing components cannot meet, plus an
explanation of the maintenance and verification cost. Keep adaptations small and upstream
provenance visible. Do not copy a complete competing application merely to reuse one panel.
