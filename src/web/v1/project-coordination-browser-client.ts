// Project-coordination browser client.
//
// Reads the coordination page, and submits owner-authorised lifecycle calls
// (appoint, replace, revoke, pause, resume, revoke-policy). The page renders
// the response, never recomputes it; the browser never sends a payload that
// could itself become authority (a coordinator identity that is also the
// executor, an action against a stale revision, an unauthenticated retry).
//
// All requests use the same-origin credentials, JSON accept header, and
// 10-second timeout that the rest of the web v1 client surface uses. Writes
// carry an idempotency key the server uses to refuse a duplicate commit.

import {
  BrowserRequestError,
  browserAuthenticationRecovery,
  type BrowserFailureCode,
} from "./browser-client";
import {
  projectCoordinationActionResultSchema,
  projectCoordinationPageSchema,
  projectCoordinatorAppointRequestSchema,
  projectCoordinatorPausePolicyRequestSchema,
  projectCoordinatorReplaceRequestSchema,
  projectCoordinatorResumePolicyRequestSchema,
  projectCoordinatorRevokePolicyRequestSchema,
  projectCoordinatorRevokeRequestSchema,
  type ProjectCoordinationActionResult,
  type ProjectCoordinationPage,
  type ProjectCoordinatorAppointRequest,
  type ProjectCoordinatorRevokePolicyRequest,
  type ProjectCoordinatorRevokeRequest,
} from "./project-coordination-wire";
import { catalogProjectIdSchema } from "./project-wire";

const READ_LIMIT = 65_536;
const WRITE_LIMIT = 16_384;
const TIMEOUT_MS = 10_000;

function readJson(transport: typeof fetch): typeof JSON.parse {
  return JSON.parse;
}

function retryableWriteFailure(code: BrowserFailureCode): boolean {
  // 401/403 mean the session itself is broken: the recovery copy tells the
  // operator to sign in again rather than retry, so the browser surfaces a
  // real recovery error.
  return code === "unavailable" || code === "conflict" || code === "uncertain";
}

async function readCoordinationJson(
  path: string,
  transport: typeof fetch,
): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await transport(path, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: abort.signal,
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
    });
    if (!response.ok) {
      if (response.status === 401) throw new BrowserRequestError("authentication_required");
      if (response.status === 403) throw new BrowserRequestError("access_denied");
      if (response.status === 404) throw new BrowserRequestError("not_found");
      throw new BrowserRequestError("unavailable");
    }
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (contentType !== "application/json" || !response.body) {
      throw new BrowserRequestError("unavailable");
    }
    reader = response.body.getReader();
    const bytes: number[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (bytes.length + value.length > READ_LIMIT) {
        throw new BrowserRequestError("unavailable");
      }
      for (const byte of value) bytes.push(byte);
    }
    return readJson(transport)(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
  } catch (error) {
    if (error instanceof BrowserRequestError) throw error;
    throw new BrowserRequestError("unavailable");
  } finally {
    clearTimeout(timer);
    abort.abort();
    void reader?.cancel().catch(() => {});
  }
}

async function writeCoordinationJson(
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  idempotencyKey: string,
  transport: typeof fetch,
): Promise<unknown> {
  const serialised = JSON.stringify(body);
  if (serialised.length > WRITE_LIMIT) {
    throw new BrowserRequestError("invalid_request");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await transport(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: abort.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-requested-with": "XMLHttpRequest",
      },
      body: serialised,
    });
    if (!response.ok) {
      if (response.status === 401) {
        throw new BrowserAuthenticationRecoverySignal();
      }
      if (response.status === 403) throw new BrowserRequestError("access_denied");
      if (response.status === 409) throw new BrowserRequestError("conflict");
      if (response.status === 422) throw new BrowserRequestError("invalid_request");
      if (response.status === 404) throw new BrowserRequestError("not_found");
      throw new BrowserRequestError("unavailable");
    }
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (contentType !== "application/json" || !response.body) {
      throw new BrowserRequestError("unavailable");
    }
    reader = response.body.getReader();
    const bytes: number[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (bytes.length + value.length > WRITE_LIMIT) {
        throw new BrowserRequestError("unavailable");
      }
      for (const byte of value) bytes.push(byte);
    }
    return readJson(transport)(
      new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)),
    );
  } catch (error) {
    if (error instanceof BrowserRequestError) throw error;
    if (error instanceof BrowserAuthenticationRecoverySignal) {
      throw new BrowserRequestError("authentication_required");
    }
    throw new BrowserRequestError("uncertain");
  } finally {
    clearTimeout(timer);
    abort.abort();
    void reader?.cancel().catch(() => {});
  }
}

class BrowserAuthenticationRecoverySignal extends Error {}

export async function readProjectCoordination(
  projectId: string,
  transport: typeof fetch = fetch,
): Promise<ProjectCoordinationPage> {
  if (!catalogProjectIdSchema.safeParse(projectId).success) {
    throw new BrowserRequestError("invalid_request");
  }
  let parsed: unknown;
  try {
    parsed = await readCoordinationJson(
      `/api/v1/projects/${encodeURIComponent(projectId)}/coordination`,
      transport,
    );
  } catch (error) {
    if (error instanceof BrowserRequestError) throw error;
    throw new BrowserRequestError("unavailable");
  }
  try {
    return projectCoordinationPageSchema.parse(parsed);
  } catch {
    throw new BrowserRequestError("unavailable");
  }
}

