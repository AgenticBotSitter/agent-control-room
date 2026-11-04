# Cloud work queue

Scheduled cloud workers read this file from branch `cloud/queue`. Each line below the marker is one task: `<task-id> <base-branch>`. The task file is `docs/cloud-tasks/<task-id>.md` on that base branch. A task is taken when a branch `cloud/<task-id>` exists on origin. Workers take the first untaken task, top to bottom.

<!-- tasks -->
release-fixture-cleanup cloud-base/release-fixture-cleanup
candidate-null-down cloud-base/candidate-null-down
b5-refusal-inventory cloud-base/b5-refusal-inventory
push-23505-diagnosis cloud-base/push-23505-diagnosis
b5-repair-guard-isolation cloud-base/b5-repair-guard-isolation
b5-transport-digest-binding cloud-base/b5-transport-digest-binding
b5-device-file-custody cloud-base/b5-device-file-custody
b5-closed-interval-oracle cloud-base/b5-closed-interval-oracle
selfcheck-split-selector cloud-base/selfcheck-split-selector
