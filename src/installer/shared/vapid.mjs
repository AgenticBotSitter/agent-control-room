/** Contact identifiers carried verbatim in VAPID JWTs. No default or URL normalization. */
export function vapidSubjectAllowedV1(value) {
  if (typeof value !== "string" || value.length > 320) return false;
  const https = /^https:\/\/([a-z0-9.-]+)$/u.exec(value);
  const mail = /^mailto:[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*@([a-z0-9.-]+)$/u.exec(value);
  const hostname = (https ?? mail)?.[1];
  if (!hostname || hostname.length > 253) return false;
  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return false;
  if (!/^[a-z]{2,63}$/u.test(labels.at(-1))) return false;
  return !labels.some(label => ["invalid", "localhost", "example"].includes(label))
    && !["test", "local"].includes(labels.at(-1));
}

/** The complete shape accepted by both credential readers. */
export function vapidConfigAllowedV1(value, schema) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "privateKey,publicKey,schema,subject"
    && value.schema === schema && vapidSubjectAllowedV1(value.subject)
    && typeof value.publicKey === "string" && /^[A-Za-z0-9_-]{80,100}$/u.test(value.publicKey)
    && typeof value.privateKey === "string" && /^[A-Za-z0-9_-]{40,100}$/u.test(value.privateKey);
}

/** Preserve the provider's diagnostic without retaining an unbounded response. */
export function pushRejectionReasonV1(error) {
  return typeof error?.body === "string" ? error.body.slice(0, 1024) : undefined;
}
