import type { z } from "zod";
import { exactProjectWorkspaceJsonV1 } from "../../project-workspace/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { OperationsContractErrorV1 } from "./errors";

export function parseExactOperationsV1<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  try {
    const parsed = schema.parse(exactProjectWorkspaceJsonV1(value));
    assertNoSecretMaterial(parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof OperationsContractErrorV1) throw error;
    if (error instanceof Error && error.message.includes("contains secret material")) {
      throw new OperationsContractErrorV1("redaction_rejected");
    }
    throw new OperationsContractErrorV1("invalid_input");
  }
}

export function verifyOperationsDigestV1(value: Record<string, unknown>, key: string, actual: string): void {
  const material = { ...value };
  delete material[key];
  if (sha256Digest(material) !== actual) throw new OperationsContractErrorV1("digest_mismatch");
}
