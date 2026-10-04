import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, webFailure } from "./http-common";
import type { ResultFileServiceV1 } from "./result-file-service";
import { resultFileDisplayNameSchema } from "./result-file-wire";
import { catalogProjectIdSchema } from "./project-wire";

/**
 * The owner download route (plan v4.3 §2.6).
 *
 * Attachment-only, always. Every response that carries bytes sets
 * `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and a
 * sandbox CSP, so an HTML or SVG payload cannot execute in the app's origin
 * even if a browser ignores the disposition. There is no public link, no
 * storage key and no object-store URL in any response: the only address a file
 * has is this route plus a five-minute token bound to one session, one project
 * and one digest.
 *
 * Two requests, both GET:
 *   GET /api/v1/projects/:projectId/result-files                 the catalog
 *   GET /api/v1/projects/:projectId/result-files/:setId/:fileId/download?token=
 *
 * The link route without a token mints one; it is how a page obtains a
 * downloadable link in the first place, and it is owner-session-only like every
 * other write in the app.
 */
export type ResultFileHttpOptionsV1 = Readonly<{
  origin: string;
  service: ResultFileServiceV1;
  trust?: AccessTrust;
  gatewayAssertionProfile?: GatewayAssertionProviderProfileV1;
  /** Explicit loopback-only owner-session service; never a generic verifier. */
  localOwnerSession?: LocalOwnerSessionServiceV1;
  clock?: () => number;
}>;

/** A display name is echoed into the header, so it is re-checked at the edge.
 * The schema already refuses a name with a quote, a separator or a control
 * character; this is the second, independent check on the way out. */
function attachmentHeaders(displayName: string, mediaType: string, sizeBytes: number) {
  if (!resultFileDisplayNameSchema.safeParse(displayName).success)
    throw new WebAccessError("not_found");
  const fallback = displayName.replace(/[^\x20-\x7e]/gu, "_");
  const encoded = encodeURIComponent(displayName).replace(/['()*]/gu,
    value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return { ...privateResponseHeaders,
    // `application/octet-stream` is used whatever the detected type is: the
    // browser is told nothing about the content, so nothing in it can be
    // interpreted by the app's origin. The detected type is metadata the owner
    // sees in the catalog, not something the response acts on.
    "content-type": "application/octet-stream",
    "content-length": String(sizeBytes),
    "content-disposition": `attachment; filename="${fallback}"`
      + (fallback === displayName ? "" : `; filename*=UTF-8''${encoded}`),
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    ...(mediaType ? { "x-control-room-detected-type": mediaType } : {}) } as Record<string, string>;
}

export function createResultFileHttpHandlerV1(options: ResultFileHttpOptionsV1) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("result_file_http_authentication_invalid");
  const clock = options.clock ?? Date.now;
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method !== 'GET');
      else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, clock()) : verify!(request, clock());
      const url = new URL(request.url);
      // Minting a link records a grant row, so it is a POST. Reading the bytes
      // is a GET, because a browser following a download link cannot POST.
      if (request.method !== 'GET' && request.method !== 'POST') throw new WebAccessError('invalid_request');
      const catalog = /^\/api\/v1\/projects\/([^/]+)\/result-files$/u.exec(url.pathname);
      const download = /^\/api\/v1\/projects\/([^/]+)\/result-files\/([^/]+)\/([^/]+)\/download$/u
        .exec(url.pathname);
      if (!catalog && !download) throw new WebAccessError("not_found");
      const projectId = safeDecode(catalog?.[1] ?? download![1]);
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
      if (catalog) {
        // The catalog is a READ. It takes at most one `job` filter and nothing
        // else: no token, no page size, no offset. A link pasted from a chat
        // window can narrow the listing to one task and can do nothing else to
        // it. A POST here is refused rather than silently reading, so a minted
        // link and a listing can never be confused for one another.
        if (request.method !== 'GET') throw new WebAccessError('invalid_request');
        if ([...url.searchParams.keys()].some(key => key !== "job")
          || url.searchParams.getAll("job").length > 1) throw new WebAccessError("invalid_request");
        const jobId = url.searchParams.get("job");
        return Response.json(await options.service.catalog(identity, projectId, jobId ?? undefined),
          { headers: privateResponseHeaders });
      }
      const setId = safeDecode(download![2]);
      const fileId = safeDecode(download![3]);
      if (!/^result-set:[a-f0-9]{32}$/u.test(setId) || !/^result-file:[a-f0-9]{32}$/u.test(fileId))
        throw new WebAccessError("not_found");
      if (request.method === 'POST') {
        // Mint one link, for this one file, for this session. No body is read:
        // the file is named entirely by the path, so there is nothing a caller
        // could add to it.
        if (url.search || request.body
          || Number(request.headers.get('content-length') ?? 0) > 0)
          throw new WebAccessError('invalid_request');
        return Response.json(await options.service.issueDownload(identity, projectId, setId, fileId),
          { status: 201, headers: privateResponseHeaders });
      }
      const token = url.searchParams.get('token');
      if ([...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length !== 1)
        throw new WebAccessError('invalid_request');
      if (token === null) throw new WebAccessError('invalid_request');
      const file = await options.service.download(identity, projectId, setId, fileId, token);
      return new Response(file.bytes, { headers: attachmentHeaders(file.displayName, file.mediaType, file.sizeBytes) });
    } catch (error) { return webFailure(error); }
  };
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new WebAccessError("invalid_request"); }
}
