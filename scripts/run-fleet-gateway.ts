// Starts the control-side fleet gateway that remote worker connectors call.
//
//   pnpm fleet:gateway <protected-config.json>
//
// It listens on loopback only. Reach it from other machines through the
// private route you already use for the app (Tailscale Serve, or a Cloudflare
// Tunnel hostname without Cloudflare Access on the /fleet/ path, because the
// connector authenticates with its own machine credential). The config file
// holds the fleet gateway database login and must be readable only by you.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration,
  type PrivatePostgresConfiguration } from "../src/web/v1/private-postgres";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1 } from "../src/fleet/v1";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";

export const FLEET_GATEWAY_CONFIGURATION_V1 = "control-room.fleet-gateway/v1";
type Configuration = Readonly<{ schema: typeof FLEET_GATEWAY_CONFIGURATION_V1; tenantId: string; port: number;
  database: PrivatePostgresConfiguration; workIntake?: Readonly<{ database: PrivatePostgresConfiguration; integrityKey: string }> }>;

export function captureFleetGatewayConfigurationV1(value: unknown): Configuration {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object" || input.schema !== FLEET_GATEWAY_CONFIGURATION_V1
    || typeof input.tenantId !== "string" || !Number.isSafeInteger(input.port) || (input.port as number) < 1024
    || (input.port as number) > 65535) throw new Error("fleet_gateway_configuration_refused");
  const database = validatePrivatePostgresConfiguration(input.database as PrivatePostgresConfiguration);
  if (database.username !== "control_room_fleet") throw new Error("fleet_gateway_configuration_refused");
  let workIntake: Configuration["workIntake"];
  if (input.workIntake !== undefined) {
    const intake = input.workIntake as Record<string, unknown>;
    const intakeDatabase = validatePrivatePostgresConfiguration(intake.database as PrivatePostgresConfiguration);
    if (intakeDatabase.username !== "control_room_work_intake_agent" || typeof intake.integrityKey !== "string"
      || !/^[A-Za-z0-9_-]{43}$/u.test(intake.integrityKey)) throw new Error("fleet_gateway_configuration_refused");
    workIntake = { database: intakeDatabase, integrityKey: intake.integrityKey };
  }
  return Object.freeze({ schema: FLEET_GATEWAY_CONFIGURATION_V1, tenantId: input.tenantId, port: input.port as number,
    database, ...(workIntake ? { workIntake } : {}) });
}

async function main(path: string | undefined) {
  if (!path) throw new Error("Usage: pnpm fleet:gateway <protected-config.json>");
  const info = await stat(path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("The gateway config must be readable only by its owner.");
  const config = captureFleetGatewayConfigurationV1(JSON.parse(await readFile(path, "utf8")));
  const fleetDatabase = createPrivatePostgresDatabase(config.database);
  const intakeDatabase = config.workIntake ? createPrivatePostgresDatabase(config.workIntake.database) : undefined;
  const store = new FleetGatewayStoreV1(fleetDatabase.client, { tenantId: config.tenantId });
  const proposals = intakeDatabase && config.workIntake ? new WorkBatchServiceV1(new WorkBatchStoreV1(intakeDatabase.client,
    new Uint8Array(Buffer.from(config.workIntake.integrityKey, "base64url")))) : undefined;
  const script = await readFile(join(dirname(fileURLToPath(import.meta.url)), "fleet", "connector.mjs"), "utf8");
  const handler = createFleetGatewayHandlerV1({ store, ...(proposals ? { proposals } : {}),
    connectorScript: { body: script, digest: `sha256:${createHash("sha256").update(script).digest("hex")}` } });
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 8192 },
    (request, response) => { void handler.handle(request, response); });
  server.listen(config.port, "127.0.0.1");
  // Owner decisions and elapsed leases are applied on a steady timer as well
  // as right after each owner action.
  const timer = setInterval(() => { void store.reconcile().catch(() => {}); }, 30_000);
  const stop = () => { clearInterval(timer); server.close(); void fleetDatabase.close(); void intakeDatabase?.close(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  process.stderr.write(`Fleet gateway listening on 127.0.0.1:${config.port}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "failed"}\n`); process.exitCode = 1; });
}
