import type { z } from "zod";
import { exactProjectWorkspaceJsonV1 } from "../../project-workspace/v1/exact";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { PublicPackageContractErrorV1 } from "./errors";

export function parseExactPublicPackageV1<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  try {
    const parsed = schema.parse(exactProjectWorkspaceJsonV1(value));
    assertNoSecretMaterial(parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof PublicPackageContractErrorV1) throw error;
    if (error instanceof Error && error.message.includes("contains secret material")) {
      throw new PublicPackageContractErrorV1("redaction_rejected");
    }
    throw new PublicPackageContractErrorV1("invalid_input");
  }
}

export function verifyPublicPackageDigestV1(value: Record<string, unknown>, key: string, actual: string): void {
  const material = { ...value };
  delete material[key];
  if (sha256Digest(material) !== actual) throw new PublicPackageContractErrorV1("digest_mismatch");
}
