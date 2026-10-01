import { readFile } from "node:fs/promises";
import { checkForConnectorUpdateV1 } from "../../scripts/fleet/connector-update.mjs";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));

try {
  const config = JSON.parse(await readFile(input.configPath, "utf8"));
  const result = await checkForConnectorUpdateV1({
    installRoot: input.installRoot,
    configPath: input.configPath,
    config,
    advertised: input.advertised,
    currentVersion: input.currentVersion,
    healthCheck: async () => {
      await new Promise(done => setTimeout(done, input.healthDelayMs));
      return true;
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, message: error?.message ?? "failed" })}\n`);
}
