import { z } from "zod";
import { safeFetchText, type SafeFetchOptions } from "../../../vendor/control-center/safe-fetch";
import type { PinnedFetchDependencies } from "../../../vendor/control-center/pinned-fetch";
import { createIndustrySourceReader } from "../../../vendor/control-center/source-reader";
import { captureAbsCurrentSourceAuthority, type AbsCurrentSourceAuthority } from "./current-source-authority";
import { absNewsDiscoveryEndpointSchemaV1 } from "./schemas";

export const controlCenterCollectionLimitsSchema = z.object({ maxAttempts: z.number().int().min(1).max(1000),
  timeoutMs: z.number().int().min(1).max(30_000),
  maxDocumentBytes: z.number().int().min(1).max(50 * 1024 * 1024),
  maxReservedBodyBytes: z.number().int().min(1).max(100 * 1024 * 1024),
  maxArticles: z.number().int().min(1).max(10).optional(),
}).strict();
/** Glue only: borrow discovery and pinned HTTP. Application supplies the transport,
 * current source authority and cancellation signal. Byte budget is
 * conservatively reserved per document, not a claim of wire-byte accounting. */
export function createControlCenterCollectionReader(value: unknown, source: AbsCurrentSourceAuthority,
  signal: AbortSignal, dependencies: Required<Pick<PinnedFetchDependencies, "lookup" | "fetch">>, now: () => number = Date.now) {
  const limits = controlCenterCollectionLimitsSchema.parse(value), assertCurrent = captureAbsCurrentSourceAuthority(source);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]);
  const lookup = dependencies.lookup.bind(dependencies), fetch = dependencies.fetch.bind(dependencies);
  let attempts = 0, reservedBodyBytes = 0, articles = 0;
  const check = (url: string): undefined => {
    deadline.throwIfAborted();
    // Discovery endpoints may legitimately contain queries (unlike canonical story
    // identities). Upstream DNS checks enforce public addresses; authority checks
    // the exact destination, including its path/query.
    absNewsDiscoveryEndpointSchemaV1.parse(new URL(url).toString());
    assertCurrent(url); deadline.throwIfAborted();
  };
  const readText = async (url: string, options?: SafeFetchOptions) => {
    check(url);
    const maxBytes = Math.min(options?.maxBytes ?? limits.maxDocumentBytes, limits.maxDocumentBytes);
    if (reservedBodyBytes + maxBytes > limits.maxReservedBodyBytes) throw new Error("news_collection_body_budget_exhausted");
    reservedBodyBytes += maxBytes;
    return safeFetchText(url, { ...options, maxBytes, signal: deadline, beforeRequest: check }, {
      lookup,
      async fetch(target, address, init) {
        check(target.toString());
        if (++attempts > limits.maxAttempts) throw new Error("news_collection_attempt_budget_exhausted");
        return fetch(target, address, init);
      },
    });
  };
  const reader = createIndustrySourceReader({ now, readText });
  return Object.freeze({ ...reader, signal: deadline, maxArticles: limits.maxArticles ?? 0,
    assertArticleCurrent: check,
    async readArticle(url: string, signal: AbortSignal) {
      if (!limits.maxArticles || articles >= limits.maxArticles) throw new Error("news_article_not_approved");
      articles++;
      signal.throwIfAborted();
      const result = await readText(url, { maxBytes: 524288, headers: { Accept: "text/html" } });
      signal.throwIfAborted(); check(url);
      return { text: result.text, byteCount: Buffer.byteLength(result.text, "utf8"),
        contentType: result.contentType, endpointUrl: result.finalUrl };
    },
    async readSource(...args: Parameters<typeof reader.readSource>) {
      const configured = { ...args[0] };
      check(configured.url);
      const result = await reader.readSource(configured, args[1]);
      check(configured.url);
      return result;
    },
  });
}
