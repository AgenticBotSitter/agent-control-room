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
  const nativeEnd = pool.end.bind(pool);
  let closing: Promise<void> | undefined;
  function end() {
    // Share the barrier: pg-pool refuses a second end() call.
    return closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await nativeEnd();
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
  }
  // Production adapters receive the raw Pool. Route their shutdown through
  // the same barrier as fixture cleanup, including pg's callback overload.
  pool.end = ((callback?: (error?: Error) => void) => {
    const ending = end();
    if (callback) { void ending.then(() => callback(), error => callback(error)); }
    else return ending;
  }) as Pool["end"];
  return { pool, end };
}
