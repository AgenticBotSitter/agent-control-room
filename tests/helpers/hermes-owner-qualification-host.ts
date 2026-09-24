import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHermes021MacosNativeOwnerQualificationHostV1,
  type Hermes021MacosSubprocessHostConfigurationV1 } from
  "../../src/harness/hermes-021-v1/subprocess-stream-json-host";

const executablePath = fileURLToPath(new URL("../fixtures/hermes-qualification-result.mjs", import.meta.url));

export function hermesOwnerQualificationConfigurationFixture(
  overrides: Partial<Hermes021MacosSubprocessHostConfigurationV1> = {}): Hermes021MacosSubprocessHostConfigurationV1 {
  return Object.freeze({ executablePath, profile: "owner-profile", model: "owner-model", provider: "owner-provider",
    workingDirectory: dirname(executablePath), ...overrides });
}

/** Uses the non-injectable native constructor with a local non-Hermes executable. */
export function createHermesOwnerQualificationHostFixture(
  configuration: Hermes021MacosSubprocessHostConfigurationV1) {
  return createHermes021MacosNativeOwnerQualificationHostV1(configuration);
}
