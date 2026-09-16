import type { GitHubAppInstallationAuth } from "./installation-auth";

/**
 * Bounded GitHub client for the worker-facing broker operations.
 *
 * This is deliberately not an HTTP proxy. Callers name one of a small set of
 * shapes; the client rebuilds the request URL itself, validates every query
 * parameter against a per-shape allowlist, and refuses any other path or
 * method. Installation tokens are minted through the reviewed installation
 * auth provider, stay inside this module, and are never returned, audited, or
 * echoed into an error.
 */

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const DEFAULT_MAX_PAGES = 10;
export const DEFAULT_MAX_BODY_BYTES = 2048;
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

export type BoundedGitHubRequest = Readonly<{
  /** One allowlisted request shape. */
  shape: GitHubRequestShape;
  /** Path parameters for the shape, validated against the configured repository. */
  params?: Readonly<Record<string, string | number>>;
  /** Allowlisted query parameters only. */
  query?: Readonly<Record<string, string | number>>;
  /** JSON body, permitted only for the command-comment shape. */
  body?: Readonly<{ body: string }>;
}>;

export type GitHubRequestShape =
  | "app-user"
  | "issues-list"
  | "issue-read"
  | "issue-comments-list"
  | "issue-command-comment"
  | "pulls-list"
  | "pull-read"
  | "commit-read"
  | "commit-check-runs-list";

export type BoundedGitHubResult<T = unknown> =
  | Readonly<{ ok: true; status: number; value: T }>
  | Readonly<{ ok: false; code: string; status?: number }>;

export type BoundedGitHubPage<T = unknown> = Readonly<{
  ok: true;
  items: readonly T[];
  truncated: boolean;
}> | Readonly<{ ok: false; code: string; status?: number }>;

export type BoundedGitHubAudit = Readonly<{
  shape: GitHubRequestShape;
  status?: number;
  code?: string;
  attempt: number;
}>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type QueryRules = Readonly<Record<string, RegExp>>;

const NUMBER = /^\d{1,20}$/u;
const SIGNED_NUMBER = /^-?\d{1,20}$/u;
const SHA = /^[0-9a-f]{7,40}$/u;
const LABEL = /^status%3A[a-z-]{1,32}$/u;
const POSITION = /^asc|desc$/u;
const BOT_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/u;

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Per-shape URL builders. A shape never accepts a caller-supplied path, so no
 * request can be redirected to another repository, host, or method.
 */
function shapesFor(repository: string) {
  const repo = escapeForPattern(repository);
  const repository_ = repository;
  return Object.freeze({
    "app-user": { method: "GET" as const, pattern: /^\/user$/u, build: () => "/user",
      query: Object.freeze({}) as QueryRules },
    "issues-list": { method: "GET" as const,
      pattern: new RegExp(`^/repos/${repo}/issues$`, "u"),
      build: () => `/repos/${repository_}/issues`,
      query: Object.freeze({ state: /^open$/u, labels: LABEL, per_page: /^([1-9]|[1-9]\d|100)$/u,
        page: /^[1-9]\d{0,2}$/u, direction: POSITION }) as QueryRules },
    "issue-read": { method: "GET" as const,
      pattern: new RegExp(`^/repos/${repo}/issues/\\d{1,20}$`, "u"),
      build: (params: Readonly<Record<string, string | number>>) => `/repos/${repository_}/issues/${params.number}`,
      query: Object.freeze({}) as QueryRules },
    "issue-comments-list": { method: "GET" as const,
      pattern: new RegExp(`^/repos/${repo}/issues/\\d{1,20}/comments$`, "u"),
      build: (params: Readonly<Record<string, string | number>>) =>
        `/repos/${repository_}/issues/${params.number}/comments`,
      query: Object.freeze({ per_page: /^([1-9]|[1-9]\d|100)$/u, page: /^[1-9]\d{0,2}$/u,
        direction: POSITION }) as QueryRules },
    "issue-command-comment": { method: "POST" as const,
      pattern: new RegExp(`^/repos/${repo}/issues/\\d{1,20}/comments$`, "u"),
      build: (params: Readonly<Record<string, string | number>>) =>
        `/repos/${repository_}/issues/${params.number}/comments`,
      query: Object.freeze({}) as QueryRules },
    "pulls-list": { method: "GET" as const,
      pattern: new RegExp(`^/repos/${repo}/pulls$`, "u"),
      build: () => `/repos/${repository_}/pulls`,
      query: Object.freeze({ state: /^open$/u, per_page: /^([1-9]|[1-9]\d|100)$/u,
        page: /^[1-9]\d{0,2}$/u }) as QueryRules },
    "pull-read": { method: "GET" as const,
      pattern: new RegExp(`^/repos/${repo}/pulls/\\d{1,20}$`, "u"),
      build: (params: Readonly<Record<string, string | number>>) => `/repos/${repository_}/pulls/${params.number}`,
      query: Object.freeze({}) as QueryRules },
    "commit-read": { method: "GET" as const,
      pattern: new RegExp(`^/repos/${repo}/commits/[A-Za-z0-9._/-]{1,100}$`, "u"),
      build: (params: Readonly<Record<string, string | number>>) => `/repos/${repository_}/commits/${params.ref}`,
      query: Object.freeze({}) as QueryRules },
    "commit-check-runs-list": { method: "GET" as const,
      pattern: new RegExp(`^/repos/${repo}/commits/[0-9a-f]{7,40}/check-runs$`, "u"),
      build: (params: Readonly<Record<string, string | number>>) =>
        `/repos/${repository_}/commits/${params.sha}/check-runs`,
      query: Object.freeze({ per_page: /^([1-9]|[1-9]\d|100)$/u, page: /^[1-9]\d{0,2}$/u,
        filter: /^latest$/u }) as QueryRules },
  });
}

