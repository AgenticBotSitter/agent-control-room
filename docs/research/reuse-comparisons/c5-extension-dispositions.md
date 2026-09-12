# C5 known optional extensions: accounting and deferred qualification

2026-09-08. Local evidence synthesis at `2fb66d7` plus current research documents.
No new discovery, downloads, runtime execution or application changes. Root retains
selection, licensing and authorization decisions.

## Scope and evidence quality

This accounts for the named optional harness/content/media candidates found in the
existing research roster, public contributor roadmap and media contracts. It does
**not** certify all their source or licenses: most older roster entries have no
immutable implementation pin or retained test receipt. Those are explicit missing
E1 evidence, not rejected products and not accepted integrations. A repository name,
historical license table or hosted documentation is not E1 under the current program.

The archive's own [README](../archive-2026-08-22/README.md) warns that its reports
are historical, subordinate and sometimes superseded. In particular, broad archived
claims that everything is safe for internal use, that permissive projects have no
notice obligations, or that a Python SDK removes its engine's license boundary are
not adopted here. No current legal conclusion is made from that archive.

Local source keys used below:

- **H:** [agent harness roster](../archive-2026-08-22/control-room_research_agent-harnesses-landscape-2026-08-22.md), including its ecosystem subsection.
- **W:** [dashboard interfaces](../archive-2026-08-22/control-room_research_web-dashboards-across-harnesses-2026-08-22.md).
- **L:** [historical license matrix](../archive-2026-08-22/control-room_research_license-reuse-matrix.md), corrected by [package-level follow-up](../archive-2026-08-22/control-room_research_followup_license-sbom-correction.md) and [SBOM](../archive-2026-08-22/cr-sbom-2026-08-22.json).
- **C:** [Claude reported spike](../archive-2026-08-22/control-room_research_followup_claude-code-live-spike.md).
- **O:** [orchestration roster](../archive-2026-08-22/control-room_research_orchestration-landscape-2026-08-22.md).

“Unpinned” below means no immutable source revision located in those inspected
records; it is not a claim that upstream cannot be pinned. Interface descriptions
are historical proposed leads, not newly verified supported APIs. None of these
optional runtimes was executed in this synthesis.

## Additional runtime candidates

All rows remain later, opt-in adapter proposals because the required initial
execution paths are Hermes and Codex. General reopen condition: a named user or
contributor needs that runtime, proposes an exact supported release/interface and
supplies the missing source/license closure. Before support is advertised, require
synthetic lifecycle-to-current-task fit followed by separately authorized real-host
start, exact identity/events/usage, interruption/recovery and artifact acceptance.
Unsupported verbs must remain explicit. No shared credential or second scheduler
is implied. The specific discriminator in the last column supplements this rule.

