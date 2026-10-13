import { Pool } from "pg";

/** pg-pool can resolve end() before removed clients acknowledge socket end.
 * Keep that barrier before a disposable fixture stops PostgreSQL. The 5s bound
 * matches the production private database close limit; failures stay visible. */
export function drainingPool(options: ConstructorParameters<typeof Pool>[0], boundMs = 5_000) {
  const pool = new Pool(options);
  const endings = new Set<Promise<void>>();
  pool.on("connect", client => {
    let finished!: () => void;
    const ended = new Promise<void>(resolve => { finished = resolve; });
    endings.add(ended);
    client.once("end", () => { endings.delete(ended); finished(); });
  });
  let closing: Promise<void> | undefined;
  return {
    pool,
    end() {
      // Share the barrier: pg-pool refuses a second end() call.
      return closing ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await pool.end();
              await Promise.all([...endings]);
            })(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(
                `test pool drain timed out after ${boundMs}ms waiting for client end acknowledgements`,
              )), boundMs);
            }),
          ]);
        } finally { clearTimeout(timer); }
      })();
    },
  };
}
