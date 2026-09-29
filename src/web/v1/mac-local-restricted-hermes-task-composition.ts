import { createMacLocalHermesTaskApplicationV1 } from "./mac-local-hermes-task-application";
import { createMacLocalRestrictedTaskApplicationV1 } from "./mac-local-restricted-task-composition";

/**
 * The protected-launcher seam for the first real local worker. It combines
 * only the already-existing restricted-role composition and Hermes queue
 * bridge; it does not construct a queue, database, result store, or runner.
 */
export async function createMacLocalRestrictedHermesTaskApplicationV1(input: Parameters<typeof createMacLocalRestrictedTaskApplicationV1>[0] & Readonly<{
  hermes: Parameters<typeof createMacLocalHermesTaskApplicationV1>[0]["hermes"];
}>) {
  const { hermes, ...restricted } = input;
  return createMacLocalRestrictedTaskApplicationV1(restricted, {
    createTaskApplication: value => createMacLocalHermesTaskApplicationV1({ ...value, hermes }),
  });
}
