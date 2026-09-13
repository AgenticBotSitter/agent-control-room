/**
 * Vinext may supply a dynamic route parameter in its URL-encoded form while
 * other compatible renderers supply the decoded value. Decode exactly once at
 * the page boundary so browser clients always receive the canonical ID.
 */
export function decodePrivateRouteSegment(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) throw new Error("private_route_segment_invalid");
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new Error("private_route_segment_invalid"); }
  if (!decoded || decoded.length > 256 || /[\\/\u0000-\u001f\u007f]/u.test(decoded)) throw new Error("private_route_segment_invalid");
  return decoded;
}
