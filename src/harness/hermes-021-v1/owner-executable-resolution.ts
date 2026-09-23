import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, normalize } from "node:path";
import { z } from "zod";

const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && normalize(value) === value
  && !/[\u0000-\u001f\u007f]/u.test(value));
const command = z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/);

type CandidatePort = Readonly<{
  access(candidate: string, mode: number): Promise<void>;
  realpath(candidate: string): Promise<string>;
  lstat(candidate: string): Promise<Readonly<{ isFile(): boolean }>>;
}>;

const defaultPort: CandidatePort = Object.freeze({ access, realpath, lstat });
const unavailable = (): never => { throw new Error("hermes_021_owner_executable_unavailable"); };

async function inspectCandidate(candidate: string, port: CandidatePort): Promise<string | undefined> {
  try {
    await port.access(candidate, constants.X_OK);
    const resolved = await port.realpath(candidate);
    if (!absolutePath.safeParse(resolved).success || !(await port.lstat(resolved)).isFile()) return undefined;
    return resolved;
  } catch { return undefined; }
}

/**
 * Resolves an owner-selected CLI command to the exact executable path used by
 * a one-shot local qualification.  The resolved path stays in process memory:
 * callers must not log or persist it.  This does not launch Hermes or create
 * a permanent worker configuration.
 */
export async function resolveOwnerSelectedHermesExecutableV1(input: Readonly<{
  executable?: unknown;
  executableCommand?: unknown;
  path?: unknown;
}>, port: CandidatePort = defaultPort): Promise<string> {
  if (!input || !port || typeof port.access !== "function" || typeof port.realpath !== "function" || typeof port.lstat !== "function") unavailable();
  const suppliedPath = absolutePath.safeParse(input.executable);
  const suppliedCommand = command.safeParse(input.executableCommand);
  const selectedPath = suppliedPath.success ? suppliedPath.data : undefined;
  const selectedCommand = suppliedCommand.success ? suppliedCommand.data : undefined;
  if (Number(Boolean(selectedPath)) + Number(Boolean(selectedCommand)) !== 1) unavailable();
  if (selectedPath) return (await inspectCandidate(selectedPath, port)) ?? unavailable();
  const searchPath = typeof input.path === "string" ? input.path : undefined;
  if (!selectedCommand || !searchPath || searchPath.length > 32_768) unavailable();
  const pathToSearch = searchPath as string, commandToSearch = selectedCommand as string;
  for (const directory of pathToSearch.split(delimiter)) {
    if (!absolutePath.safeParse(directory).success) continue;
    const resolved = await inspectCandidate(join(directory, commandToSearch), port);
    if (resolved) return resolved;
  }
  return unavailable();
}