| Candidate | Exact existing pin/license evidence and level | Proposed reuse boundary; specific trigger / missing evidence |
| --- | --- | --- |
| Claude Code CLI, `anthropics/claude-code` | C/SBOM report `@anthropic-ai/claude-code@2.1.240`; proprietary application terms, no immutable source/whole-package hash. Historical start emitted init/error but was auth-blocked; not a successful lifecycle. | User-installed external CLI `-p --output-format stream-json --verbose`, not copied engine. `CR3_PROTOCOLS_AND_EXTENSIONS.md` already records this proposed seam. Reopen for a Claude worker; verify actual versioned event/cancel/resume implementation and terms, then complete the previously blocked lifecycle legs. No authorization to repeat that old spike. |
| Claude Agent SDK Python, `anthropics/claude-agent-sdk-python` | C reports `claude-agent-sdk@0.2.144` MIT; SBOM explicitly says license file not verified. No immutable source/test receipt. | Alternative bindings to the separately installed engine, only if callbacks/hooks or lifecycle fit improve on CLI. Missing exact LICENSE, package source/dependencies and actual client fit; MIT binding metadata does not license the engine. |
| Claude Agent SDK TypeScript | C/SBOM report `@anthropic-ai/claude-agent-sdk@0.3.240`, `SEE LICENSE IN README.md`; exact terms unverified. C's “SDKs are open” headline conflicts with its own detailed table. | Competing binding, not approved copied code. Reopen for a concrete SDK-only capability; resolve terms and actual source before choosing it or rejecting it as proprietary. |
| OpenClaw, `openclaw/openclaw` | H/W/L: unpinned; historical fetched root MIT claim, API label NOASSERTION. No gateway implementation/test receipt. | Dedicated adapter to documented gateway WebSocket session/run surface; no dashboard embed or copied credentials. Validate handshake/event identity, reconnect, cancellation and file scope at a real immutable pin. |
| DeepSeek Harness, `deepseek-ai/deepseek-harness` | H/L: unpinned MIT claim, development-preview description only. | Plugin/runtime adapter if a concrete supported execution API is identified. Missing immutable existence/source/API/test/license verification; archived “DeepSeekbot” alias is not a second candidate. |
| AutoGPT, `Significant-Gravitas/AutoGPT` | H/L: unpinned; reported MIT outside `autogpt_platform/`, Polyform Shield inside. No exact selected file closure. | Optional external runtime or specifically licensed module, not import of the whole platform. Reopen for an actual automation capability absent from required harnesses; inspect exact directory/interface and intended-use terms first. |
| Open Interpreter, `openinterpreter/openinterpreter` | H/L: unpinned Apache-2.0 claim. | External executor/harness adapter; require a concrete bounded code-execution use case and real lifecycle/permission interface source. Do not expose arbitrary shell as its substitute. |
| Cline, `cline/cline` | H/W/L: unpinned Apache-2.0 claim; IDE/SDK/CLI descriptions. | Prefer supported headless interface if demonstrated, not automating an IDE UI. Reopen when an exact SDK/CLI supplies the needed lifecycle without an implicit interactive approval bypass. |
| Goose, `aaif-goose/goose` | H/W/L: unpinned Apache-2.0 claim; CLI/desktop/extensions descriptions. | Native CLI/runtime adapter; reuse native extensions, not a new CR extension runtime. Need exact event/session/interrupt source and dependency inventory. |
| Aider, `Aider-AI/aider` | H/W/L: unpinned; reported Apache-2.0 `LICENSE.txt`. | Optional coding worker subprocess within CR-owned workspace. Reopen for an Aider contributor; prove noninteractive result/changes/termination mapping rather than infer it from terminal UX. |
| OpenHands, `OpenHands/OpenHands` | H/W/L: unpinned MIT claim; web-first agent canvas description. | Optional supported runtime/API adapter, not replacement of CR projects/approvals. Need exact API/worker source, sandbox lifecycle and redistribution scope. |
| Khoj, `khoj-ai/khoj` | H/W/L: unpinned AGPL-3.0 claim. | Optional search/knowledge service, not a required worker or copied core UI. Reopen for a specific knowledge-retrieval need; examine service API and actual licensing obligations before selecting separate-service or source reuse. |
| Letta, `letta-ai/letta` | H/W/L: unpinned Apache-2.0 claim; stateful-agent description, ADE URL explicitly unverified in W. | Optional memory-bearing runtime/service; retain CR task authority. Reopen for durable agent-memory requirements not provided by existing harnesses; inspect exact API and persistence ownership. |
| SuperAGI, `TransformerOptimus/SuperAGI` | H: unpinned MIT metadata and historical inactivity claim, no code-level fit. | Archived discovery only, not current rejection. Reopen only for a named capability and newly verified maintained source/interface; do not repeat old inactivity as a current fact. |
| Gemini CLI; Cursor | O and `f4-teamwork.md` mention them as other tools' supported substrates. No direct package pin/license/client dossier located. | Optional coding-runtime leads only. A third-party kind switch is not CR support or a primary API receipt. Reopen on a named contributor with exact upstream distribution, license and lifecycle interface. |

## Peripheral ecosystem names: no accidental new requirements

H lists the following under the OpenClaw organization. None has a source pin,
selected implementation, dependency/license closure or actual execution receipt in
the inspected roster. Each remains discovery-only with missing E1:

| Name | Proposed optional boundary / reopen trigger |
| --- | --- |
| ClawHub | Native skill/plugin registry interoperability only if an OpenClaw adapter needs it. Do not replace CR eligibility or native skill execution. |
| Peekaboo | Optional Mac screen-observation tool through a separately authorized runtime capability. Requires exact permissions/interface and owner-attended host qualification; not part of first-task monitoring. |
| openclaw-windows-node | Optional companion/package reference if the chosen OpenClaw Windows mode requires it. Verify actual account/ACL/process behavior; not proof of CR Windows installation. |
| Crabbox | Optional sandbox/diff-sync donor if a named workspace capability remains uncovered. Exact source and comparison with existing RC4 workspace evidence required first. |
| ClawSweeper | Optional issue/PR triage integration if explicitly requested; source/permission/duplicate-action qualification before GitHub writes. |
| OpenClaw docs/translations | Documentation reference, not an execution component; copied documentation needs its own exact license attribution. |
| “Runkbot” | H records unresolved name, no established repository. Keep unresolved; owner/contributor must identify it before evaluation. Do not invent a candidate. |

## Named content/media extensions

These names are requirements/executor leads, not a retained inventory of verified
third-party libraries. Their exact engine/build/license/source pins remain absent
from the inspected media contracts; do not fill those blanks from general knowledge.

