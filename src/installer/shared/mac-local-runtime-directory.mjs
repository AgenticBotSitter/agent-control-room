import { join } from "node:path";

/** Installed services receive the sandbox's writable tree; dev keeps its default. */
export function macLocalRuntimeDirectoryV1(protectedRoot, environment = process.env) {
  return environment.RUNTIME_STATE || join(protectedRoot, "runtime");
}
