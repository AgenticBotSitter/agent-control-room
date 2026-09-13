import { cloudflareAccessGatewayAssertionProfileV1, createAccessVerifier,
  type AccessTrust, type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import { readBoundedJson } from "./http-common";
import { z } from "zod";

export type AccessKeyLoader = (signal: AbortSignal) => Promise<AccessTrust["keys"]>;
const publicKeySchema = z.object({ kid: z.string().min(1).max(256), kty: z.literal("RSA"),
  n: z.string().min(1).max(2048), e: z.string().min(1).max(32), alg: z.literal("RS256").optional(),
  use: z.literal("sig").optional(), key_ops: z.array(z.literal("verify")).max(1).optional() }).strict();

/** Optional production loader. Only the configured issuer is contacted, never a token-derived URL.
 * The caller supplies its HTTP transport; constructing this loader makes no network call.
 */
export function createAccessKeyLoader(issuer: string, transport: typeof fetch): AccessKeyLoader {
  const url = new URL(issuer);
  if (url.protocol !== "https:" || url.origin !== issuer) throw new Error("invalid_access_config");
  return async signal => {
    const response = await transport(`${issuer}/cdn-cgi/access/certs`, {
      method: "GET", redirect: "error", credentials: "omit", signal, headers: { accept: "application/json" },
    });
    if (!response.ok || !response.body) throw new Error("access_keys_unavailable");
    const payload = z.object({ keys: z.array(publicKeySchema).min(1).max(8) }).passthrough()
      .parse(await readBoundedJson(response.body, 32768));
    return payload.keys.map(key => ({ kid: key.kid, jwk: key }));
  };
}

/** Built-in static key loader for the non-Cloudflare RS256 profile.
 * Deployment-selected public keys from the operator file — no URL fetch,
 * no discovery, no transport. Validated once at construction with the same
 * bounds as the fetched path (1–8 RSA keys); the strict shape refuses
 * private key material outright. Each call returns fresh copies.
 */
export function createStaticAccessKeyLoader(entries: unknown): AccessKeyLoader {
  let parsed: z.infer<typeof publicKeySchema>[];
  try {
    parsed = z.array(publicKeySchema).min(1).max(8).parse(entries);
  } catch { throw new Error("invalid_access_config"); }
  const keys = parsed.map(({ kid, ...jwk }) => ({ kid, jwk }));
  return async () => keys.map(({ kid, jwk }) => ({ kid, jwk: { ...jwk } }));
}

/** One refresh per process, on demand. No request-triggered unknown-key refresh or stale fallback. */
export function createAccessKeyCache(options: {
  issuer: string; audience: string; maxSessionSeconds: number; loadKeys: AccessKeyLoader; clock: () => number;
  gatewayAssertionProfile?: GatewayAssertionProviderProfileV1;
  freshForMs?: number; timeoutMs?: number;
}) {
  const freshForMs = options.freshForMs ?? 300_000;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(freshForMs) || freshForMs < 1000 || freshForMs > 300_000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error("invalid_access_config");
  let cached: AccessTrust | undefined;
  let loading: Promise<AccessTrust> | undefined;
  let lastNow = 0;
  let closed = false;
  let retryAfter = 0;
  let controller: AbortController | undefined;
  const now = () => {
    const value = options.clock();
    if (!Number.isSafeInteger(value) || value < lastNow) throw new Error("access_clock_unavailable");
    lastNow = value; return value;
  };
  return {
    async get(): Promise<AccessTrust> {
      if (closed) throw new Error("access_keys_unavailable");
      const started = now();
      if (cached && started < cached.validUntilMs) return cached;
      if (loading) return loading;
      if (started < retryAfter) throw new Error("access_keys_unavailable");
      controller = new AbortController();
      const signal = controller.signal;
      loading = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const keys = await Promise.race([Promise.resolve().then(() => options.loadKeys(signal)), new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller?.abort(); reject(new Error("access_keys_unavailable")); }, timeoutMs);
          })]);
          const trust: AccessTrust = { issuer: options.issuer, audience: options.audience,
            maxSessionSeconds: options.maxSessionSeconds, keys: structuredClone(keys), validUntilMs: started + freshForMs };
          createAccessVerifier(trust, options.gatewayAssertionProfile ?? cloudflareAccessGatewayAssertionProfileV1);
          if (closed || signal.aborted || now() >= trust.validUntilMs) throw new Error("access_keys_unavailable");
          cached = trust; return trust;
        } catch {
          cached = undefined;
          // An outage that consumes the full load deadline still gets a full post-failure backoff.
          // If failure time cannot be measured, do not silently schedule another refresh.
          try { retryAfter = now() + 5000; } catch { closed = true; }
          throw new Error("access_keys_unavailable");
        } finally { clearTimeout(timer); loading = undefined; controller = undefined; }
      })();
      return loading;
    },
    close() { closed = true; cached = undefined; controller?.abort(); },
  };
}
