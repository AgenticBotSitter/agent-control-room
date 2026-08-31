import { sha256Digest } from "../../security";
import type { ControlRoomMcpReplayBindingV1, ControlRoomMcpReplayLedgerV1, ControlRoomMcpToolResultV1 } from "./types";

type ReplayEntry = ({ requestDigest: string; binding:ControlRoomMcpReplayBindingV1; state: "in_progress" }
  | { requestDigest: string; binding:ControlRoomMcpReplayBindingV1; state: "complete"; result: ControlRoomMcpToolResultV1 });

/** Effect-free reference ledger. Production wiring must replace this with durable storage. */
export class InMemoryControlRoomMcpReplayLedgerV1 implements ControlRoomMcpReplayLedgerV1 {
  private readonly entries = new Map<string, ReplayEntry>();
  constructor(private readonly maximumEntries = 10_000) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 100_000) throw new Error("MCP replay configuration invalid");
  }

  claim(input: { replayKey: string; requestDigest: string; binding:ControlRoomMcpReplayBindingV1 }) {
    const existing = this.entries.get(input.replayKey);
    if (existing) {
      if (existing.requestDigest !== input.requestDigest || sha256Digest(existing.binding)!==sha256Digest(input.binding)) throw new Error("MCP replay conflict");
      if (existing.state === "in_progress") return { disposition: "in_progress" as const };
      return { disposition: "replay" as const, result: structuredClone(existing.result) };
    }
    if (this.entries.size >= this.maximumEntries) throw new Error("MCP replay capacity exhausted");
    this.entries.set(input.replayKey, { requestDigest: input.requestDigest,binding:structuredClone(input.binding), state: "in_progress" });
    return { disposition: "execute" as const };
  }

  complete(input: { replayKey: string; requestDigest: string; result: ControlRoomMcpToolResultV1 }): void {
    const existing = this.entries.get(input.replayKey);
    if (!existing || existing.state !== "in_progress" || existing.requestDigest !== input.requestDigest) throw new Error("MCP replay settlement invalid");
    this.entries.set(input.replayKey, { requestDigest: input.requestDigest,binding:existing.binding, state: "complete", result: structuredClone(input.result) });
  }

  fail(input: { replayKey: string; requestDigest: string }): void {
    const existing = this.entries.get(input.replayKey);
    if (!existing || existing.state !== "in_progress" || existing.requestDigest !== input.requestDigest) throw new Error("MCP replay settlement invalid");
    this.entries.delete(input.replayKey);
  }
}
