/** Process-local budget port. Durable reservation/fencing belongs to the run store. */
export class IdeaLabPanelBudgetV1 {
  readonly #limit: number;
  #charged = 0;
  #held = 0;
  #uncertain = false;
  constructor(maximumCostUsd: number, chargedCostUsd = 0) {
    this.#limit = units(maximumCostUsd, false);
    this.#charged = units(chargedCostUsd, true);
  }
  get remainingCostUsd(): number {
    return this.#uncertain ? 0 : Math.max(0, this.#limit - this.#charged - this.#held) / SCALE;
  }
  reserve(maximumCallCostUsd = this.remainingCostUsd): Readonly<{
    maximumCostUsd: number; settle(actualCostUsd: number | null): boolean;
  }> | undefined {
    const maximum = units(maximumCallCostUsd, true);
    if (this.#uncertain || maximum > this.#limit - this.#charged - this.#held) return undefined;
    // No await between observing the allowance and holding it.
    this.#held += maximum;
    let settled = false;
    return Object.freeze({ maximumCostUsd: maximum / SCALE, settle: (actualCostUsd: number | null) => {
      if (settled) throw new Error("panel_reservation_already_settled");
      const actual = actualCostUsd === null ? null : units(actualCostUsd, true);
      settled = true;
      this.#held -= maximum;
      if (actual === null) { this.#uncertain = true; return false; }
      this.#charged += actual;
      return actual <= maximum;
    } });
  }
}
const SCALE = 1_000_000_000;
function units(value: number, roundUp: boolean): number {
  if (!Number.isFinite(value) || value < 0 || value > 450) throw new Error("panel_cost_invalid");
  return roundUp ? Math.ceil(value * SCALE) : Math.floor(value * SCALE);
}
