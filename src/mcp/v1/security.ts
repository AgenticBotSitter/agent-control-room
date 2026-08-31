import { createPublicKey, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Digest } from "../../security";
import { controlRoomMcpAccessGrantSchemaV1 } from "./schemas";
import type { ControlRoomMcpAccessGrantBodyV1, ControlRoomMcpAccessGrantV1 } from "./types";

export const CONTROL_ROOM_MCP_MAX_GRANT_LIFETIME_MS_V1 = 15 * 60_000;

export function digestControlRoomMcpBearerTokenV1(token: string): string {
  if (typeof token !== "string" || token.length < 32 || token.length > 512 || /\s/.test(token)) {
    throw new Error("MCP bearer token invalid");
  }
  return sha256Digest({ bearerToken: token });
}

function canonicalEd25519PublicKey(spki: string): KeyObject {
  if (!/^[A-Za-z0-9_-]{40,180}$/.test(spki)) throw new Error("MCP authentication key invalid");
  const supplied = Buffer.from(spki, "base64url");
  const key = createPublicKey({ key: supplied, format: "der", type: "spki" });
  const canonical = key.export({ format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || !Buffer.isBuffer(canonical) || !canonical.equals(supplied)
    || spki !== canonical.toString("base64url")) throw new Error("MCP authentication key invalid");
  return key;
}

export function signControlRoomMcpAccessGrantV1(material: Omit<ControlRoomMcpAccessGrantBodyV1, "bodyDigest">,
  privateKey: KeyObject): ControlRoomMcpAccessGrantV1 {
  const body = { ...material, bodyDigest: sha256Digest(material) };
  return { body, signatureAlgorithm: "Ed25519", signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url") };
}

export function verifyControlRoomMcpAccessGrantV1(input: {
  grant: ControlRoomMcpAccessGrantV1;
  bearerToken: string;
  expectedIssuerKeyId: string;
  issuerPublicKeySpki: string;
  now: string;
}): ControlRoomMcpAccessGrantBodyV1 {
  const parsed = controlRoomMcpAccessGrantSchemaV1.safeParse(input.grant);
  if (!parsed.success || parsed.data.body.issuerKeyId !== input.expectedIssuerKeyId) throw new Error("MCP authentication invalid");
  const { bodyDigest, ...material } = parsed.data.body;
  const observed = Date.parse(input.now); const issued = Date.parse(parsed.data.body.issuedAt); const expires = Date.parse(parsed.data.body.expiresAt);
  let suppliedTokenDigest: string;
  try { suppliedTokenDigest = digestControlRoomMcpBearerTokenV1(input.bearerToken); }
  catch { throw new Error("MCP authentication invalid"); }
  const expectedToken = Buffer.from(parsed.data.body.tokenDigest);
  const suppliedToken = Buffer.from(suppliedTokenDigest);
  if (expectedToken.length !== suppliedToken.length || !timingSafeEqual(expectedToken, suppliedToken)
    || sha256Digest(material) !== bodyDigest || ![observed, issued, expires].every(Number.isFinite)
    || issued > observed || expires <= observed || expires <= issued || expires - issued > CONTROL_ROOM_MCP_MAX_GRANT_LIFETIME_MS_V1) {
    throw new Error("MCP authentication invalid");
  }
  let valid = false;
  try { valid = verify(null, Buffer.from(canonicalJson(parsed.data.body)), canonicalEd25519PublicKey(input.issuerPublicKeySpki), Buffer.from(parsed.data.signature, "base64url")); }
  catch { valid = false; }
  if (!valid) throw new Error("MCP authentication invalid");
  return structuredClone(parsed.data.body);
}
