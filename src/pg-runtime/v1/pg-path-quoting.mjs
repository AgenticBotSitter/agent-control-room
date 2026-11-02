/** One literal argument for the POSIX shell used by pg_ctl (and SSH). */
export function shellArgumentV1(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// unix_socket_directories is a PostgreSQL list, even when it contains one path.
// Double quotes protect commas and whitespace; doubled quotes are list escapes.
const socketList = value => `"${value.replaceAll('"', '""')}"`;

/** One pg_ctl -o argument, including both the shell and GUC list layers. */
export function pgSocketOptionV1(directory) {
  return `-c ${shellArgumentV1(`unix_socket_directories=${socketList(directory)}`)}`;
}

/** A postgresql.conf string literal around the same single-directory list. */
export function pgSocketConfigV1(directory) {
  return `'${socketList(directory).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

/** libpq keyword/value strings have their own escaping, independent of shells. */
export function pgConninfoValueV1(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

// pg_ctl surrounds these paths with double quotes in its own shell command.
// Preserve their literal bytes through that layer, including expansion syntax.
const pgCtlQuotedPath = value => value.replace(/["\\$`]/gu, "\\$&");

/** pg_ctl re-quotes -D without escaping double quotes. Use PGDATA for pg_ctl
 * and a shell-quoted -D in -o for postgres, preserving process identity checks.
 * Stop/status do not launch a shell and retain their explicit -D arguments.
 */
export function pgCtlInvocationV1(args, environment, postgresExecutable = "") {
  const index = args.indexOf("-D");
  if (!args.includes("start") || index < 0) return { args, environment };
  const startArgs = [...args.slice(0, index), ...args.slice(index + 2)];
  if (postgresExecutable && !startArgs.includes("-p")) startArgs.unshift("-p", postgresExecutable);
  for (const flag of ["-l", "-p"]) {
    const pathIndex = startArgs.indexOf(flag);
    if (pathIndex >= 0) startArgs[pathIndex + 1] = pgCtlQuotedPath(startArgs[pathIndex + 1]);
  }
  const optionIndex = startArgs.indexOf("-o");
  const dataOption = `-D ${shellArgumentV1(args[index + 1])}`;
  if (optionIndex < 0) startArgs.push("-o", dataOption);
  else startArgs[optionIndex + 1] += ` ${dataOption}`;
  return { args: startArgs, environment: { ...environment, PGDATA: args[index + 1] } };
}
