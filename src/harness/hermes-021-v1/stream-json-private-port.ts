import { classifyHermes021MacosResultV1, hermes021MacosLocalBindingSchemaV1,
  type Hermes021MacosLocalPrivatePortV1, type Hermes021MacosTaskV1 } from "./macos-local-worker";

const unavailable = (): never => { throw new Error("hermes_021_macos_stream_json_private_port_unavailable"); };

/**
 * Installation-owned process boundary. The host owns executable selection,
 * login, model, provider, working directory, and process lifetime. This
 * adapter receives only bounded stream-json lines; it cannot start a shell or
 * discover private configuration itself.
 */
export interface Hermes021MacosStreamJsonHostV1 {
  execute(input: Readonly<{
    task: Hermes021MacosTaskV1;
    signal?: AbortSignal;
    onLine(line: string): Promise<void>;
  }>): Promise<void>;
}

/**
 * Builds the private-port side of the local runner. It saves exactly one valid
 * terminal result through the supplied staging callback before returning to
 * Control Room. A malformed stream or multiple terminal results is returned
 * for normal uncertainty handling and is never staged as a valid completion.
 */
export function createHermes021MacosStreamJsonPrivatePortV1(bindingValue: unknown,
  host: Hermes021MacosStreamJsonHostV1): Hermes021MacosLocalPrivatePortV1 {
  const binding = hermes021MacosLocalBindingSchemaV1.parse(bindingValue);
  if (!host || typeof host.execute !== "function") unavailable();
  return Object.freeze({
    async run(input: Parameters<Hermes021MacosLocalPrivatePortV1["run"]>[0]) {
      if (!input || input.localServiceId !== binding.localServiceId || input.signal?.aborted) unavailable();
      const lines: unknown[] = [];
      let receivedBytes = 0;
      await host.execute({ task: input.task, signal: input.signal, async onLine(line) {
        if (typeof line !== "string" || line.includes("\n") || line.includes("\r")) unavailable();
        receivedBytes += Buffer.byteLength(line, "utf8");
        if (receivedBytes > 262_144) unavailable();
        try { lines.push(JSON.parse(line)); } catch { unavailable(); }
      } });
      const outcome = classifyHermes021MacosResultV1(lines);
      if (outcome.kind === "completed" && input.terminalStage) await input.terminalStage.capture(outcome.terminalResult, input.signal);
      return Object.freeze(lines);
    },
  });
}
