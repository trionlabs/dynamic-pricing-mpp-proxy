/**
 * Authentication middleware for cookie-based JWT verification
 */

import { Context, Next, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { payment } from "mppx/hono";
import { Mppx, tempo } from "mppx/server";
import { createClient, http } from "viem";
import { tempo as tempoMainnet, tempoModerato } from "viem/chains";
import { verifyJWT } from "./jwt";
import type { AppContext, Env } from "./env";

/**
 * Creates a combined middleware that checks for valid cookie authentication
 * and conditionally applies payment middleware only if cookie auth fails
 *
 * @param paymentMiddleware - The payment middleware to apply when no valid cookie exists
 * @returns Combined authentication and payment middleware
 */
export function requirePaymentOrCookie(paymentMw: MiddlewareHandler) {
  return async (c: Context<AppContext>, next: Next) => {
    // Check for valid cookie
    const token = getCookie(c, "auth_token");

    if (token) {
      const jwtSecret = c.env.JWT_SECRET;

      // Ensure JWT_SECRET is configured
      if (!jwtSecret) {
        return c.json(
          {
            error:
              "Server misconfigured: JWT_SECRET not set. See README for setup instructions.",
          },
          500,
        );
      }

      const payload = await verifyJWT(token, jwtSecret);

      // If token is valid, skip payment and go directly to handler
      if (payload) {
        c.set("auth", payload);
        await next(); // Call the handler
        return;
      }
    }

    // No valid cookie - apply payment middleware
    return await paymentMw(c, next);
  };
}

/**
 * Configuration for a protected route that requires payment
 */
export interface ProtectedRouteConfig {
  pattern: string;
  amount: string;
  description: string;
  pricing?: {
    basePrice: string;
    minPrice: string;
    maxPrice: string;
    windowSizeMs: number;
    surgeThreshold: number;
    surgeMultiplierMax: number;
  };
  bot_score_threshold?: number;
  except_detection_ids?: number[];
}

/**
 * Creates middleware for a protected route that requires payment OR valid cookie.
 * If the route has dynamic pricing config, records demand in the PricingEngine DO
 * and uses the surged price for the payment challenge.
 */
export function createProtectedRoute(config: ProtectedRouteConfig) {
  return async (c: Context<AppContext>, next: Next) => {
    let amount = config.amount;

    // Dynamic pricing: record demand and get surged price
    if (config.pricing && c.env.PRICING_ENGINE) {
      const doId = c.env.PRICING_ENGINE.idFromName(config.pattern);
      const stub = c.env.PRICING_ENGINE.get(doId);
      // Pass pricing config for lazy DO initialization
      const engineCfg = {
        basePrice: parseFloat(config.pricing.basePrice),
        windowSize: Math.round(config.pricing.windowSizeMs / 1000),
      };
      const cfgQ = encodeURIComponent(JSON.stringify(engineCfg));
      const res = await stub.fetch(new Request(`https://do/record?config=${cfgQ}`));
      const status = (await res.json()) as { smoothedPrice: number };
      // Use the surged price, clamped to min/max
      const min = parseFloat(config.pricing.minPrice);
      const max = parseFloat(config.pricing.maxPrice);
      const surged = Math.max(min, Math.min(max, status.smoothedPrice));
      amount = surged.toFixed(6);
    }

    const mppx = Mppx.create({
      methods: [
        tempo({
          currency: c.env.PAYMENT_CURRENCY,
          recipient: c.env.PAY_TO,
          testnet: c.env.TEMPO_TESTNET,
          ...(c.env.TEMPO_RPC_URL
            ? {
                getClient: createTempoClientResolver(c.env),
              }
            : {}),
        }),
      ],
      realm: new URL(c.req.url).host,
      secretKey: c.env.MPP_SECRET_KEY,
    });

    const paymentMw = payment(mppx.charge, {
      amount,
      description: config.description,
    });

    return await requirePaymentOrCookie(paymentMw)(c, next);
  };
}

function createTempoClientResolver(env: Env) {
  return ({ chainId }: { chainId?: number }) => {
    const chain = env.TEMPO_TESTNET
      ? tempoModerato
      : { ...tempoMainnet, experimental_preconfirmationTime: 500 };

    return createClient({
      chain: {
        ...chain,
        id: chainId ?? chain.id,
      },
      transport: http(env.TEMPO_RPC_URL),
    });
  };
}
