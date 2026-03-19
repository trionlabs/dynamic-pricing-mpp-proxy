import { DEFAULT_CONFIG, TIER_NAMES, type PricingConfig, type Tier } from "./config";

export interface TierInfo {
  level: number;
  name: string;
  threshold: number;
  multiplier: number;
  demand: number;
}

export interface PricingStatus {
  demand: number;
  rawPrice: number;
  smoothedPrice: number;
  formattedPrice: string;
  tier: TierInfo;
  config: PricingConfig;
}

export class PricingEngine {
  private config: PricingConfig;
  private now: () => number;
  private buckets: number[];
  private currentIndex: number;
  private totalRequests: number;
  private lastBucketTime: number;
  private smoothedPrice: number | null;
  private lastPriceTime: number;

  constructor(config: Partial<PricingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.now = config.now || (() => Date.now());

    // Ensure tiers are sorted by threshold
    this.config.tiers.sort((a: Tier, b: Tier) => a.threshold - b.threshold);

    // Ring buffer: fixed-size array of buckets
    const numBuckets = Math.ceil(this.config.windowSize / this.config.bucketSize);
    this.buckets = new Array(numBuckets).fill(0);
    this.currentIndex = 0;
    this.totalRequests = 0;
    this.lastBucketTime = this.now();

    // EMA state
    this.smoothedPrice = null;
    this.lastPriceTime = this.now();
  }

  recordRequest(count = 1): void {
    this._advance();
    this.buckets[this.currentIndex] += count;
    this.totalRequests += count;
  }

  getDemand(): number {
    this._advance();
    return this.totalRequests;
  }

  getRawPrice(): number {
    const demand = this.getDemand();
    return this.config.basePrice * this._interpolateMultiplier(demand);
  }

  getCurrentPrice(): number {
    const raw = this.getRawPrice();
    return this._smooth(raw);
  }

  getFormattedPrice(): string {
    return `$${this.getCurrentPrice().toFixed(6)}`;
  }

  getTierInfo(): TierInfo {
    const demand = this.getDemand();
    const { tiers } = this.config;
    let level = 0;
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (demand >= tiers[i].threshold) {
        level = i;
        break;
      }
    }
    return {
      level,
      name: TIER_NAMES[level] || `Tier ${level}`,
      threshold: tiers[level].threshold,
      multiplier: this._interpolateMultiplier(demand),
      demand,
    };
  }

  getStatus(): PricingStatus {
    this._advance();
    const demand = this.totalRequests;
    const multiplier = this._interpolateMultiplier(demand);
    const raw = this.config.basePrice * multiplier;
    const smoothed = this._peekSmooth(raw);

    const { tiers } = this.config;
    let level = 0;
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (demand >= tiers[i].threshold) {
        level = i;
        break;
      }
    }

    return {
      demand,
      rawPrice: raw,
      smoothedPrice: smoothed,
      formattedPrice: `$${smoothed.toFixed(6)}`,
      tier: {
        level,
        name: TIER_NAMES[level] || `Tier ${level}`,
        threshold: tiers[level].threshold,
        multiplier,
        demand,
      },
      config: this.config,
    };
  }

  reset(): void {
    this.buckets.fill(0);
    this.currentIndex = 0;
    this.totalRequests = 0;
    this.lastBucketTime = this.now();
    this.smoothedPrice = null;
    this.lastPriceTime = this.now();
  }

  // Internal

  private _advance(): void {
    const now = this.now();
    const elapsed = now - this.lastBucketTime;
    const steps = Math.floor(elapsed / (this.config.bucketSize * 1000));
    if (steps <= 0) return;

    const len = this.buckets.length;
    const toAdvance = Math.min(steps, len);

    for (let i = 0; i < toAdvance; i++) {
      this.currentIndex = (this.currentIndex + 1) % len;
      this.totalRequests -= this.buckets[this.currentIndex];
      this.buckets[this.currentIndex] = 0;
    }

    this.lastBucketTime += steps * this.config.bucketSize * 1000;
  }

  private _interpolateMultiplier(demand: number): number {
    const { tiers } = this.config;

    if (demand <= tiers[0].threshold) return tiers[0].multiplier;
    if (demand >= tiers[tiers.length - 1].threshold) return tiers[tiers.length - 1].multiplier;

    for (let i = 0; i < tiers.length - 1; i++) {
      if (demand >= tiers[i].threshold && demand < tiers[i + 1].threshold) {
        const span = tiers[i + 1].threshold - tiers[i].threshold;
        const progress = (demand - tiers[i].threshold) / span;
        return tiers[i].multiplier + progress * (tiers[i + 1].multiplier - tiers[i].multiplier);
      }
    }

    return tiers[tiers.length - 1].multiplier;
  }

  private _smooth(rawPrice: number): number {
    const now = this.now();

    if (this.smoothedPrice === null) {
      this.smoothedPrice = rawPrice;
      this.lastPriceTime = now;
      return rawPrice;
    }

    const elapsedSec = (now - this.lastPriceTime) / 1000;
    const alpha = this.config.smoothingAlpha;
    const effectiveAlpha = 1 - Math.pow(1 - alpha, elapsedSec);

    this.smoothedPrice = effectiveAlpha * rawPrice + (1 - effectiveAlpha) * this.smoothedPrice;
    this.lastPriceTime = now;
    return this.smoothedPrice;
  }

  // Non-mutating smooth peek for status polling
  private _peekSmooth(rawPrice: number): number {
    if (this.smoothedPrice === null) return rawPrice;

    const now = this.now();
    const elapsedSec = (now - this.lastPriceTime) / 1000;
    const alpha = this.config.smoothingAlpha;
    const effectiveAlpha = 1 - Math.pow(1 - alpha, elapsedSec);

    return effectiveAlpha * rawPrice + (1 - effectiveAlpha) * this.smoothedPrice;
  }
}
