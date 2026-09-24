import { captureMacLocalDatabaseRolesV1, type MacLocalDatabaseRolesV1 } from "./mac-local-database-roles";
import { createMacLocalTaskApplicationV1, type MacLocalTaskApplicationInputV1 } from "./mac-local-task-application";
import type { TaskCoordinatorConfiguration, TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";

type CoordinatorWithoutOwnedPools = Omit<TaskCoordinatorConfiguration, "database" | "resultDatabase">;

/**
 * Opens the two controller-owned restricted roles for the existing Mac-local
 * task lifecycle. The loopback host retains the web role it already opened.
 * This creates neither a queue worker nor an agent; callers may use the
 * returned lifecycle only after their separate startup gate succeeds.
 */
export async function createMacLocalRestrictedTaskApplicationV1(input: Readonly<{
  web: MacLocalTaskApplicationInputV1["web"];
  databaseRoles: MacLocalDatabaseRolesV1;
  openDatabase(configuration: MacLocalDatabaseRolesV1["coordinator"]): TaskCoordinatorDatabase;
  coordinator: CoordinatorWithoutOwnedPools;
}>) {
  if (!input?.web?.database || !input?.coordinator || typeof input.openDatabase !== "function")
    throw new Error("mac_local_restricted_task_composition_invalid");
  const roles = captureMacLocalDatabaseRolesV1(input.databaseRoles);
  let coordinator: TaskCoordinatorDatabase | undefined;
  let results: TaskCoordinatorDatabase | undefined;
  try {
    coordinator = input.openDatabase(roles.coordinator);
    results = input.openDatabase(roles.results);
    if (!coordinator || !results || coordinator === results || coordinator.client === results.client
      || coordinator.client === input.web.database.client || results.client === input.web.database.client)
      throw new Error("mac_local_restricted_task_composition_invalid");
    return await createMacLocalTaskApplicationV1({ web: input.web,
      coordinator: Object.freeze({ ...input.coordinator, database: coordinator, resultDatabase: results }),
    });
  } catch (error) {
    const settled = await Promise.allSettled([coordinator?.close(), results?.close()].filter(Boolean));
    if (settled.some(value => value.status === "rejected"))
      throw new Error("mac_local_restricted_task_composition_cleanup_uncertain");
    throw error;
  }
}
