import { z } from "zod";

const environmentSchema = z.enum(["development", "test", "production"]);

export interface RuntimeConfig {
  environment: "development" | "test" | "production";
  workspaceId: string;
  databaseUrl?: string;
  publicOrigin?: string;
  sessionSecret?: string;
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

export function loadRuntimeConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const environment = environmentSchema.parse(env.NODE_ENV ?? "development");
  const workspaceId = z.string().min(3).parse(env.CONTROL_ROOM_WORKSPACE_ID ?? "control-room-local");
  const databaseUrl = optionalNonEmpty(env.DATABASE_URL);
  const publicOrigin = optionalNonEmpty(env.CONTROL_ROOM_PUBLIC_ORIGIN);
  const sessionSecret = optionalNonEmpty(env.CONTROL_ROOM_SESSION_SECRET);
  if (environment === "production") {
    if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error("Production requires a PostgreSQL DATABASE_URL");
    if (!publicOrigin) throw new Error("Production requires CONTROL_ROOM_PUBLIC_ORIGIN");
    const origin = new URL(publicOrigin);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
      throw new Error("Production public origin must be a clean HTTPS origin");
    }
    if (!sessionSecret || sessionSecret.length < 32) throw new Error("Production requires a CONTROL_ROOM_SESSION_SECRET of at least 32 characters");
    if (/^(.)\1+$/.test(sessionSecret) || /^(?:change[-_ ]?me|password|secret)/i.test(sessionSecret)) {
      throw new Error("Production CONTROL_ROOM_SESSION_SECRET appears to be a placeholder");
    }
  }
  return { environment, workspaceId, ...(databaseUrl ? { databaseUrl } : {}), ...(publicOrigin ? { publicOrigin } : {}), ...(sessionSecret ? { sessionSecret } : {}) };
}

export function safeConfigSummary(config: RuntimeConfig): Omit<RuntimeConfig, "sessionSecret" | "databaseUrl"> & { hasDatabaseUrl: boolean; hasSessionSecret: boolean } {
  const { databaseUrl, sessionSecret, ...safe } = config;
  return { ...safe, hasDatabaseUrl: Boolean(databaseUrl), hasSessionSecret: Boolean(sessionSecret) };
}
