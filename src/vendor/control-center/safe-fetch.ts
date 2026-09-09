import { readBoundedResponseText } from "./sitemap";
import { fetchPinned, type PinnedFetchDependencies } from "./pinned-fetch";

export { assertPublicUrl } from "./pinned-fetch";

const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;

export type SafeFetchOptions = {
  headers?: HeadersInit;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  beforeRequest?: (url: string) => undefined;
};

function requestSignal(url: string, options: SafeFetchOptions, defaultTimeout: number) {
  options.signal?.throwIfAborted();
  const result: unknown = options.beforeRequest?.(url);
  if (result !== undefined) {
    if (result instanceof Promise) void result.catch(() => undefined);
    throw new Error("Source permission must be checked synchronously.");
  }
  options.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? defaultTimeout);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

export async function safeFetchText(value: string, options: SafeFetchOptions = {}, dependencies: PinnedFetchDependencies = {}) {
  let currentUrl = new URL(value).toString();
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetchPinned(currentUrl, {
      signal: requestSignal(currentUrl, options, 12_000),
      headers: {
        "User-Agent": "ControlCenter/1.0 (+self-hosted feed reader)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...options.headers,
      },
    }, dependencies);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Source returned a redirect without a destination.");
    }
    if (redirects === 5) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Source redirected too many times.");
    }
    await response.body?.cancel().catch(() => undefined);
    currentUrl = new URL(location, currentUrl).toString();
  }
  if (!response) throw new Error("Source could not be requested.");
  if (!response.ok) {
    const message = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    await response.body?.cancel().catch(() => undefined);
    throw new Error(message);
  }
  const text = await readBoundedResponseText(response, options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  return { text, contentType: response.headers.get("content-type") || "", finalUrl: currentUrl };
}

export async function resolvePublicRedirect(
  value: string,
  options: Pick<SafeFetchOptions, "headers" | "timeoutMs" | "signal" | "beforeRequest"> = {},
  dependencies: PinnedFetchDependencies = {},
) {
  let currentUrl = new URL(value).toString();
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchPinned(currentUrl, {
      signal: requestSignal(currentUrl, options, 8_000),
      headers: {
        "User-Agent": "ControlCenter/1.0 (+self-hosted newsletter reader)",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        ...options.headers,
      },
    }, dependencies);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return currentUrl;
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new Error("Source returned a redirect without a destination.");
    if (redirects === 5) throw new Error("Source redirected too many times.");
    currentUrl = new URL(location, currentUrl).toString();
  }
  return currentUrl;
}
