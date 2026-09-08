# Herdr reuse assessment

Date: 2026-09-08. Control Room local checkpoint: `2ce2fc9`.
Status: **research candidate, not adopted or qualified**.

The owner requested read-only research of https://github.com/herdrdev/herdr.
That request allowed the public reads used below, not installation, provider calls,
agent configuration changes or a new overnight build window. No package was
downloaded to the workspace, dependency installed or upstream code imported.

## Decision and placement

Evaluate Herdr before introducing another custom terminal/session manager. Prefer
its existing CLI/socket boundary over a Rust fork or a TypeScript reimplementation.
Keep the native structured adapters as the execution path until comparison tests
prove that a replacement meets the complete boundary. Herdr must not become a
second scheduler or independently resume Control Room-managed effects.

This supplements [the reuse-first plan](REUSE_FIRST_COMPLETION_PLAN.md), especially
R07 (hosts), R08 (continuous work) and R12 (reconnect/updates). It does not reopen
accepted queue, database or approval decisions. Current remaining implementation
is recorded in [the overnight handoff](OVERNIGHT_HANDOFF_2026_09_08.md).

| Candidate | Possible reuse | Required distinction |
| --- | --- | --- |
| Background terminal server | Optional home for interactive agent sessions | Disconnect survival is not restart survival or descendant cleanup. |
| SSH connections and capability negotiation | Existing remote access and reconnect implementation | Transport reconnection must not resubmit an uncertain task. |
| Session integration and resume planner | Exact session references, per-agent resume arguments and deduplication tests | A conversation reference is not a canonical task approval. |
| Agent/workspace state | Project attention indicators and read-only monitoring | Screen-inferred idle/blocked is advisory, not completion evidence. |
| CLI/socket events | Narrow adapter without copying the terminal implementation | Never expose unrestricted command/input APIs through the website. |

## Evidence and limitations

Inspected upstream README, documentation, source tree, `src/agent_resume.rs`
(including unit tests), and root license. These were moving `master`/documentation
pages, not an immutable qualified release. No upstream tests were executed here.
Do not claim a performance, compatibility, security or dependency-license pass.

- [Repository](https://github.com/herdrdev/herdr): Rust terminal application with
  server-owned panes, not a substitute for Control Room's web product.
- [Connecting machines](https://herdr.dev/docs/connecting-machines/): independent
  connections, bounded reconnect backoff, stale-state input disabling and negotiated
  capabilities. Combined multi-machine support is documented for Mac/Linux, not
  Windows clients; native Windows SSH server targets are unsupported.
- [Agent states](https://herdr.dev/docs/agents/): Hermes and Codex use screen
  manifests for working/idle/blocked. Unrecognized prompts can fall back to idle.
  Detection manifests may update automatically; an eventual test must record/pin
  those rules or explicitly disable their background updates.
- [Integrations](https://herdr.dev/docs/integrations/): Hermes uses an installed
  plugin and configuration change to report a resumable session ID. Installing it
  is an effect requiring separate scope; the research did not do so.
- [Session state](https://herdr.dev/docs/session-state/): detach preserves live
  processes; server restart restores layout and eligible conversations, not old
  processes. Automatic native resume is enabled by default. Experimental live
  handoff can interrupt requests/events and must not supply automatic task retries.
- [Resume source](https://github.com/herdrdev/herdr/blob/master/src/agent_resume.rs):
  per-agent argument construction, session reference checks, deduplication key and
  unit tests exist. These do not establish protected effect ownership.
- [Socket API](https://herdr.dev/docs/socket-api/): CLI wrappers and local event/API
  access can avoid a fork. Permission isolation, session scoping and untrusted
  terminal-output handling still need source review and local validation.
- [License](https://github.com/herdrdev/herdr/blob/master/LICENSE): Apache-2.0 at
  root. Preserve license/applicable notices and mark changed files if adapting.
  Bundled code/dependencies need their own review before redistribution.

The two documentation pages disagree on the minimum Hermes integration version
for resume (session-state table says 2; integrations overview says 5). Resolve
against the selected immutable binary/source, not an assumed minimum. This is a
documentation discrepancy, not proof either installed version works for our use.

## Bounded next evaluation

1. Select and record an immutable revision/release, its dependency and notice
   inventory, runtime prerequisites and relevant upstream test coverage. Before
   an authorized download, check free disk and add exact destination, size and
   retention/removal intent to the existing download log. Do not clone/install as
   part of this research record.
2. Review the Hermes plugin, session identity, local socket access and resume
   code. Establish whether agents sharing an OS account can control other panes;
   ordinary same-user IPC must not be mistaken for tenant/project isolation.
3. With separately authorized disposable runtime setup, test read-only inventory
   and events using harmless fake-agent processes, no credentials/providers.
   Disable automatic resume, manifest downloads and unrelated plugins. Capture
   exact machine/session/pane identity and advisory versus verified state.
4. Exercise the acceptance card below. Source inspection is not a test pass.
5. Record adopt/adapt/retain/defer, exact existing code displaced, integration
   cost and remaining platform gaps. Prefer no adoption if it adds another daemon
   without retiring a meaningful responsibility. No fabricated numerical score.

| Scenario | Required evidence before adoption |
| --- | --- |
| Disconnect/reconnect | Original fake process remains identifiable; no second launch; stale status never shown as live. |
| Server restart | Old process state distinguished from reconstructed layout; no automatic native resubmission. |
| Lost response to input/start | Ambiguity retained and reconciled; no blind repeat of a consequential command. |
| Competing clients | Ownership behavior measured; duplicate task execution prevented by the combined design, not a pane label. |
| Two projects with similar IDs | No cross-project input, session selection or result attribution. |
| Unknown prompt/state | Advisory fallback cannot release capacity, approve a result or trigger a job. |
| Cancel/close and descendants | ACK/pane disappearance not treated as proof all descendants stopped; unresolved capacity stays held. |
| Version mismatch/update | Missing capabilities are explicit; existing accepted work/results survive; no reliance on experimental handoff. |
| Platform matrix | Separate Mac/Linux evidence; Windows remains unsupported unless specifically proven through an accepted alternative. |

All rows are **not run**. The first useful deliverable is a read-only adapter
experiment and deletion/replacement comparison, not a second execution controller.
Production persistence, database roles/restore, real owner authentication and
Johnny5's deployment gates are unaffected by this candidate.
