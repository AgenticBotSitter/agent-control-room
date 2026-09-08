// Research-only virtual modules supplied from SHA-checked pinned source by the
// fixture bundler. These declarations are not production adapter implementations.
declare module "f3-desktop" {
  export const ActiveSessionsBar: import("react").ComponentType<{
    runs: Array<{ runId: string; connectionId: string; profile: string; sessionId: string | null; loading: boolean; title?: string }>;
    activeRunId: string; onSelect: (key: string) => void; onClose: (key: string) => void; onNew: () => void;
  }>;
}
declare module "f3-webui" {
  export function setWebState(state: { session: { session_id: string } | null; busy: boolean }): void;
  export function _buildSessionAction(label: string, meta: string, icon: string, onSelect: () => void): HTMLButtonElement;
  export function _isSessionEffectivelyStreaming(session: { session_id: string }): boolean;
}
