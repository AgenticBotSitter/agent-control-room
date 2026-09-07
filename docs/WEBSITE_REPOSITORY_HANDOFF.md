# Private website repository handoff

2026-09-06. Owner explicitly authorized creating a private welcome-page repository in
the existing organization and uploading setup instructions for the VPS agent.

- Repository: https://github.com/AgenticBotSitter/agent-control-room-website
- Visibility verified: private. Default branch: main.
- Initial commit: `2fc2327cf766e4bc8e42978f8f12bf94e6876936`.
- Exactly three files: index.html, styles.css, README.md.
- README source: public-site/DEPLOYMENT.md. HTML/CSS copied unchanged from public-site/.
- GitHub Actions disabled before the only initial push; verified `enabled: false`.
- Workflow runs after upload: zero. No workflows, PR, runner, schedule or deployment.
- Existing private Control Room and public product repositories were not pushed or changed.
- Johnny Five needs his own authorized repository access; none was granted or copied here.
- Owner subsequently confirmed `agentcontrolroom.xyz`; actual DNS/HTTPS and VPS
  deployment remain unverified and separately scoped.

## Transfer accounting

Available disk checked before staging: 102 GiB. No package/repository download occurred.
Fresh isolated staging clone: `/private/tmp/agent-control-room-website.3angHC`.
Purpose: upload only the website with fresh history, without touching private remotes.
Contains three source files and its new Git metadata; retained for follow-up and safe
cleanup after the remote handoff is accepted. No dependency tree or credential files copied.

## Budget policy

Batch meaningful updates and run checks locally. No scheduled automation or Actions in
the website repository unless the owner explicitly changes this policy. Normal git
pushes/pulls are not Actions runner minutes; triggered workflows can consume them.
Do not treat a daily run count as a reliable minute budget or enable paid overages.
This scoped upload does not lift the pause on unrelated Control Room GitHub writes.

## Completed identity and handoff batch

Owner requested pushing the completed updates. Website commit `f03ca15` was pushed
to private `AgenticBotSitter/agent-control-room-website/main`; it updates index.html
and README.md with the confirmed domain, maintainer, contact and public links.
Public repository README introduction was separately updated at
`f699fa0c32abfb15f0f2742dff9a8d3b68d6e398`, from
`docs/public-launch-draft/REPOSITORY_INTRO.md`. No application source or private
history was transferred to the public repository. Both repositories still have
Actions disabled. Remote public README and website HTML match the local sources.
Four welcome-page source tests pass. No DNS or website deployment was performed.

The private website Git commit used the host's inferred committer metadata. Do not
make that repository/history public without metadata review; use the approved
public name and email explicitly for future commits. No history rewrite performed.

The following notes describe the preparation preceding this completed transfer:

The owner confirmed the public name Alastair Fraser, main website
`https://agenticbotsitter.com`, project website `https://agentcontrolroom.xyz`, and
public repository `https://github.com/AgenticBotSitter/agent-control-room`.
The local welcome page and release README now use these identities and ordinary
public links, not the supplied Cloudflare dashboard links. These edits remain local;
no website transfer, deployment, DNS or GitHub security-setting change is implied.

The owner subsequently confirmed Alastair@agenticbotsitter.com as the general project
contact. Local `public-site/index.html` and `public-site/DEPLOYMENT.md` now include it;
these changes have not been transferred to the website repository or deployed. On the
next website update, map DEPLOYMENT.md to that repository's README.md as before, and
keep Actions disabled. Mail forwarding is owner-reported, not delivery-tested here.

The owner also confirmed `agentcontrolroom.xyz` as the purchased welcome-page domain;
the `.com` name is not owned. The local deployment instructions now reflect this and
must accompany the next batched transfer. The initial remote README still has the old
domain question until that update is uploaded. Do not infer a private-app hostname or
publish a private-app link from this public welcome-page domain decision.
