import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildNodePolicyJsonSchemas } from "../src/node-policy/v1/json-schema";

await mkdir(resolve("contracts"), { recursive: true });
for (const [filename, schema] of Object.entries(buildNodePolicyJsonSchemas())) {
  const output = resolve("contracts", filename);
  await writeFile(output, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  console.log(`Wrote ${output}`);
}
