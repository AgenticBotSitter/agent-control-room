import { updaterRefuseV1 } from "./contracts.mjs";

/** Canonical JSON used by root-held updater authority. */
export function canonicalJsonV1(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw updaterRefuseV1("updater_plan_json_refused");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => {
    const child = value[key];
    if (child === undefined || ["function", "symbol", "bigint"].includes(typeof child))
      throw updaterRefuseV1("updater_plan_json_refused");
    return `${JSON.stringify(key)}:${canonicalJsonV1(child)}`;
  }).join(",")}}`;
  throw updaterRefuseV1("updater_plan_json_refused");
}
