export const TIER_NAMES = ["Base", "Normal", "Elevated", "High", "Surge"];

export interface Tier {
  threshold: number;
  multiplier: number;
}

export interface PricingConfig {
  windowSize: number;
  bucketSize: number;
  basePrice: number;
  tiers: Tier[];
  smoothingAlpha: number;
  now?: () => number;
}

export const DEFAULT_CONFIG: PricingConfig = {
  // Sliding window
  windowSize: 60, // seconds
  bucketSize: 1, // seconds per bucket

  // Base price in dollars
  basePrice: 0.001,

  // Demand tiers: [threshold (requests/window), multiplier]
  // Price is linearly interpolated between adjacent tiers
  tiers: [
    { threshold: 0, multiplier: 1.0 }, // Base
    { threshold: 50, multiplier: 1.5 }, // Normal
    { threshold: 200, multiplier: 2.5 }, // Elevated
    { threshold: 1000, multiplier: 5.0 }, // High
    { threshold: 5000, multiplier: 10.0 }, // Surge
  ],

  // EMA smoothing factor, per second
  // 0 = price never changes, 1 = no smoothing, instant
  smoothingAlpha: 0.3,
};