async function submitAction(
  projectId: string,
  action:
    | "appoint-coordinator"
    | "replace-coordinator"
    | "revoke-coordinator"
    | "pause-policy"
    | "resume-policy"
    | "revoke-policy",
  body: unknown,
  idempotencyKey: string,
  transport: typeof fetch,
): Promise<ProjectCoordinationActionResult> {
  if (!catalogProjectIdSchema.safeParse(projectId).success) {
    throw new BrowserRequestError("invalid_request");
  }
  let parsed: unknown;
  try {
    parsed = await writeCoordinationJson(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/coordination/${action}`,
      body,
      idempotencyKey,
      transport,
    );
  } catch (error) {
    if (error instanceof BrowserRequestError) {
      if (error.code === "authentication_required") {
        // Surface the locally generated recovery copy. The server response body
        // is never echoed back to the user; we always render our own copy.
        throw new BrowserAuthenticationRecoveryError();
      }
      if (retryableWriteFailure(error.code)) {
        throw new BrowserRequestError("uncertain");
      }
      throw error;
    }
    throw new BrowserRequestError("uncertain");
  }
  try {
    return projectCoordinationActionResultSchema.parse(parsed);
  } catch {
    throw new BrowserRequestError("unavailable");
  }
}

function defaultKeyFactory(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `coordination-${crypto.randomUUID()}`;
  }
  return `coordination-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function appointProjectCoordinator(
  request: ProjectCoordinatorAppointRequest,
  options: { idempotencyKey?: string; transport?: typeof fetch } = {},
): Promise<ProjectCoordinationActionResult> {
  const parsed = projectCoordinatorAppointRequestSchema.parse(request);
  return submitAction(
    parsed.projectId,
    "appoint-coordinator",
    parsed,
    options.idempotencyKey ?? defaultKeyFactory(),
    options.transport ?? fetch,
  );
}

export async function replaceProjectCoordinator(
  request: ProjectCoordinatorAppointRequest,
  options: { idempotencyKey?: string; transport?: typeof fetch } = {},
): Promise<ProjectCoordinationActionResult> {
  const parsed = projectCoordinatorReplaceRequestSchema.parse(request);
  return submitAction(
    parsed.projectId,
    "replace-coordinator",
    parsed,
    options.idempotencyKey ?? defaultKeyFactory(),
    options.transport ?? fetch,
  );
}

export async function revokeProjectCoordinator(
  request: ProjectCoordinatorRevokeRequest,
  options: { idempotencyKey?: string; transport?: typeof fetch } = {},
): Promise<ProjectCoordinationActionResult> {
  const parsed = projectCoordinatorRevokeRequestSchema.parse(request);
  return submitAction(
    parsed.projectId,
    "revoke-coordinator",
    parsed,
    options.idempotencyKey ?? defaultKeyFactory(),
    options.transport ?? fetch,
  );
}

export async function pauseProjectDelegationPolicy(
  request: ProjectCoordinatorRevokePolicyRequest,
  options: { idempotencyKey?: string; transport?: typeof fetch } = {},
): Promise<ProjectCoordinationActionResult> {
  const parsed = projectCoordinatorPausePolicyRequestSchema.parse(request);
  return submitAction(
    parsed.projectId,
    "pause-policy",
    parsed,
    options.idempotencyKey ?? defaultKeyFactory(),
    options.transport ?? fetch,
  );
}

export async function resumeProjectDelegationPolicy(
  request: ProjectCoordinatorRevokePolicyRequest,
  options: { idempotencyKey?: string; transport?: typeof fetch } = {},
): Promise<ProjectCoordinationActionResult> {
  const parsed = projectCoordinatorResumePolicyRequestSchema.parse(request);
  return submitAction(
    parsed.projectId,
    "resume-policy",
    parsed,
    options.idempotencyKey ?? defaultKeyFactory(),
    options.transport ?? fetch,
  );
}

export async function revokeProjectDelegationPolicy(
  request: ProjectCoordinatorRevokePolicyRequest,
  options: { idempotencyKey?: string; transport?: typeof fetch } = {},
): Promise<ProjectCoordinationActionResult> {
  const parsed = projectCoordinatorRevokePolicyRequestSchema.parse(request);
  return submitAction(
    parsed.projectId,
    "revoke-policy",
    parsed,
    options.idempotencyKey ?? defaultKeyFactory(),
    options.transport ?? fetch,
  );
}

// Mirror the queue-attention surface: locally generated recovery copy that
// never echoes a server response body.
export class BrowserAuthenticationRecoveryError extends BrowserRequestError {
  heldKey: boolean;
  constructor(heldKey = false) {
    super("authentication_required");
    this.heldKey = heldKey;
    this.message = browserAuthenticationRecovery(heldKey);
  }
}

// Re-export the base class so workspace components can `instanceof`-narrow
// without re-importing from the base module.
export { BrowserRequestError } from "./browser-client";
export { browserErrorMessage } from "./browser-client";
