import { BrowserRequestError } from "./browser-client";
import type { NewsCollectionStatus } from "./news-collection-status-wire";

/** Finite observation of saved collection state; no submission capability. */
export function createNewsStatusObserver(options: {
  read: (signal: AbortSignal) => Promise<NewsCollectionStatus>;
  accept: (value: NewsCollectionStatus) => void;
  failed: (error: unknown) => void;
  hidden: () => boolean;
}) {
  const abort = new AbortController();
  let stopped = false, busy = false, denied = false, checks = 0;
  let latest: NewsCollectionStatus | undefined;
  return {
    async read(automatic = false) {
      if (stopped || busy || automatic && (denied || options.hidden() || checks >= 180
        || !latest?.latest || !["queued", "running"].includes(latest.latest.state))) return;
      busy = true; if (automatic) checks++;
      try {
        const value = await options.read(abort.signal);
        if (!stopped) { latest = value; denied = false; options.accept(value); }
      } catch (reason) {
        if (!stopped) {
          if (reason instanceof BrowserRequestError && ["authentication_required", "access_denied", "not_found"].includes(reason.code)) denied = true;
          options.failed(reason);
        }
      } finally { busy = false; }
    },
    stop() { stopped = true; abort.abort(); },
  };
}
