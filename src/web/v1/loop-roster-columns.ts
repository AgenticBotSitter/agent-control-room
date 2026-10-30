/** The export format, not a roster rule: the tools' `models.tsv` header, in order.
 * Every value rule (launchers, roles, efforts, nicks, grades) is `cr models check`'s. Browser-safe (no Node imports). */
export const loopRosterColumnsV1 = ["name", "launcher", "provider", "family", "class", "roles", "efforts", "default_effort",
  "cost", "on", "note", "nick", "max_build_grade"] as const;
export type LoopRosterColumnV1 = typeof loopRosterColumnsV1[number];
export type LoopRosterRowV1 = Readonly<Record<LoopRosterColumnV1, string>>;
