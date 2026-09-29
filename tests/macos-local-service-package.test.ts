import assert from "node:assert/strict";
import test from "node:test";
import { createMacosLocalServicePackageV1 } from "../src/harness/v1/macos-local-service-package";

const input = { label: "xyz.agentcontrolroom.local", nodePath: "/opt/node/bin/node",
  launcherPath: "/opt/control-room/scripts/run-private-vps.mjs", configurationPath: "/Users/owner/Library/Application Support/Agent Control Room/Protected/config/operator.mjs",
  workingDirectory: "/Users/owner/Library/Application Support/Agent Control Room/releases/v1",
  standardOutPath: "/Users/owner/Library/Application Support/Agent Control Room/Protected/logs/service.out.log",
  standardErrorPath: "/Users/owner/Library/Application Support/Agent Control Room/Protected/logs/service.err.log" };

test("local service package uses fixed owner paths and no secret environment", () => {
  const service = createMacosLocalServicePackageV1(input);
  assert.equal(service.startsWork, false); assert.equal(service.grantsExecutionAuthority, false);
  assert.match(service.plist, /<key>ProgramArguments<\/key>/);
  assert.match(service.plist, /<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(service.plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.doesNotMatch(service.plist, /EnvironmentVariables|GITHUB_TOKEN|--model|--provider|--profile|shell/u);
});

test("local service package refuses relative and caller-added launch inputs", () => {
  assert.throws(() => createMacosLocalServicePackageV1({ ...input, nodePath: "node" }));
  assert.throws(() => createMacosLocalServicePackageV1({ ...input, command: "sh -c anything" }));
});
