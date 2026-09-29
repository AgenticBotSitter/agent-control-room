/**
 * Per-polling-key conditional transport.
 *
 * The server binds validators to the verified session as well as the request
 * path and response body. This client keeps the matching representation only
 * for the lifetime of one mounted polling key. A 304 can therefore reuse the
 * body that produced its validator, while a changed session or resource must
 * receive a fresh 200 from the server.
 */

export type PolledReadFetch = typeof fetch;

type HeldResponse = Readonly<{ etag: string; response: Response }>;

function requestKey(input: RequestInfo | URL, init?: RequestInit): string {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = input instanceof Request ? input.url : String(input);
  return `${method} ${url}`;
}

/** Creates an ETag cache scoped to one mounted `usePolledRead` key. */
export function createPolledReadFetch(transport: typeof fetch = fetch): PolledReadFetch {
  const held = new Map<string, HeldResponse>();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = requestKey(input, init);
    const previous = held.get(key);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (previous) headers.set("if-none-match", previous.etag);

    const response = await transport(input, { ...init, headers });
    if (response.status === 304) {
      if (!previous) throw new Error("polled_read_304_without_representation");
      return previous.response.clone();
    }

    const etag = response.status === 200 ? response.headers.get("etag") : null;
    if (etag) held.set(key, { etag, response: response.clone() });
    else held.delete(key);
    return response;
  };
}
