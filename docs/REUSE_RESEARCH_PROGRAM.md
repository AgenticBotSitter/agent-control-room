# Reuse-first research program

Agent Control Room builds custom code only for the product-specific connections
that existing projects cannot safely provide. Before starting a substantial
component, the lead records a short source-code and license evaluation here or
in the component decision register.

## The rule

For every build package, evaluate the best available existing code first.
"Evaluate" means reading the relevant source files and tests—not only a
README—and answering:

1. What exact capability does it already provide?
2. Can it fit our one PostgreSQL authority, one scheduler, signed delivery,
   result/review/correction lifecycle, and private configuration boundary?
3. What would be adopted, what small adapter would remain, and what competing
   authority, scheduler, credential store, session store, or deployment system
   must stay out?
4. Is its license compatible with this repository and are notices required?
5. Does it have meaningful tests, maintenance, and a practical integration
   path?

The result is one of: **adopt**, **adapt narrowly**, **reference only**, or
**write a small Control Room-specific connector**. The last result requires a
specific reason.

## Efficient stopping rule

Do not compare an endless list of nearly identical tools. Start with previously
inspected candidates, then examine at most two additional strong candidates
when a real gap remains. Stop when one candidate passes the fit test or when
the remaining work is uniquely Control Room's security/authority connection.
Record the decision and begin the implementation package.

## Research lanes

| Build area | First source candidates | What can be reused | What must remain Control Room-owned |
| --- | --- | --- | --- |
| Local Hermes Agent | Hermes Agent contracts, Hermes WebUI/Desktop, Hermes GPT evaluation | capability/status displays, terminal/session presentation, supported runner behavior | signed task admission, authority rechecks, result/review records, private runner binding |
| Local Claude Code | official Claude Code contracts, carefully reviewed runner projects | fixed-command invocation patterns, bounded stream decoding, process cleanup tests | Control Room task authority, receipt/retry rules, private credentials and lifecycle |
| Local Codex | official Codex/App Server contracts, evaluated terminal/session projects | App Server framing, process/session observation, workspace preparation | macOS custody boundary, project authority, review/result lifecycle |
| Local interface | Control Center, Hermes WebUI/Desktop, T3 Code | project/status/news/session presentation patterns | the product's security, task and evidence pages |
| Remote workers | Hermes remote artifact delivery, Herdr, reviewed transport candidates | connection observation, reconnect/status presentation, artifact return mechanics | enrollment, revocation, signed delivery, one canonical task/result history |
| Installation and supervision | Ralph Sandbox and reviewed service/launcher examples | isolated workspace, containment, resource/stall observation, launcher patterns | private configuration, authority/database composition, safe upgrades |
| Backup, relocation and recovery | existing PostgreSQL export/restore code, Restic adapter | backup manifests, restore checks, artifact inventory | cutover fencing, one-writer activation, rollback decision state |
| Contributor review | Alibaba Open Code Review and existing GitHub App work | optional independent code-review checks and review presentation | final acceptance, security decisions, merge authority |

## Work packet format

Each research packet names one build area, an immutable source revision, exact
files/tests to inspect, license check, expected integration seam, and a short
comparison table. It does not authorize installing a donor project, copying a
whole application, changing credentials, or starting a live service.

## Parallel research without duplicated effort

Run separate reviewers by lane: local harnesses, interface, remote delivery,
and installation/recovery. A reviewer owns only its lane and produces a concise
decision record. The lead resolves overlaps, preserves notices, and assigns
the resulting substantial implementation package. Public contributors may
take a lane from the live work queue; no specific bot or person is required.
