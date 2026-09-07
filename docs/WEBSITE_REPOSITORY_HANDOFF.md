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
- Domain and actual VPS deployment remain to be confirmed separately.

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
