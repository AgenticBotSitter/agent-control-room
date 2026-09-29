import { createMacLocalRestrictedTaskApplicationV1 } from "./mac-local-restricted-task-composition";
import { createMacLocalTaskApplicationV1 } from "./mac-local-task-application";
import type { TaskCoordinatorConfiguration } from "./task-coordinator-lifecycle";

/** Adds an already-qualified, text-only Claude delivery capability to the
 * same restricted Mac task lifecycle used by Hermes. No process, permission,
 * queue, or result authority is created here. */
export async function createMacLocalRestrictedClaudeTaskApplicationV1(input: Parameters<typeof createMacLocalRestrictedTaskApplicationV1>[0] & Readonly<{
  claude: NonNullable<TaskCoordinatorConfiguration["claudeCodeLocal"]>;
}>) {
  if (!input.claude || typeof input.claude.deliver !== "function")
    throw new Error("mac_local_restricted_claude_task_composition_invalid");
  const { claude, ...restricted } = input;
  return createMacLocalRestrictedTaskApplicationV1(restricted, {
    createTaskApplication: value => createMacLocalTaskApplicationV1({ ...value,
      coordinator: Object.freeze({ ...value.coordinator, claudeCodeLocal: claude }),
    }),
  });
}
