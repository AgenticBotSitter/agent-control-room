import { PROJECT_PACK_SCHEMA_V1, parseProjectPackV1, type ProjectPackV1 } from "./v1/project-pack";
import { PROJECT_PACK_SCHEMA_V2, parseProjectPackV2, type ProjectPackV2 } from "./v2/project-pack";

export type ProjectPack = Readonly<ProjectPackV1> | Readonly<ProjectPackV2>;

/** Version dispatcher. Every version retains its own strict parser and wire contract. */
export function parseProjectPack(value: unknown): ProjectPack {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("project_pack_malformed");
  const schema = (value as Record<string, unknown>).schema;
  if (schema === PROJECT_PACK_SCHEMA_V1) return parseProjectPackV1(value);
  if (schema === PROJECT_PACK_SCHEMA_V2) return parseProjectPackV2(value);
  throw new Error("project_pack_unknown_version");
}

export { PROJECT_PACK_SCHEMA_V1, PROJECT_PACK_SCHEMA_V2 };
