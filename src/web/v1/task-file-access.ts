import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hmacSha256Tag } from "../../security";
import { catalogProjectIdSchema as id } from "./project-wire";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const claimsSchema = z.object({ version: z.literal(1), projectId: id, jobId: id, runId: id, artifactId: id,
  contentHash: digest, sizeBytes: z.number().int().min(0).max(65_536), disposition: z.enum(["preview", "download"]),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive() }).strict()
  .refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 300_000);
export type TaskFileAccessClaimsV1 = z.infer<typeof claimsSchema>;

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url").toString("utf8");

export function issueTaskFileAccessV1(key: Uint8Array, input: Omit<TaskFileAccessClaimsV1, "version" | "issuedAt" | "expiresAt">,
  now: number, lifetimeMs = 60_000) {
  if (key.length !== 32 || !Number.isSafeInteger(now) || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 300_000)
    throw new Error("task_file_access_invalid");
  const claims = claimsSchema.parse({ version: 1, ...input, issuedAt: now, expiresAt: now + lifetimeMs });
  const payload = encode(JSON.stringify(claims));
  const tag = hmacSha256Tag(key, { purpose: "task-file-access/v1", payload });
  return Object.freeze({ token: `${payload}.${encode(tag)}`, expiresAt: new Date(claims.expiresAt).toISOString() });
}

export function verifyTaskFileAccessV1(key: Uint8Array, token: string, expected: Readonly<{
  projectId: string; jobId: string; artifactId: string; disposition: "preview" | "download" }>, now: number) {
  try {
    if (key.length !== 32 || token.length > 2048 || !Number.isSafeInteger(now)) throw new Error();
    const parts = token.split("."); if (parts.length !== 2) throw new Error();
    const [payload, encodedTag] = parts as [string, string];
    const claims = claimsSchema.parse(JSON.parse(decode(payload)));
    const expectedTag = Buffer.from(hmacSha256Tag(key, { purpose: "task-file-access/v1", payload }));
    const actualTag = Buffer.from(decode(encodedTag));
    if (expectedTag.length !== actualTag.length || !timingSafeEqual(expectedTag, actualTag)
      || now < claims.issuedAt || now >= claims.expiresAt || claims.projectId !== expected.projectId
      || claims.jobId !== expected.jobId || claims.artifactId !== expected.artifactId
      || claims.disposition !== expected.disposition) throw new Error();
    return claims;
  } catch { throw new Error("task_file_access_refused"); }
}