| Candidate / existing local implementation | Current evidence and reuse boundary | Reopen / qualification trigger |
| --- | --- | --- |
| Generic Content Blooms-derived pack | `src/project-adapters/content-blooms/v1/{project-pack,adapter,command-adapter}.ts`; existing project pack contains research/transcription/article stages and `requiresSeparateEffectAuthority: true`. Local source at this checkpoint, not an external repository license grant. | Retain generic schema/procedure/knowledge/read projections without exporting private names/data or rewriting historical identities. New consumer needs explicit source-owned scheduling/eligibility mapping and synthetic public examples, then separate actual source-system acceptance. |
| Lo-Fi Wayfarer-derived media pack | `CR9B_WAYFARER_PROJECT_PACK_CONTRACT.md`, `src/project-adapters/wayfarer/v1/`; synthetic render/audio/QC/review/assembly/publication-preparation graph. Contract explicitly records no native tools or media bytes. | Optional media project requests real executor implementation. Reuse graph/artifact/review machinery; qualify native producers and storage separately, not the synthetic receipts as rendered output. |
| FFmpeg / media probe | Named in `CR3_PROTOCOLS_AND_EXTENSIONS.md` deterministic executor list and Wayfarer contract; no selected binary/version/build flags/source/license receipt here. | Concrete QC/assembly operation and target platform. Inspect exact distribution/codecs/licenses; map typed operation and output verification, then bound real media/resource/termination tests. No arbitrary shell executor. |
| Blender | Named in Wayfarer exclusions, no implemented/pinned producer. | A concrete scene/render task identifies required engine/build/plugins/assets. Source/license screening and bounded real scene/GPU/artifact qualification precede support. |
| Unreal | `wayfarer/v1/unreal-executor.ts`, `CR9B_WF_080_DISABLED_DISPOSITION.md`, WF-080 and WF-090/100 acceptance: frozen disabled executor; no measured benchmark or selected tool identity. | Existing contract requires fresh complete readiness and separately authorized owner-attended measured scene/render benchmark. Disabled outcome is not engine failure; do not revive a spent authorization or treat a synthetic renderer as native acceptance. |
| Audio/image providers | Wayfarer names capabilities, not a specific vendor/repository. No provider pin/terms/model or actual generation evidence. | Owner selects a concrete producer and output-rights/cost requirements. Then evaluate that actual provider adapter; do not invent Suno, ElevenLabs or another candidate from the generic capability. |
| YouTube publication/upload | Named destination in Wayfarer contract and archived content handoff; preparation only, no selected SDK/API version or terms receipt. | Explicit publication requirement plus separate account/effect authorization. Verify exact API scope, upload uncertainty/idempotency and retained evidence before enabling; preparing a package is not publishing. |

R2 is retained artifact/storage infrastructure with its own core acceptance, not a
new optional media engine or coordination database. Required C3 full article reading
and C4 article-to-research remain in RC7; [reader-service dispositions](f7-reader-service-dispositions.md)
and DR-07 govern those, not this C5 deferral. Required Hermes/Codex execution remains
RC2, not an optional harness extension.

## Other named projects already assigned elsewhere

O also discovers Gas Town (`gastownhall/gastown`), Superset (`superset-sh/superset`),
AgentTeams (`agentscope-ai/AgentTeams`), CodexMonitor (`Dimillian/CodexMonitor`), clawe
(`getclawe/clawe`), and Forge (`nxtg-ai/forge-orchestrator`). Their inspected archival
entries are unpinned descriptions; L reports respectively MIT, Elastic-2.0,
Apache-2.0, no CodexMonitor row (O reports MIT), no clawe row (O reports AGPL-3.0),
and FSL-1.1/ALv2-future. These are not six newly selected optional harnesses:
workspace/coordination/observation responsibilities belong RC3/RC4. Preserve them
there as known alternative leads with missing exact E1 where no later dossier exists.
Reopen for a specific uncovered coordination/UI function, not an additional fleet
manager by default. This C5 report does not dispose their relevance to required B7.

AI Maestro and Agent Orchestrator have stronger subsequent pinned actual-code
evidence: respectively `2c3baa70ab8f8b2b97c943e4f97c20c5c3e5b81c`
and `24e101914976a14145d7302f49626db3541ef8b5`, with MIT/Apache source records in
the F4 dossiers. See `f4-delivery-fit.md`, `f4-workspace-next-fit.md` and DR-06.
Do not downgrade those to the old discovery roster or use their execution as proof
of the other projects. Desktop/WebUI/Herdr and Studio stay in their existing RC3/RC4
module/license dispositions; adding them again as optional runtimes would double-count.

## Result and remaining accounting gap

Known optional names now have an explicit proposed boundary, later-work reason and
reopen condition. This closes the *omission of names*, not the program's E1 requirement
for candidates still genuinely relevant to a selected responsibility. Most archived
additional harnesses still lack exact source/implementation/test/license evidence.
Root must explicitly record that incompleteness or authorize a bounded pin/source
screening packet later; this no-network synthesis cannot truthfully manufacture it.
No optional connector is implemented or claimed supported, and no candidate is
rejected solely because its ecosystem or license requires closer inspection.
