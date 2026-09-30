/** Owner-visible fleet choices. Keep presentation and flow eligibility here so
 * the worker board, enrollment validation and Connect-a-bot page cannot drift. */
export const FLEET_WORKER_OPTIONS_V1 = Object.freeze([
  { kind: "claude-code", label: "Claude Code", connectBot: true },
  { kind: "codex", label: "Codex", connectBot: true },
  { kind: "hermes", label: "Hermes", connectBot: true },
  { kind: "cursor", label: "Cursor", connectBot: true },
  { kind: "claude-desktop", label: "Claude Desktop", connectBot: true },
  { kind: "mcp-agent", label: "Generic MCP", connectBot: true },
  { kind: "tool", label: "Local tool adapter", connectBot: false },
] as const);

export type FleetWorkerKindV1 = (typeof FLEET_WORKER_OPTIONS_V1)[number]["kind"];
export type FleetConnectBotKindV1 = Extract<(typeof FLEET_WORKER_OPTIONS_V1)[number],
  { connectBot: true }>["kind"];

export const FLEET_WORKER_KINDS_V1 = Object.freeze(FLEET_WORKER_OPTIONS_V1.map(option => option.kind));
export const FLEET_CONNECT_BOT_OPTIONS_V1 = Object.freeze(FLEET_WORKER_OPTIONS_V1.filter(
  (option): option is Extract<(typeof FLEET_WORKER_OPTIONS_V1)[number], { connectBot: true }> => option.connectBot));

export const FLEET_CAPABILITY_OPTIONS_V1 = Object.freeze([
  { capability: "code.change", label: "Change code", connectBot: true },
  { capability: "code.review", label: "Review code", connectBot: true },
  { capability: "research", label: "Research", connectBot: true },
  { capability: "writing", label: "Writing", connectBot: true },
  { capability: "testing", label: "Testing", connectBot: true },
  { capability: "tool.whisper", label: "Whisper transcription", connectBot: false },
] as const);

export const FLEET_CONNECT_BOT_CAPABILITY_OPTIONS_V1 = Object.freeze(FLEET_CAPABILITY_OPTIONS_V1.filter(
  (option): option is Extract<(typeof FLEET_CAPABILITY_OPTIONS_V1)[number], { connectBot: true }> => option.connectBot));