export type GitHubClientShapes = ReturnType<typeof shapesFor>;

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let value = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) value = value.split(secret).join("[REDACTED]");
  }
  return value;
}

function retryAfterMs(response: Response, nowMs: number): number | undefined {
  const header = response.headers?.get?.("retry-after");
  if (typeof header !== "string" || !header.trim()) return undefined;
  const trimmed = header.trim();
  if (/^\d{1,6}$/u.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  return undefined;
}

function rateLimited(response: Response): boolean {
  return response.headers?.get?.("x-ratelimit-remaining") === "0";
}

export type BoundedGitHubClientOptions = Readonly<{
  repository: string;
  auth: GitHubAppInstallationAuth;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRetryAfterMs?: number;
  maxBodyBytes?: number;
  audit?: (entry: BoundedGitHubAudit) => void;
}>;

export function createBoundedGitHubClient(options: BoundedGitHubClientOptions) {
  const { repository, auth } = options;
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("github_client_repository_invalid");
  }
  if (!auth || typeof auth.token !== "function") throw new Error("github_client_auth_invalid");
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const shapes = shapesFor(repository);

  function queryString(shape: GitHubRequestShape, query: Readonly<Record<string, string | number>>): string | undefined {
    const rules = shapes[shape].query;
    const parts: string[] = [];
    for (const [key, raw] of Object.entries(query)) {
      const rule = rules[key];
      if (!rule || !rule.test(String(raw))) return undefined;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(raw))}`);
    }
    return parts.length ? `?${parts.join("&")}` : "";
  }

  function buildUrl(request: BoundedGitHubRequest): string | undefined {
    const shape = shapes[request.shape];
    if (!shape) return undefined;
    const params = request.params ?? {};
    for (const [key, value] of Object.entries(params)) {
      const text = String(value);
      const allowed = key === "ref" ? /^[A-Za-z0-9._/-]{1,100}$/u : key === "sha" ? SHA : NUMBER;
      if (!allowed.test(text)) return undefined;
    }
    const query = queryString(request.shape, request.query ?? {});
    if (query === undefined) return undefined;
    const path = shape.build(params);
    if (!shape.pattern.test(path.split("?")[0])) return undefined;
    return `${GITHUB_API_ORIGIN}${path}${query}`;
  }

  async function request<T = unknown>(input: BoundedGitHubRequest): Promise<BoundedGitHubResult<T>> {
    const shape = shapes[input.shape];
    if (!shape) return Object.freeze({ ok: false, code: "github_request_shape_invalid" });
    if (input.body !== undefined) {
      if (shape.method !== "POST" || typeof input.body?.body !== "string"
        || Buffer.byteLength(input.body.body, "utf8") > maxBodyBytes) {
        return Object.freeze({ ok: false, code: "github_request_body_invalid" });
      }
    }
    const url = buildUrl(input);
    if (!url) return Object.freeze({ ok: false, code: "github_request_shape_invalid" });

    let refreshed = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let token: string;
      try { token = (await auth.token()).token; }
      catch { return Object.freeze({ ok: false, code: "github_token_unavailable" }); }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: shape.method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "agent-control-room-github-worker-broker",
            ...(input.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(input.body === undefined ? {} : { body: JSON.stringify({ body: input.body.body }) }),
        });
      } catch {
        options.audit?.({ shape: input.shape, code: "github_request_failed", attempt });
        if (attempt === 1) { await sleep(250); continue; }
        return Object.freeze({ ok: false, code: "github_request_failed" });
      }

      const status = response.status;
      if (status === 401) {
        // An expired or revoked installation token is the only grant we can renew
        // ourselves; a second refusal is a real credential problem.
        auth.clear();
        options.audit?.({ shape: input.shape, status, code: "github_credential_rejected", attempt });
        if (attempt === 1 && !refreshed) { refreshed = true; continue; }
        return Object.freeze({ ok: false, code: "github_credential_rejected", status });
      }
      if (status === 403 || status === 429) {
        const wait = retryAfterMs(response, now());
        const limited = status === 429 || rateLimited(response) || wait !== undefined;
        if (limited) {
          if (attempt === 1 && wait !== undefined && wait <= maxRetryAfterMs) {
            options.audit?.({ shape: input.shape, status, code: "github_rate_limited", attempt });
            await sleep(wait);
            continue;
          }
          options.audit?.({ shape: input.shape, status, code: "github_rate_limited", attempt });
          return Object.freeze({ ok: false, code: "github_rate_limited", status });
        }
        options.audit?.({ shape: input.shape, status, code: "github_forbidden", attempt });
        return Object.freeze({ ok: false, code: "github_forbidden", status });
      }
      if (status === 404) {
        options.audit?.({ shape: input.shape, status, code: "github_not_found", attempt });
        return Object.freeze({ ok: false, code: "github_not_found", status });
      }
      if (status >= 500) {
        options.audit?.({ shape: input.shape, status, code: "github_request_failed", attempt });
        if (attempt === 1) { await sleep(500); continue; }
        return Object.freeze({ ok: false, code: "github_request_failed", status });
      }
      if (status < 200 || status >= 300) {
        options.audit?.({ shape: input.shape, status, code: "github_request_failed", attempt });
        return Object.freeze({ ok: false, code: "github_request_failed", status });
      }

      let text: string;
      try { text = await response.text(); }
      catch {
        options.audit?.({ shape: input.shape, status, code: "github_response_invalid", attempt });
        return Object.freeze({ ok: false, code: "github_response_invalid", status });
      }
      let value: unknown;
      try { value = JSON.parse(text); }
      catch {
        options.audit?.({ shape: input.shape, status, code: "github_response_invalid", attempt });
        return Object.freeze({ ok: false, code: "github_response_invalid", status });
      }
      // Untrusted repository text never reaches the audit record: only the shape,
      // status, and code are reported.
      options.audit?.({ shape: input.shape, status, attempt });
      return Object.freeze({ ok: true, status, value: value as T });
    }
    return Object.freeze({ ok: false, code: "github_request_failed" });
  }

  /** Reads complete pages or reports truncation. A partial page set is never presented as complete. */
  async function pages<T = unknown>(input: BoundedGitHubRequest & Readonly<{ maxPages?: number }>): Promise<BoundedGitHubPage<T>> {
    const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) {
      return Object.freeze({ ok: false, code: "github_request_shape_invalid" });
    }
    const items: T[] = [];
    let truncated = false;
    for (let page = 1; page <= maxPages; page++) {
      const result = await request<unknown>({ ...input, query: { ...(input.query ?? {}), per_page: 100, page } });
      if (!result.ok) return Object.freeze({ ok: false, code: result.code, status: result.status });
      if (!Array.isArray(result.value)) return Object.freeze({ ok: false, code: "github_response_invalid" });
      items.push(...(result.value as T[]));
      if (result.value.length < 100) return Object.freeze({ ok: true, items: Object.freeze(items), truncated: false });
      if (page === maxPages) truncated = true;
    }
    return Object.freeze({ ok: true, items: Object.freeze(items), truncated });
  }

  /**
   * Resolves the installation's own bot login once and caches it in memory.
   * Deduplication falls back to GitHub's bot author type when this is unavailable.
   */
  let botLogin: string | undefined | null = null;
  async function installationBotLogin(): Promise<string | undefined> {
    if (botLogin !== null) return botLogin ?? undefined;
    const result = await request<unknown>({ shape: "app-user" });
    const login = result.ok && result.value && typeof result.value === "object"
      ? (result.value as { login?: unknown }).login : undefined;
    botLogin = typeof login === "string" && BOT_LOGIN.test(login) ? login : undefined;
    return botLogin ?? undefined;
  }

  return Object.freeze({ request, pages, installationBotLogin, repository });
}

export type BoundedGitHubClient = ReturnType<typeof createBoundedGitHubClient>;