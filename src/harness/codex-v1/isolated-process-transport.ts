import { StringDecoder } from "node:string_decoder";
import {
  CODEX_APP_SERVER_MAX_FRAME_BYTES_V1,
} from "./isolated-jsonrpc";
import type { CodexAppServerLineTransportV1 } from "./isolated-runtime";

export const CODEX_APP_SERVER_MAX_QUEUED_LINES_V1 = 64;

export interface CodexAppServerChildPortV1 {
  writeStdin(data: string): Promise<void>;
  closeStdin(): void;
  terminate(): void;
  discardStderr(): void;
  onStdout(listener: (chunk: Uint8Array) => void): () => void;
  onExit(listener: () => void): () => void;
  onError(listener: () => void): () => void;
}

/**
 * Bounded stdout-to-JSONL transport for an already-created app-server child.
 * It never captures stderr and never owns process creation or credentials.
 */
export class CodexAppServerChildLineTransportV1 implements CodexAppServerLineTransportV1 {
  private readonly decoder = new StringDecoder("utf8");
  private readonly lines: string[] = [];
  private readonly unsubscribe: Array<() => void> = [];
  private buffer = "";
  private waiter?: { resolve(value: string | null): void; reject(error: Error): void };
  private fatal = false;
  private exited = false;
  private closed = false;

  constructor(
    private readonly child: CodexAppServerChildPortV1,
    private readonly maximumFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES_V1,
  ) {
    if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1_024 || maximumFrameBytes > 1_048_576) {
      throw new Error("Codex app-server child frame limit invalid");
    }
    child.discardStderr();
    this.unsubscribe.push(
      child.onStdout((chunk) => this.acceptChunk(chunk)),
      child.onExit(() => this.acceptExit()),
      child.onError(() => this.fail()),
    );
  }

  async write(line: string): Promise<void> {
    if (this.closed || this.exited || this.fatal) throw new Error("Codex app-server child unavailable");
    if (typeof line !== "string" || !line.endsWith("\n") || line.slice(0, -1).includes("\n")
      || Buffer.byteLength(line, "utf8") > this.maximumFrameBytes) throw new Error("Codex app-server child write invalid");
    await this.child.writeStdin(line);
  }

  async readLine(): Promise<string | null> {
    if (this.fatal) throw new Error("Codex app-server child framing failed");
    const line = this.lines.shift();
    if (line !== undefined) return line;
    if (this.closed || this.exited) return null;
    if (this.waiter) throw new Error("Codex app-server child concurrent read forbidden");
    return await new Promise<string | null>((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.closeStdin();
    if (!this.exited) this.child.terminate();
    this.finishWaiter(null);
    for (const stop of this.unsubscribe.splice(0)) stop();
  }

  private acceptChunk(chunk: Uint8Array): void {
    if (this.closed || this.exited || this.fatal || !(chunk instanceof Uint8Array)) return;
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maximumFrameBytes || (this.lines.length >= CODEX_APP_SERVER_MAX_QUEUED_LINES_V1 && !this.waiter)) {
        this.fail(); return;
      }
      if (this.waiter) this.finishWaiter(line); else this.lines.push(line);
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maximumFrameBytes) this.fail();
  }

  private acceptExit(): void {
    if (this.exited) return;
    this.exited = true;
    const tail = this.decoder.end();
    if (tail) this.buffer += tail;
    if (this.buffer.length > 0) { this.fail(); return; }
    this.finishWaiter(null);
  }

  private fail(): void {
    if (this.fatal) return;
    this.fatal = true;
    this.lines.length = 0;
    this.buffer = "";
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(new Error("Codex app-server child framing failed"));
  }

  private finishWaiter(value: string | null): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.resolve(value);
  }
}
