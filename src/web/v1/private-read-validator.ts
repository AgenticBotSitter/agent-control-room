/**
 * Conditional owner reads: a per-identity ETag that lets an unchanged
 * protected read return `304 Not Modified` with no body.
 *
 * Design constraints, all of which are load-bearing rather than stylistic:
 *
 *  1. **`cache-control: no-store` is not weakened.** This module never sets,
 *     relaxes or overrides `cache-control`. It does not even import the private
 *     response policy; the caller passes the policy headers through so a 304 is
 *     as uncacheable as the 200 it replaces. A validator here is a
 *     revalidation mechanism, not a store: it does not authorize any cache to
 *     keep a copy. This is a deliberate, documented decision — see the task
 *     report — because the reason for the existing `no-store` is not written
 *     down anywhere in the repository and weakening it is not this change's
 *     call to make.
 *
 *  2. **The validator is per-identity, not per-resource.** The scope digest
 *     folds in the verified session's `tokenDigest`, so a validator computed
 *     for one session can never be matched by another. Because it is scoped by
 *     session and not merely by resource, a validator presented after a
 *     sign-out cannot match: the next session has a different `tokenDigest`,
 *     so the derived validator differs and the response is a normal `200`.
 *
 *  3. **Authorization is never skipped.** The validator is applied *after* the
 *     route has already verified the identity, checked project authority and
 *     performed its read. A `304` therefore still costs the full database
 *     round trip. What it saves is the response body, its serialisation and its
 *     transfer. This change does not make the database faster and must not be
 *     described as if it does.
 *
 *  4. **Only successful, JSON, side-effect-free reads get a validator.** Error
 *     responses, non-JSON bodies, non-2xx statuses and anything that is not
 *     GET/HEAD are passed through untouched, so a failed read can never be
 *     answered with a `304` and hide an error or an authority change.
 */

import { createHash } from "node:crypto";

/** A validator is only computed for a body at or below this size. Larger
 * responses are returned unchanged rather than buffered to be hashed. */
export const readValidatorByteLimit = 1_048_576;

const ETAG_PATTERN = /^"[\x21\x23-\x7E]*"$/;

/**
 * A cheap, stable, per-identity scope for one request. It is deliberately not
 * a secret, and the client cannot influence it into reaching another session's
 * validator because the `tokenDigest` component is server-derived from a
 * verified assertion.
 */
export function readValidatorScope(tokenDigest: string, method: string, pathname: string, search: string): string {
  if (!tokenDigest || !/^sha256:[0-9a-f]{64}$/.test(tokenDigest)) throw new Error("read_validator_scope_invalid");
  return createHash("sha256")
    .update(`${tokenDigest}\n${method}\n${pathname}\n${search}`)
    .digest("hex");
}

/** Strong validator over the exact bytes served, bound to one identity scope. */
export function readValidatorFor(scope: string, body: string): string {
  return `"${createHash("sha256").update(`${scope}\n${body}`).digest("hex")}"`;
}

/**
 * Decides whether a conditional request is satisfied. Only a single strong
 * `If-None-Match` value that equals the validator we just computed counts;
 * `*`, weak validators and multi-value lists are treated as no match, which
 * always produces the full response rather than a wrong `304`.
 */
export function ifNoneMatchMatches(header: string | null | undefined, validator: string): boolean {
  if (!header) return false;
  const value = header.trim();
  if (value === "*" || value.length > 8192) return false;
  if (!ETAG_PATTERN.test(value)) return false;
  return value === validator;
}

/**
 * A `304` carries no body and no representation metadata. The caller's private
 * response policy headers are replayed verbatim, so a 304 is exactly as
 * uncacheable as the 200 it replaces.
 */
export function notModifiedResponse(validator: string, privateHeaders: Readonly<Record<string, string>>): Response {
  return new Response(null, { status: 304, headers: { ...privateHeaders, etag: validator } });
}

export interface ReadValidatorOutcome {
  response: Response;
  /** True when this response is a 304 produced by this module. */
  notModified: boolean;
  /** True when a validator was computed. */
  validated: boolean;
}

const untouched = (response: Response): ReadValidatorOutcome => ({ response, notModified: false, validated: false });

/**
 * Applies the conditional-read protocol to an already-authorized response.
 * Returns the response untouched whenever a validator cannot be computed
 * safely, so this is always safe to call.
 */
export async function applyReadValidator(request: Request, response: Response, scope: string,
  privateHeaders: Readonly<Record<string, string>>): Promise<ReadValidatorOutcome> {
  if (!["GET", "HEAD"].includes(request.method)) return untouched(response);
  if (response.status !== 200) return untouched(response);
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return untouched(response);
  // HEAD is answered by the transport without a body; there is nothing to hash.
  if (request.method === "HEAD") return untouched(response);
  if (!response.body) return untouched(response);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > readValidatorByteLimit) return untouched(response);

  let body: string;
  try {
    // Inspect a separate stream so every fail-open path can still return the
    // caller's original response with its body readable by the transport.
    const buffer = await response.clone().arrayBuffer();
    if (buffer.byteLength > readValidatorByteLimit) return untouched(response);
    body = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch { return untouched(response); }

  const validator = readValidatorFor(scope, body);
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), validator))
    return { response: notModifiedResponse(validator, privateHeaders), notModified: true, validated: true };

  // Only the ETag is added. cache-control is left exactly as the handler and the
  // transport set it, because relaxing it is not this module's decision.
  const headers = new Headers(response.headers);
  headers.set("etag", validator);
  return { response: new Response(body, { status: 200, headers }), notModified: false, validated: true };
}
