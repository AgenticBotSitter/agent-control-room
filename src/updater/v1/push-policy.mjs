/**
 * The one endpoint policy used by both the owner web path and the root updater.
 * Keep this dependency-free: it is bundled into the fixed updater and is also
 * imported by the TypeScript web path.
 */
const PUSH_SERVICE_HOSTS_V1 = Object.freeze([
  /^web\.push\.apple\.com$/u,
  /^fcm\.googleapis\.com$/u,
  /^updates\.push\.services\.mozilla\.com$/u,
  /^[a-z0-9-]+\.notify\.windows\.com$/u,
]);

export function ownerPushEndpointAllowedV1(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  let parsed;
  try { parsed = new URL(endpoint); } catch { return false; }
  if (parsed.username !== "" || parsed.password !== "" || parsed.protocol !== "https:" || parsed.hash !== "") return false;
  if (parsed.port !== "" && parsed.port !== "443") return false;
  return PUSH_SERVICE_HOSTS_V1.some(pattern => pattern.test(parsed.hostname.toLowerCase()));
}

export const OWNER_PUSH_SERVICE_HOSTS_V1 = PUSH_SERVICE_HOSTS_V1;
