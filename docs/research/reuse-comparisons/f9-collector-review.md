# Independent RC10 collector review

2026-09-08. Source/report/receipt review only. Downloaded collectors were already cleaned; I did not independently inspect their installed bytes, rerun either collector or verify cleanup. Read retained fixture, acquisitions, failed/corrected fixture evidence and root's structured actual-application receipt. No downloads, services or application changes.

## Disposition

The superseding actual-application finding is decisive: **4.4.2 is not accepted as a complete installed-graph collector in the tested configuration.** Returning exit0 and no missing-text entries only describes the records found; it does not establish graph completeness. Eight returned IDs omit five specifically identified installed, parent-resolvable dependencies. The report correctly preserves that failure rather than treating the small fixture pass as application acceptance.

## Narrow reporting finding

**P3 — make the fixture's transitive-depth limitation explicit.** Although the authored graph includes alpha→beta, the root manifest also depends directly on beta. A collector that only reads root/direct packages can therefore pass every current fixture assertion without following alpha's dependency. State explicitly that the fixture proves real pnpm symlink handling and full-text/clarification behavior for root-reachable packages, **not traversal to a transitive-only package**. This explains why the real-application follow-up was necessary. Before any renewed completeness claim, use a transitive-only child plus duplicate/version/peer variants or a supported complete graph interface. No new generic walker is warranted.

## Fidelity and compatibility

- The pnpm fixture is genuinely prepared by offline pnpm with authored file dependencies, scripts disabled and owned store; assertions check a symlink and `.pnpm` real path. It is not a manually simulated link tree. Collector entry hashes precede import; exact dependency lock identities are retained. Entry hashes alone do not prove the full executable tree, and the report says so.
- Actual positive license text, absent beta text, checksum-approved retained text and changed-text child-process refusal are concrete checks. Negative child exit/status and diagnostic are asserted; raw child output is not separately retained, which is disclosed. Staging a retained basename inside a disposable package resolves the earlier two path assumptions without modifying collector code. It does not prove arbitrary external override paths or authorize altering installed application packages.
- The 5.0.1 Node>=24/npm>=11 requirement is treated as an unsupported Node22 exploratory run, not overridden by successful execution. The 4.4.2 compatible engine range removes that particular mismatch, not its actual graph-fit failure. A separately scoped supported packaging runtime is a viable alternative to raising production Node; it remains untested here.
- The actual-app receipt is explicitly a **structured summary of root-observed output and resolution checks**, not full raw stdout or an independently reproduced manifest. Five verified omissions suffice to disprove completeness, but do not establish the total number of missing packages or the underlying traversal defect. Do not infer the package walker is universally broken or unable to consume a supported staged graph.
- The root application's UNLICENSED metadata despite available text reinforces that text presence is not legal permission. Dependency metadata and root license text are inventories, not complete distribution/license clearance.

## Alternatives, cleanup and next decision

Retain the bundle plugin for its tested bundled-code responsibility and explicit copied-source attribution. Compare supported collector graph input/staging, a supported-runtime5.0.1 route and the identified CycloneDX contender before selecting the external/install-graph tool. The incumbent failing configuration must not be combined with the plugin and silently called complete. There is no production deletion from this experiment, and no evidence justifies a custom generic graph/text walker.

Root records terminal experiment commands, no background services, unavailable process inventory and exact52MiB-root removal with absence verification. Those cleanup limits are stated honestly; this reviewer did not observe the historical deletion. No retained runtime packages are claimed. RC10 selection and full application packaging remain incomplete, with the bounded fixture evidence reusable at its exact scope.
