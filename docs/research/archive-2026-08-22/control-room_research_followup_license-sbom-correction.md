# License/SBOM Correction — Gate 8

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Gate evidence for:** Gate 8 in `docs/RESEARCH_SYNTHESIS_AND_BUILD_DECISIONS.md`
**Machine-readable inventory:** `cr-sbom-2026-08-22.json` (same folder)

---

## TL;DR

Correction delivered on two axes. **(1) Count error found and fixed:** the prior matrix TL;DR said "four need care" but its own table contains SIX restricted components (khoj AGPL, superset-sh ELv2, forge FSL, AutoGPT platform-split Polyform, inngest SSPL, restate BSL) — corrected to "15 of 21 fully permissive; 6 restricted." **(2) Went below repo level** to exact packages: Codex CLI npm pkg is Apache-2.0 (0.149.0); Claude Code CLI stays proprietary at package level (2.1.240) while the Python agent SDK (`claude-agent-sdk` 0.2.144) is genuinely MIT — a split that matters if we ever vendor bindings; hermes-agent's 24 exact-pinned runtime deps inventoried with licenses (all permissive; two MPL file-copyleft items noted). Full JSON SBOM written for tooling.

## Package-level findings (all fetched 2026-08-22)

| Component | Package @ version | Registry license | File-verified? | Allowed uses |
|---|---|---|---|---|
| Codex CLI | @openai/codex @ 0.149.0 | Apache-2.0 | ✅ earlier session | internal/redist/hosted/integration |
| Claude Code CLI | @anthropic-ai/claude-code @ 2.1.240 | SEE LICENSE IN README → proprietary | ✅ LICENSE.md | internal only |
| Claude Agent SDK TS | @anthropic-ai/claude-agent-sdk @ 0.3.240 | SEE LICENSE IN README | ❌ [verify before vendoring] | internal only (presumed) |
| Claude Agent SDK Py | claude-agent-sdk @ 0.2.144 (PyPI) | MIT | repo spdx MIT | all four |
| Hatchet server / SDK | hatchet-dev/hatchet; hatchet-sdk 1.37.5 | MIT / MIT | ✅ server file | all four |
| Temporal SDK | temporalio 1.31.0 (PyPI) | field empty; repo MIT | ❌ confirm classifier | all four (pending confirm) |
| Bitwarden bws/clients | bws binary; bitwarden/clients | GPL-3.0 family (NOASSERTION in API) | ❌ | internal only (GPL obligations on redistribution) |
| 1Password Connect | 1Password/connect | none in API metadata | ❌ [verify] | internal pending |
| Uptime Kuma image | louislam/uptime-kuma 1.x | MIT | ❌ | all four |
| Beszel | henrygd/beszel | MIT | ❌ | all four |
| Vector | vectordotdev/vector | MPL-2.0 | ❌ | all four (file-level copyleft) |

## Hermes runtime dependency inventory (exact pins from pyproject.toml v0.20.4)

24 core deps verified from PyPI this session — every one permissive (Apache/BSD/MIT/MPL-file-level): openai(Apache), certifi(MPL), python-dotenv(BSD), fire(Apache), httpx(BSD), rich(MIT), tenacity(Apache), pyyaml(MIT), ruamel.yaml(MIT), requests(Apache), jinja2(BSD), pydantic(MIT), prompt_toolkit(BSD), croniter(MIT), packaging(Apache/BSD), Markdown(BSD), PyJWT(MIT), cryptography(Apache/BSD dual), psutil(BSD), websockets(BSD), pathspec(MPL), Pillow(MIT-CMU), aiohttp(Apache+MIT), anthropic(MIT).

Notable supply-chain posture found in pyproject comments: Hermes exact-pins everything specifically because of the 2026-05-12 Mini Shai-Hulud npm/PyPI worm incident — worth copying as OUR policy for any control-room service we build.

## NOTICE/attribution obligations
None beyond normal copyright-header retention for the permissive set; GPL items (Bitwarden clients/bws) carry source-offer duties only if we distribute them — running internally is clean; MPL items require file-level source disclosure only if modified files are redistributed.

## Usage-class summary
- **Internal use:** everything in this SBOM is clear.
- **Redistribution:** blocked only for Claude Code CLI (+TS SDK presumed), Bitwarden GPL bits.
- **Hosted-service offering:** additionally blocked by khoj(AGPL), superset(ELv2), forge(FSL), inngest(SSPL), restate(BSL) IF those components are embedded — none currently planned in CR build.
- **External integration:** no additional blockers beyond the above.

## Machine-readable artifact
`cr-sbom-2026-08-22.json` — schema {component, package, version, registry, license_declared, license_verified_from_file, spdx_or_custom, notice_obligations, allowed_use_classes, source_url} + hermes_deps_exact_pins block + corrections block.

## Risks & triggers
1. TS SDK license assumed-proprietary from README pointer — verify file before any vendoring (trigger: first time we import it).
2. temporalio PyPI empty license field — confirm against repo LICENSE before adoption (trigger: workflow-engine revisit).
3. Registry latest versions drift weekly — rerun fetch script quarterly or wire into CI-style check.

## Report-format compliance
Sources: registry.npmjs.org, pypi.org, api.github.com, raw LICENSE.md (all 2026-08-22); versions pinned per row; tested-vs-documented = registry-metadata vs file-verified columns; sanitized commands (fetch scripts in /tmp/gate18_fetch.py, deps_licenses.py); A/W/B/B/D not applicable per-item (compliance dossier) — usage classes serve as the decision axis; risks+triggers above.
