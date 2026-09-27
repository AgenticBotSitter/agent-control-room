import { timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import type { AuthenticatedPrincipal } from "../../security";
import type { WorkIntakeCredentialVerifierPortV1 } from "./credential";

export const WORK_INTAKE_BEARER_LENGTH_V1 = 43;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

function exactPrincipal(value: unknown): AuthenticatedPrincipal {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value))
    throw new Error("work_intake_machine_auth_invalid");
  const p = value as AuthenticatedPrincipal;
  if (p.actorType !== "agent" || typeof p.tenantId !== "string" || typeof p.identityId !== "string"
    || typeof p.authenticatedAt !== "string" || typeof p.expiresAt !== "string")
    throw new Error("work_intake_machine_auth_invalid");
  return Object.freeze({ tenantId: p.tenantId, identityId: p.identityId, actorType: p.actorType,
    authenticatedAt: p.authenticatedAt, expiresAt: p.expiresAt });
}

/** Captures one protected-store secret and never returns it to the caller. */
export function createFixedWorkIntakeCredentialVerifierV1(secret: unknown, principal: unknown):
  WorkIntakeCredentialVerifierPortV1 {
  if (typeof secret !== "string" || !tokenPattern.test(secret))
    throw new Error("work_intake_machine_auth_invalid");
  const expected = Buffer.from(secret, "ascii"), captured = exactPrincipal(principal);
  return Object.freeze({
    async verify(credential: unknown): Promise<AuthenticatedPrincipal> {
      const actual = typeof credential === "string" && tokenPattern.test(credential)
        ? Buffer.from(credential, "ascii") : Buffer.alloc(WORK_INTAKE_BEARER_LENGTH_V1);
      if (!timingSafeEqual(expected, actual)) throw new Error("work_intake_credential_refused");
      return captured;
    },
  });
}

export function readWorkIntakeBearerV1(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("Bearer "))
    throw new Error("work_intake_credential_refused");
  const token = value.slice(7);
  if (!tokenPattern.test(token)) throw new Error("work_intake_credential_refused");
  return token;
}
