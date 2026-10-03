import { createSign } from "node:crypto";

export type GitHubAppInstallationCredentials = Readonly<{
  appId: string;
  installationId: string;
  privateKeyPem: string;
}>;

export type GitHubInstallationToken = Readonly<{
  token: string;
  expiresAt: string;
}>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const TOKEN_EXCHANGE_TIMEOUT_MS = 20_000;
const GITHUB_API = "https://api.github.com";

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function assertCredentials(credentials: GitHubAppInstallationCredentials): void {
  if (!ID_PATTERN.test(credentials.appId)) throw new Error("github_app_id_invalid");
  if (!ID_PATTERN.test(credentials.installationId)) throw new Error("github_app_installation_id_invalid");
  if (!credentials.privateKeyPem.includes("BEGIN") || !credentials.privateKeyPem.includes("PRIVATE KEY")) {
    throw new Error("github_app_private_key_invalid");
  }
}
/** Creates the short-lived JWT GitHub requires before an installation token can be requested. */
export function createGitHubAppJwt(
  credentials: GitHubAppInstallationCredentials,
  nowMs: number = Date.now(),
): string {
  assertCredentials(credentials);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("github_app_clock_invalid");
  const nowSeconds = Math.floor(nowMs / 1000);
  // Backdate by 60 seconds for bounded clock skew. GitHub permits at most ten minutes.
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + (9 * 60), iss: credentials.appId };
  const header = { alg: "RS256", typ: "JWT" };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(credentials.privateKeyPem, "base64url")}`;
}

export class GitHubAppInstallationAuth {
  readonly #credentials: GitHubAppInstallationCredentials;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #generation = 0;
  #cached?: GitHubInstallationToken;
  #inFlight?: Promise<GitHubInstallationToken>;

  constructor({ credentials, fetchImpl = fetch, now = Date.now }: {
    credentials: GitHubAppInstallationCredentials;
    fetchImpl?: FetchLike;
    now?: () => number;
  }) {
    assertCredentials(credentials);
    this.#credentials = Object.freeze({ ...credentials });
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async token(): Promise<GitHubInstallationToken> {
    const cachedExpiry = this.#cached ? Date.parse(this.#cached.expiresAt) : Number.NaN;
    if (this.#cached && Number.isFinite(cachedExpiry) && cachedExpiry - this.#now() > 5 * 60_000) {
      return this.#cached;
    }
    if (this.#inFlight) return this.#inFlight;
    const generation = this.#generation;
    const controller = new AbortController();
    let timeout!: ReturnType<typeof setTimeout>;
    // Race the entire exchange, including body consumption. Some injected
    // transports may ignore abort, so cancellation alone cannot bound callers.
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error("github_app_token_exchange_timeout");
        reject(error);
        controller.abort(error);
      }, TOKEN_EXCHANGE_TIMEOUT_MS);
    });
    const request = Promise.race([this.#requestToken(controller.signal), deadline]);
    this.#inFlight = request;
    try {
      const token = await request;
      if (this.#generation === generation) this.#cached = token;
      return token;
    } finally {
      clearTimeout(timeout);
      if (this.#inFlight === request) this.#inFlight = undefined;
    }
  }

  clear(): void {
    this.#generation++;
    this.#cached = undefined;
    // Existing callers can finish, but callers after clear start a fresh
    // exchange and an invalidated completion can never refill the cache.
    this.#inFlight = undefined;
  }

  async #requestToken(signal: AbortSignal): Promise<GitHubInstallationToken> {
    const jwt = createGitHubAppJwt(this.#credentials, this.#now());
    const response = await this.#fetch(
      `${GITHUB_API}/app/installations/${this.#credentials.installationId}/access_tokens`,
      {
        method: "POST",
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) throw new Error(`github_app_token_exchange_failed:${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") throw new Error("github_app_token_response_invalid");
    const { token, expires_at: expiresAt } = body as { token?: unknown; expires_at?: unknown };
    if (typeof token !== "string" || token.length < 20 || typeof expiresAt !== "string"
      || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.#now()) {
      throw new Error("github_app_token_response_invalid");
    }
    return Object.freeze({ token, expiresAt });
  }
}
