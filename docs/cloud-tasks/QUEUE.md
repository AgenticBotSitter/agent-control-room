# Cloud work queue

Scheduled cloud workers read this file from branch `cloud/queue`. Each line below the marker is one task: `<task-id> <base-branch>`. The task file is `docs/cloud-tasks/<task-id>.md` on that base branch. A task is taken when a branch `cloud/<task-id>` exists on origin. Workers take the first untaken task, top to bottom.

<!-- tasks -->
