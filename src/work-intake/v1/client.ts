import { readWorkIntakeBearerV1 } from "./machine-auth";

type Fetch = (input: string, init: RequestInit) => Promise<Pick<Response, "ok" | "json">>;
const project = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u.test(value)
  ? value : (() => { throw new Error("work_intake_client_input_refused"); })();

export function createWorkIntakeLoopbackClientV1(input: Readonly<{ origin: string; bearerSecret: string; fetch?: Fetch }>) {
  let origin: URL;
  try { origin = new URL(input.origin); } catch { throw new Error("work_intake_client_config_invalid"); }
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash || !origin.port)
    throw new Error("work_intake_client_config_invalid");
  const token = readWorkIntakeBearerV1(`Bearer ${input.bearerSecret}`), fetcher = input.fetch ?? fetch;
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    const response = await fetcher(new URL(path, origin).href, { method, redirect: "error",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as { ok?: unknown; result?: unknown };
    if (!response.ok || value.ok !== true) throw new Error("work_intake_request_refused");
    return value.result;
  }
  return Object.freeze({
    submit(value: { projectId: string; idempotencyKey: string; proposal: unknown }) {
      const projectId = project(value.projectId);
      return call("POST", `/v1/projects/${encodeURIComponent(projectId)}/work-batches`,
        { idempotencyKey: value.idempotencyKey, proposal: value.proposal });
    },
    status(value: { projectId: string; batchId: string }) {
      return call("GET", `/v1/projects/${encodeURIComponent(project(value.projectId))}/work-batches/${encodeURIComponent(project(value.batchId))}`);
    },
    list(value: { projectId: string }) {
      return call("GET", `/v1/projects/${encodeURIComponent(project(value.projectId))}/work-batches`);
    },
  });
}
