export interface RestartPolicyOptions {
  /** Crashes inside `windowMs` after which restarting stops. Default 5. */
  maxCrashes?: number;
  /** Sliding window the crashes are counted in. Default 60 s. */
  windowMs?: number;
  /** Delay before the first restart; doubles with every crash in the window. Default 250 ms. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Decides whether to restart a crashed process and how long to wait. A process
 * that keeps dying right after start is not worth restarting forever, so after
 * `maxCrashes` in the window it gives up and the app reports the failure.
 */
export class RestartPolicy {
  private readonly crashes: number[] = [];
  private readonly maxCrashes: number;
  private readonly windowMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: RestartPolicyOptions = {}) {
    this.maxCrashes = options.maxCrashes ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 5_000;
  }

  /** Record a crash at `now`; returns the delay before restarting, or `undefined` to give up. */
  onCrash(now: number): number | undefined {
    this.crashes.push(now);
    while (this.crashes.length > 0 && now - (this.crashes[0] as number) > this.windowMs) {
      this.crashes.shift();
    }
    if (this.crashes.length >= this.maxCrashes) return undefined;
    return Math.min(this.baseDelayMs * 2 ** (this.crashes.length - 1), this.maxDelayMs);
  }
}
