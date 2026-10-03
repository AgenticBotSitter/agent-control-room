import { BrowserRequestError } from "./browser-client";

/** A fresh action key for ONE owner create action.
 *
 * Generated per submission, never per render, and reused for every retry of
 * that same submission - which is the whole point. The caller holds it in the
 * state that describes the pending action, so a retry after a lost reply
 * reuses the key and the server answers with the original skill instead of
 * creating a second one. A genuinely new save gets a new key, which is what
 * makes a deliberate duplicate a deliberate duplicate.
 *
 * `crypto.randomUUID` is used when available and a counter-seeded fallback
 * otherwise, so the key is unique per submission rather than merely
 * well-formed. It is an idempotency token, never a secret: it carries no
 * authority of its own, and the server binds it to the authenticated project
 * and the exact content. */
export function newSkillCreateActionKeyV1(): string {
  const unique = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${(Math.random() * 0xffffffff).toString(36)}`;
  return `skill-create:${unique}`;
}

export type ReusableSkillViewV1 = Readonly<{ skillId: string; name: string; currentVersion: number;
  state: "active" | "retired"; instructions: string; contentDigest: string }>;
export type ReusableSkillPageV1 = Readonly<{ projectId: string; skills: readonly ReusableSkillViewV1[];
  /** Non-null when more skills exist past this page. A null cursor on a full
   * page is impossible, so a caller can never mistake a truncated page for the
   * whole list. */
  nextCursor: string | null;
  startsWork: false; grantsExecutionAuthority: false }>;

async function response<T>(request: (signal: AbortSignal) => Promise<Response>, write = false): Promise<T> {
  const controller = new AbortController();
  const failure = write ? "uncertain" : "unavailable";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new BrowserRequestError(failure)); }, 10_000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const value = await request(controller.signal);
      if (!value.ok) throw new BrowserRequestError(value.status === 401 ? "authentication_required"
        : value.status === 403 ? "access_denied" : value.status === 404 ? "not_found"
          : value.status === 409 ? "conflict" : value.status === 400 ? "invalid_request" : failure);
      return await value.json() as T;
    })()]);
  } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError(failure); }
  finally { clearTimeout(timer); }
}

export function createReusableSkillBrowserClientV1(transport: typeof fetch = fetch) {
  const base = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/skills`;
  return Object.freeze({
    list: (projectId: string, after?: string) => response<ReusableSkillPageV1>(signal => transport(
      after === undefined ? base(projectId) : `${base(projectId)}?after=${encodeURIComponent(after)}`,
      { method: "GET", redirect: "error", cache: "no-store", signal })),
    create: (projectId: string, body: unknown, actionKey: string) => response(signal => transport(base(projectId), { method: "POST",
      redirect: "error", cache: "no-store", signal,
      headers: { "content-type": "application/json", "idempotency-key": actionKey }, body: JSON.stringify(body) }), true),
    update: (projectId: string, skillId: string, body: unknown) => response(signal => transport(
      `${base(projectId)}/${encodeURIComponent(skillId)}`, { method: "PUT", redirect: "error", cache: "no-store", signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), true),
  });
}
