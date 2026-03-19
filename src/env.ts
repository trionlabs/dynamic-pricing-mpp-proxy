/**
 * Environment bindings type definition
 *
 * Extends the auto-generated CloudflareBindings with secrets that come from
 * .dev.vars locally or `wrangler secret put` in production.
 */

import type { JWTPayload } from "./jwt";
import type { PricingEngineDO } from "./pricing/engine";

export interface PricingPatternConfig {
  basePrice: string;
  minPrice: string;
  maxPrice: string;
  windowSizeMs: number;
  surgeThreshold: number;
  surgeMultiplierMax: number;
}

export interface ProtectedPattern {
  pattern: string;
  amount: string;
  description: string;
  pricing?: PricingPatternConfig;
  bot_score_threshold?: number;
  except_detection_ids?: number[];
}

export interface Env extends Omit<
  CloudflareBindings,
  "PAY_TO" | "PAYMENT_CURRENCY" | "TEMPO_TESTNET" | "PROTECTED_PATTERNS"
> {
  JWT_SECRET: string;
  MPP_SECRET_KEY: string;
  PAY_TO: `0x${string}`;
  PAYMENT_CURRENCY: `0x${string}`;
  TEMPO_TESTNET: boolean;
  TEMPO_RPC_URL?: string;
  ORIGIN_URL?: string;
  ORIGIN_SERVICE?: Fetcher;
  PRICING_ENGINE: DurableObjectNamespace<PricingEngineDO>;
  AI: Ai;
  PROTECTED_PATTERNS: ProtectedPattern[];
}

/** Full app context type for Hono */
export interface AppContext {
  Bindings: Env;
  Variables: {
    auth?: JWTPayload;
  };
}
