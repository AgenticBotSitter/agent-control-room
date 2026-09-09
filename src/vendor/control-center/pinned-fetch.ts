import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isNonPublicIpAddress } from "./public-address";

export type PinnedAddress = { address: string; family: 4 | 6 };

export type PinnedFetchInit = {
  headers?: HeadersInit;
  method?: "GET" | "HEAD";
  signal?: AbortSignal;
};

export type PinnedFetchDependencies = {
  lookup?: (hostname: string) => Promise<PinnedAddress[]>;
  fetch?: (url: URL, address: PinnedAddress, init: PinnedFetchInit) => Promise<Response>;
  attemptDelayMs?: number;
};

const DEFAULT_ATTEMPT_DELAY_MS = 250;

function normalizedHostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function validateUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS sources are supported.");
  if (url.username || url.password) throw new Error("Source URLs cannot contain credentials.");
  const hostname = normalizedHostname(url);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "local" ||
    hostname.endsWith(".local") ||
    hostname === "home.arpa" ||
    hostname.endsWith(".home.arpa")
  ) throw new Error("Local network sources are blocked.");
  return { url, hostname };
}

async function systemLookup(hostname: string): Promise<PinnedAddress[]> {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  return lookup(hostname, { all: true, verbatim: true }) as Promise<PinnedAddress[]>;
}

export async function resolvePublicUrl(
  value: string,
  lookupImplementation: (hostname: string) => Promise<PinnedAddress[]> = systemLookup,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { url, hostname } = validateUrl(value);
  const lookupPromise = Promise.resolve().then(() => lookupImplementation(hostname));
  const resolved = signal ? await raceWithAbort(lookupPromise, signal) : await lookupPromise;
  const addresses = [...new Map(resolved.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()];
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => family !== isIP(address) || isNonPublicIpAddress(address))
  ) throw new Error("Private or non-public network sources are blocked.");
  return { url, addresses };
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    // Observe work already created by the caller even when cancellation won.
    void promise.catch(() => undefined);
    return Promise.reject<T>(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function assertPublicUrl(value: string) {
  return (await resolvePublicUrl(value)).url;
}

function responseHeaders(rawHeaders: string[]) {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headers.append(rawHeaders[index], rawHeaders[index + 1]);
  }
  return headers;
}

export async function fetchPinnedAddress(url: URL, address: PinnedAddress, init: PinnedFetchInit) {
  return new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init.headers);
    headers.set("Host", url.host);
    if (!headers.has("Accept-Encoding")) headers.set("Accept-Encoding", "identity");
    const method = init.method || "GET";
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal,
      agent: false,
      ...(url.protocol === "https:" && !isIP(normalizedHostname(url))
        ? { servername: normalizedHostname(url) }
        : {}),
    }, (incoming) => {
      try {
        const status = incoming.statusCode || 502;
        if (status < 200 || status > 599) {
          incoming.destroy();
          reject(new Error(`Source returned an invalid HTTP status (${status}).`));
          return;
        }
        const bodyless = method === "HEAD" || [204, 205, 304].includes(status);
        if (bodyless) incoming.resume();
        resolve(new Response(
          bodyless ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          {
            status,
            statusText: incoming.statusMessage || "",
            headers: responseHeaders(incoming.rawHeaders),
          },
        ));
      } catch (error) {
        incoming.destroy();
        reject(error instanceof Error ? error : new Error("Source returned an invalid HTTP response."));
      }
    });
    request.once("error", reject);
    request.end();
  });
}

export async function fetchPinned(
  value: string,
  init: PinnedFetchInit = {},
  dependencies: PinnedFetchDependencies = {},
) {
  const target = await resolvePublicUrl(value, dependencies.lookup || systemLookup, init.signal);
  const fetchImplementation = dependencies.fetch || fetchPinnedAddress;
  const attemptDelayMs = Math.max(0, dependencies.attemptDelayMs ?? DEFAULT_ATTEMPT_DELAY_MS);

  return new Promise<Response>((resolve, reject) => {
    const controllers = target.addresses.map(() => new AbortController());
    const timers: NodeJS.Timeout[] = [];
    let settled = false;
    let failed = 0;
    let lastError: unknown;

    const cleanup = () => {
      for (const timer of timers) clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      controllers.forEach((controller) => controller.abort());
      reject(error instanceof Error ? error : new Error("Source could not be requested."));
    };
    const onAbort = () => rejectOnce(abortReason(init.signal as AbortSignal));
    const launch = (index: number) => {
      if (settled) return;
      const controller = controllers[index];
      const attemptSignal = init.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal;
      let attempt: Promise<Response>;
      try {
        attempt = fetchImplementation(target.url, target.addresses[index], {
          ...init,
          signal: attemptSignal,
        });
      } catch (error) {
        attempt = Promise.reject(error);
      }
      void attempt.then(
        async (response) => {
          if (settled) {
            await response.body?.cancel().catch(() => undefined);
            return;
          }
          settled = true;
          cleanup();
          controllers.forEach((candidate, candidateIndex) => {
            if (candidateIndex !== index) candidate.abort();
          });
          resolve(response);
        },
        (error) => {
          if (settled) return;
          lastError = error;
          failed += 1;
          if (failed === target.addresses.length) rejectOnce(lastError);
        },
      );
    };

    if (init.signal?.aborted) {
      rejectOnce(abortReason(init.signal));
      return;
    }
    init.signal?.addEventListener("abort", onAbort, { once: true });
    target.addresses.forEach((_address, index) => {
      if (index === 0) launch(index);
      else timers.push(setTimeout(() => launch(index), attemptDelayMs * index));
    });
  });
}
