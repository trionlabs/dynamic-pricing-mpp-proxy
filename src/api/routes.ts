import { Hono } from "hono";
import type { AppContext } from "../env";

const api = new Hono<AppContext>();

/** Helper to get or create a PricingEngine DO for a route pattern */
function getPricingDO(env: AppContext["Bindings"], pattern: string) {
  const id = env.PRICING_ENGINE.idFromName(pattern);
  return env.PRICING_ENGINE.get(id);
}

/**
 * GET /__mpp/api/prices
 * Current prices for all protected routes
 */
api.get("/prices", async (c) => {
  const patterns = c.env.PROTECTED_PATTERNS || [];
  const prices = await Promise.all(
    patterns.map(async (p) => {
      const stub = getPricingDO(c.env, p.pattern);
      const res = await stub.fetch(new Request("https://do/price"));
      const data = (await res.json()) as Record<string, unknown>;
      return {
        pattern: p.pattern,
        description: p.description,
        ...data,
      };
    }),
  );
  return c.json({ prices });
});

/**
 * GET /__mpp/api/status
 * Full status (demand, tier, config) per route
 */
api.get("/status", async (c) => {
  const patterns = c.env.PROTECTED_PATTERNS || [];
  const statuses = await Promise.all(
    patterns.map(async (p) => {
      const stub = getPricingDO(c.env, p.pattern);
      const res = await stub.fetch(new Request("https://do/status"));
      const data = (await res.json()) as Record<string, unknown>;
      return {
        pattern: p.pattern,
        description: p.description,
        ...data,
      };
    }),
  );
  return c.json({ routes: statuses });
});

/**
 * GET /__mpp/api/status/:pattern
 * Status for a single route
 */
api.get("/status/:pattern", async (c) => {
  const pattern = "/" + c.req.param("pattern");
  const stub = getPricingDO(c.env, pattern);
  const res = await stub.fetch(new Request("https://do/status"));
  const data = await res.json();
  return c.json(data);
});

export { api as pricingApi };
