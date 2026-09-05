export type BuildTarget = "sites" | "vps-node";

export function selectBuildTarget(value: string | undefined): BuildTarget {
  if (value === undefined || value === "sites") return "sites";
  if (value === "vps-node") return value;
  throw new Error("Unsupported Control Room build target");
}
