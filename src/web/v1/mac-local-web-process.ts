import type { DatabaseClient } from "../../persistence/database";
import { WebAccessError } from "./access-verifier";
import { readBoundedJson, privateResponseHeaders, webFailure } from "./http-common";
import { captureLocalOwnerSessionProfileV1, LocalOwnerSessionServiceV1, readLocalOwnerCodeV1,
  renderLocalOwnerSignInPageV1, type LocalOwnerSessionProfileV1 } from "./local-owner-session";
import { WebProjectService } from "./project-service";

export interface MacLocalWebProcessOptionsV1 {
  origin: string;
  localOwnerSession: Readonly<LocalOwnerSessionProfileV1>;
  workspaceId: string;
  database: { client: DatabaseClient; close: () => Promise<void> };
  clock?: () => number;
}

async function readProjectBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !request.body)
    throw new WebAccessError("invalid_request");
  return readBoundedJson(request.body, 8192);
}

/**
 * The first real Mac-local web composition. It has a fixed loopback-only owner
 * authentication seam and reuses the normal project service and its database
 * session/grant checks. It does not alter the hosted Cloudflare process.
 */
export function createMacLocalWebProcessV1(options: MacLocalWebProcessOptionsV1) {
  const profile = captureLocalOwnerSessionProfileV1(options.localOwnerSession);
  const origin = new URL(options.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.origin !== options.origin
    || profile.origin !== options.origin || !options.workspaceId || !options.database || typeof options.database.close !== "function")
    throw new Error("mac_local_web_process_config_invalid");
  const clock = options.clock ?? Date.now;
  const sessions = new LocalOwnerSessionServiceV1(profile);
  const projects = new WebProjectService(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock);
  let closed: Promise<void> | undefined;

  async function handle(request: Request, render: () => Promise<Response> | Response): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== options.origin) throw new WebAccessError("access_denied");
      if (url.pathname === "/session") {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        return renderLocalOwnerSignInPageV1();
      }
      if (url.pathname === "/api/v1/local-owner-session") {
        if (request.method !== "POST" || url.search) throw new WebAccessError("invalid_request");
        const issued = await sessions.issue(request, await readLocalOwnerCodeV1(request), clock());
        return Response.json({ authenticated: true, expiresAt: issued.expiresAt }, { status: 201,
          headers: { ...privateResponseHeaders, "set-cookie": issued.cookie } });
      }
      const identity = sessions.verify(request, clock());
      if (url.pathname === "/api/v1/projects") {
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].some(key => !["after", "lifecycle"].includes(key))
            || ["after", "lifecycle"].some(key => url.searchParams.getAll(key).length > 1)) throw new WebAccessError("invalid_request");
          return Response.json(await projects.listPage(identity, url.searchParams.get("after") ?? undefined,
            url.searchParams.get("lifecycle") as Parameters<WebProjectService["listPage"]>[2] ?? undefined), { headers: privateResponseHeaders });
        }
        if (request.method === "POST" && !url.search) {
          const idempotencyKey = request.headers.get("idempotency-key") ?? "";
          return Response.json(await projects.create(identity, await readProjectBody(request), idempotencyKey),
            { status: 201, headers: privateResponseHeaders });
        }
        throw new WebAccessError("invalid_request");
      }
      if (["/", "/projects"].includes(url.pathname)) {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        await projects.authorizeCatalog(identity);
        const response = await render();
        for (const [name, value] of Object.entries(privateResponseHeaders)) response.headers.set(name, value);
        return response;
      }
      throw new WebAccessError("not_found");
    } catch (error) { return webFailure(error); }
  }

  return Object.freeze({ handle, close: () => closed ??= options.database.close() });
}
