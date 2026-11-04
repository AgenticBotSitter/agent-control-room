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
linux-loop-postgres-verification cloud-base/linux-loop-postgres-verification
linux-b5-lanes-verification cloud-base/linux-b5-lanes-verification
linux-loop-component-soak cloud-base/linux-loop-component-soak
monitor-umask-diagnosis cloud-base/monitor-umask-diagnosis
mutation-timeout-diagnosis cloud-base/mutation-timeout-diagnosis
b5-inventory-own-keys cloud-base/b5-inventory-own-keys
b5-restart-outcome-matrix cloud-base/b5-restart-outcome-matrix
b5-mailbox-closed-http cloud-base/b5-mailbox-closed-http
b5-start-digest-schema cloud-base/b5-start-digest-schema
b5-session-cleanup-boundary cloud-base/b5-session-cleanup-boundary
ci-preinstall-import-isolation cloud-base/ci-preinstall-import-isolation
bridge-shared-synthetic-fixture cloud-base/bridge-shared-synthetic-fixture
monitor-contention-observed-lock cloud-base/monitor-contention-observed-lock
b5-repeat-evidence-custody cloud-base/b5-repeat-evidence-custody
cluster-quit-oracle-diagnostics cloud-base/cluster-quit-oracle-diagnostics
