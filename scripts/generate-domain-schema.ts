import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildDomainJsonSchema } from "../src/domain/v1/json-schema";

const output = resolve("contracts/control-room-domain-v1.schema.json");
await writeFile(output, `${JSON.stringify(buildDomainJsonSchema(), null, 2)}\n`, "utf8");
console.log(`Wrote ${output}`);
