import { BrowserRequestError } from "./browser-client";
import type { IdeaDetail } from "./idea-wire";

/** Read-only, finite observation. This object has no command or provider capability. */
export function createIdeaDetailRefresh(options: {
  read: (signal: AbortSignal) => Promise<IdeaDetail>;
  accept: (detail: IdeaDetail) => void;
  failed: (error: unknown) => void;
  hidden: () => boolean;
}) {
  let stopped = false, reading = false, held = false, epoch = 0, watchingStart = false;
  let latest: IdeaDetail | undefined, automaticReads = 0, denied = false;
  const abort = new AbortController();
  const active = () => latest?.run ? ["prepared", "running"].includes(latest.run.state) : watchingStart;
  async function read(automatic = false) {
    if (stopped || reading || held || automatic && (denied || options.hidden() || automaticReads >= 180
      || !active() || latest?.canDecide)) return;
    reading = true; const startedEpoch = epoch;
    if (automatic) automaticReads++;
    try {
      const value = await options.read(abort.signal);
      // A form acquired a pending write while this GET was outstanding. Never
      // replace its component/receipt branch with a newer server projection.
      if (!stopped && !held && epoch === startedEpoch) {
        latest = value; denied = false; options.accept(value);
      }
    } catch (error) {
      if (!stopped && !held && epoch === startedEpoch) {
        if (error instanceof BrowserRequestError && ["authentication_required", "access_denied", "not_found"].includes(error.code)) denied = true;
        options.failed(error);
      }
    } finally { reading = false; }
  }
  return {
    read,
    hold(value: boolean) { if (held !== value) { held = value; epoch++; } },
    watchStart() { watchingStart = true; },
    stop() { stopped = true; abort.abort(); },
  };
}
