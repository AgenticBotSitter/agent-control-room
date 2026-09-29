export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timerId: number): void;
}

interface Timer {
  id: number;
  dueAt: number;
  callback: () => void;
}

export class TestClock implements Clock {
  #instant: number;
  #nextTimerId = 1;
  #timers = new Map<number, Timer>();

  constructor(instant = 0) {
    if (!Number.isSafeInteger(instant) || instant < 0) throw new TypeError("clock instant must be a non-negative safe integer");
    this.#instant = instant;
  }

  now(): number { return this.#instant; }

  setTimeout(callback: () => void, delayMs: number): number {
    if (typeof callback !== "function") throw new TypeError("timer callback must be a function");
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new TypeError("timer delay must be a non-negative safe integer");
    const dueAt = this.#instant + delayMs;
    if (!Number.isSafeInteger(dueAt)) throw new TypeError("timer deadline must be a safe integer");
    const id = this.#nextTimerId++;
    this.#timers.set(id, { id, dueAt, callback });
    return id;
  }

  clearTimeout(timerId: number): void { this.#timers.delete(timerId); }

  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new TypeError("clock advance must be a non-negative safe integer");
    const target = this.#instant + ms;
    if (!Number.isSafeInteger(target)) throw new TypeError("clock target must be a safe integer");
    while (true) {
      const next = [...this.#timers.values()]
        .filter(timer => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) break;
      this.#timers.delete(next.id);
      this.#instant = next.dueAt;
      next.callback();
    }
    this.#instant = target;
  }
}
