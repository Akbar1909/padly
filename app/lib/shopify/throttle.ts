/**
 * Shopify GraphQL cost-based rate limiting is a leaky bucket per shop:
 * `maximumAvailable` points, refilled at `restoreRate` points/second
 * (100/s on standard plans, up to 1,000/s on Plus). Every response carries
 * `extensions.cost.throttleStatus`; we keep the last one per shop and wait
 * before a request would overdraw the bucket.
 */
export interface ThrottleState {
  available: number;
  max: number;
  rate: number;
  /** ms epoch when `available` was observed */
  ts: number;
}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export function fromThrottleStatus(
  status: ThrottleStatus,
  now: number,
): ThrottleState {
  return {
    available: status.currentlyAvailable,
    max: status.maximumAvailable,
    rate: status.restoreRate,
    ts: now,
  };
}

export function projectedAvailable(state: ThrottleState, now: number): number {
  const refill = (Math.max(0, now - state.ts) / 1000) * state.rate;
  return Math.min(state.max, state.available + refill);
}

/** Milliseconds to wait until `cost` points are available (0 when they already are). */
export function waitMsFor(
  state: ThrottleState | null,
  cost: number,
  now: number,
): number {
  if (!state || state.rate <= 0) return 0;
  const needed = Math.min(cost, state.max);
  const available = projectedAvailable(state, now);
  if (available >= needed) return 0;
  return Math.ceil(((needed - available) / state.rate) * 1000);
}
