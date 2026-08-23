import { z } from "zod";
import { DOMAIN_CONTRACT_VERSION } from "./types";
import { domainEntitySchema } from "./validators";

export function buildDomainJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(domainEntitySchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://control-room.invalid/contracts/control-room-domain-v1.schema.json",
    title: "Control Room canonical domain entity v1",
    description: `Generated from ${DOMAIN_CONTRACT_VERSION} Zod validators. Cross-record and transition invariants are enforced by the domain contract tests and transactional implementation.`,
    ...generated,
  };
}
