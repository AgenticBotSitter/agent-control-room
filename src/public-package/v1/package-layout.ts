import { z } from "zod";
import { sha256Digest } from "../../security";
import { PUBLIC_PACKAGE_CONTRACT_V1 } from "./contract";

export const PUBLIC_PACKAGE_LAYOUT_CONTRACT_V1 = "control-room-public-package-layout/v1" as const;

export interface PublicPackageTreeDefinitionV1 {
  contractVersion: typeof PUBLIC_PACKAGE_LAYOUT_CONTRACT_V1;
  classId: "public:core" | "public:adapter-sdk" | "public:conformance-kit" | "public:reference-adapter";
  root: "packages/control-room-core/" | "packages/control-room-adapter-sdk/" | "packages/control-room-conformance-kit/" | "packages/reference-adapters/";
  packageName: "@control-room/public-core" | "@control-room/observation-adapter-sdk" | "@control-room/conformance-kit" | "@control-room/synthetic-reference-adapters";
  allowedPackageDependencies: readonly string[];
  localCandidateOnly: true;
  publicRuntimeImportsAllowed: false;
  effectAuthority: "none";
  definitionDigest: string;
}

const definitions = [
  ["public:core", "packages/control-room-core/", "@control-room/public-core", ["zod"]],
  ["public:adapter-sdk", "packages/control-room-adapter-sdk/", "@control-room/observation-adapter-sdk", ["@control-room/public-core"]],
  ["public:conformance-kit", "packages/control-room-conformance-kit/", "@control-room/conformance-kit", ["@control-room/observation-adapter-sdk"]],
  ["public:reference-adapter", "packages/reference-adapters/", "@control-room/synthetic-reference-adapters", ["@control-room/public-core", "@control-room/observation-adapter-sdk", "@control-room/conformance-kit"]],
] as const;

const schema = z.object({
  contractVersion: z.literal(PUBLIC_PACKAGE_LAYOUT_CONTRACT_V1),
  classId: z.enum(["public:core", "public:adapter-sdk", "public:conformance-kit", "public:reference-adapter"]),
  root: z.string(), packageName: z.string(), allowedPackageDependencies: z.array(z.string()), localCandidateOnly: z.literal(true),
  publicRuntimeImportsAllowed: z.literal(false), effectAuthority: z.literal("none"), definitionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

/** Frozen expected package topology. It describes only local source candidates and confers no release permission. */
export function buildPublicPackageTreeDefinitionsV1(): PublicPackageTreeDefinitionV1[] {
  return definitions.map(([classId, root, packageName, allowedPackageDependencies]) => {
    const material: Omit<PublicPackageTreeDefinitionV1, "definitionDigest"> = {
      contractVersion: PUBLIC_PACKAGE_LAYOUT_CONTRACT_V1,
      classId: classId as PublicPackageTreeDefinitionV1["classId"],
      root: root as PublicPackageTreeDefinitionV1["root"],
      packageName: packageName as PublicPackageTreeDefinitionV1["packageName"],
      allowedPackageDependencies: [...allowedPackageDependencies], localCandidateOnly: true, publicRuntimeImportsAllowed: false, effectAuthority: "none",
    };
    return { ...material, definitionDigest: sha256Digest(material) } as PublicPackageTreeDefinitionV1;
  });
}

export function parsePublicPackageTreeDefinitionV1(value: unknown): PublicPackageTreeDefinitionV1 {
  const parsed = schema.parse(value);
  const expected = buildPublicPackageTreeDefinitionsV1().find((item) => item.classId === parsed.classId);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(parsed)) throw new TypeError("public package tree definition drift");
  return parsed as PublicPackageTreeDefinitionV1;
}

export function publicPackageLayoutContractVersionsV1(): readonly string[] {
  return Object.freeze([PUBLIC_PACKAGE_CONTRACT_V1, PUBLIC_PACKAGE_LAYOUT_CONTRACT_V1]);
}
