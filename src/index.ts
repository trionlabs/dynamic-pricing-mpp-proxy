import { Hono } from "hono";
import { cors } from "hono/cors";
import { setCookie } from "hono/cookie";
import { createProtectedRoute, type ProtectedRouteConfig } from "./auth";
import { generateJWT } from "./jwt";
import { hasBotManagementException } from "./bot-management";
import { pricingApi } from "./api/routes";
import type { AppContext, Env } from "./env";

export { PricingEngineDO } from "./pricing/engine";

const app = new Hono<AppContext>();

const BUILTIN_PROTECTED_PATHS: ProtectedRouteConfig[] = [
  {
    pattern: "/__mpp/protected",
    amount: "0.01",
    description: "Access to the built-in MPP test endpoint",
  },
];

const BUILT_IN_PUBLIC_PATHS = ["/__mpp/health", "/__mpp/config"];

/** AI endpoint patterns served directly by the Worker (not proxied to origin) */
const AI_ENDPOINTS = ["/api/chat", "/api/embeddings"];

/**
 * Proxy a request to the origin server.
 *
 * Three modes:
 * 1. Service Binding (ORIGIN_SERVICE bound): Calls the bound Worker directly.
 *    Best for Worker-to-Worker communication within the same account.
 *    No network hop, faster than URL-based approaches.
 *
 * 2. External Origin (ORIGIN_URL set): Rewrites the URL to the specified origin
 *    while preserving the original Host header. This allows proxying to another
 *    Worker on a Custom Domain or any external service.
 *
 * 3. DNS-based (default): Uses fetch(request) which routes to the origin server
 *    defined in your DNS records. Best for traditional backends.
 */
async function proxyToOrigin(request: Request, env: Env): Promise<Response> {
  // Service Binding: call the bound Worker directly (highest priority)
  if (env.ORIGIN_SERVICE) {
    return env.ORIGIN_SERVICE.fetch(request);
  }

  if (env.ORIGIN_URL) {
    // External Origin mode: rewrite URL to target origin
    const originalUrl = new URL(request.url);
    const targetUrl = new URL(env.ORIGIN_URL);

    const proxiedUrl = new URL(request.url);
    proxiedUrl.hostname = targetUrl.hostname;
    proxiedUrl.protocol = targetUrl.protocol;
    proxiedUrl.port = targetUrl.port;

    const response = await fetch(proxiedUrl, {
      method: request.method,
      headers: request.headers, // Preserves original Host header
      body: request.body,
      redirect: "manual", // Handle redirects ourselves to rewrite Location headers
    });

    // Rewrite Location header in redirects to keep user on the proxy domain
    // We rewrite ALL redirects to stay on the proxy, regardless of where the origin
    // tries to send the user (e.g., cloudflare.com -> www.cloudflare.com)
    const location = response.headers.get("Location");
    if (location) {
      try {
        const locationUrl = new URL(location, proxiedUrl);

        // Rewrite the location to point back to the proxy
        locationUrl.hostname = originalUrl.hostname;
        locationUrl.protocol = originalUrl.protocol;
        locationUrl.port = originalUrl.port;

        const newHeaders = new Headers(response.headers);
        newHeaders.set("Location", locationUrl.toString());

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      } catch {
        // If URL parsing fails, return response as-is
      }
    }

    return response;
  }

  // DNS-based mode: forward request as-is to origin defined in DNS
  return fetch(request);
}

/**
 * Check if a path matches a route pattern
 * Supports exact matches and prefix matches with /* wildcard
 */
function pathMatchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("/*")) {
    return path.startsWith(pattern.slice(0, -2));
  }
  return path === pattern;
}

/**
 * Helper to find the protected route config for a given path
 * Includes both built-in protected routes and configured patterns
 */
function findProtectedRouteConfig(
  path: string,
  patterns: ProtectedRouteConfig[],
): ProtectedRouteConfig | null {
  // Check built-in protected routes first, then configured patterns
  const allRoutes = [...BUILTIN_PROTECTED_PATHS, ...patterns];
  return (
    allRoutes.find((config) => pathMatchesPattern(path, config.pattern)) ?? null
  );
}

// CORS for pricing API and AI endpoints
app.use("/__mpp/api/*", cors());

// Mount pricing API
app.route("/__mpp/api", pricingApi);

// WebSocket upgrade for live pricing stream
app.get("/__mpp/api/ws/:pattern", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (upgradeHeader !== "websocket") {
    return c.text("Expected WebSocket", 426);
  }
  const pattern = "/" + c.req.param("pattern");
  const doId = c.env.PRICING_ENGINE.idFromName(pattern);
  const stub = c.env.PRICING_ENGINE.get(doId);
  return stub.fetch(new Request("https://do/ws", { headers: c.req.raw.headers }));
});

app.use("*", async (c, next) => {
  const path = c.req.path;
  const protectedPatterns = c.env.PROTECTED_PATTERNS || [];

  // Public endpoints handled by route handlers below
  if (BUILT_IN_PUBLIC_PATHS.includes(path) || path.startsWith("/__mpp/api/")) {
    return next();
  }

  // Check if this path is protected (including /__mpp/protected)
  const protectedConfig = findProtectedRouteConfig(path, protectedPatterns);
  if (protectedConfig) {
    // Bot Management Filtering: check if request has exception (human or excepted bot)
    if (hasBotManagementException(c.req.raw, protectedConfig)) {
      if (path === "/__mpp/protected") {
        return next();
      }
      return proxyToOrigin(c.req.raw, c.env);
    }

    // Ensure required secrets are configured before processing protected routes
    if (!c.env.JWT_SECRET || !c.env.MPP_SECRET_KEY) {
      return c.json(
        {
          error:
            "Server misconfigured: JWT_SECRET or MPP_SECRET_KEY not set. See README for setup instructions.",
        },
        500,
      );
    }

    // Use the protected route middleware
    const protectedMiddleware = createProtectedRoute(protectedConfig);
    let jwtToken = "";

    const result = await protectedMiddleware(c, async () => {
      // After successful auth, check if we need to issue a cookie
      const hasExistingAuth = c.get("auth");

      if (!hasExistingAuth) {
        // This is a new payment - generate JWT cookie
        // Note: This runs after payment verification but BEFORE settlement.
        // We'll check if settlement succeeded before actually using the token.
        jwtToken = await generateJWT(c.env.JWT_SECRET, 3600);
      }

      if (path === "/__mpp/protected") {
        c.res = c.json({
          message: "Premium content accessed through MPP!",
          timestamp: Date.now(),
          note: "This endpoint always requires a Payment credential or a valid authentication cookie.",
        });
      }
    });

    // If middleware returned a response (e.g., 402), return it
    if (result) {
      return result;
    }

    // Check if the payment middleware set an error response.
    if (c.res && c.res.status >= 400) {
      return c.res;
    }

    if (path === "/__mpp/protected") {
      if (jwtToken) {
        setCookie(c, "auth_token", jwtToken, {
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
          maxAge: 3600,
          path: "/",
        });
      }

      return c.res;
    }

    // AI endpoints: serve directly via Workers AI binding
    if (AI_ENDPOINTS.includes(path) && c.env.AI) {
      const originResponse = await handleAIEndpoint(path, c.req.raw, c.env);
      if (jwtToken) {
        setCookie(c, "auth_token", jwtToken, {
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
          maxAge: 3600,
          path: "/",
        });
        const newResponse = new Response(originResponse.body, {
          status: originResponse.status,
          headers: new Headers(originResponse.headers),
        });
        const setCookieHeaders = c.res.headers.getSetCookie();
        for (const cookie of setCookieHeaders) {
          newResponse.headers.append("Set-Cookie", cookie);
        }
        const paymentReceipt = c.res.headers.get("Payment-Receipt");
        if (paymentReceipt) {
          newResponse.headers.set("Payment-Receipt", paymentReceipt);
        }
        return newResponse;
      }
      return originResponse;
    }

    // Proxy the authenticated request to origin
    const originResponse = await proxyToOrigin(c.req.raw, c.env);
    const paymentReceipt = c.res.headers.get("Payment-Receipt");

    // If we generated a JWT token or receipt header, clone the origin response
    if (jwtToken || paymentReceipt) {
      // Use Hono's setCookie to generate the proper Set-Cookie header
      if (jwtToken) {
        setCookie(c, "auth_token", jwtToken, {
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
          maxAge: 3600,
          path: "/",
        });
      }

      // Clone the origin response and add our cookie header
      const newResponse = new Response(originResponse.body, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers: new Headers(originResponse.headers),
      });

      // Copy Set-Cookie headers from Hono context to our response
      // Use getSetCookie() to properly handle multiple Set-Cookie headers
      const setCookieHeaders = c.res.headers.getSetCookie();
      for (const cookie of setCookieHeaders) {
        newResponse.headers.append("Set-Cookie", cookie);
      }

      if (paymentReceipt) {
        newResponse.headers.set("Payment-Receipt", paymentReceipt);
      }

      return newResponse;
    }

    // Otherwise, return origin response as-is
    return originResponse;
  }

  // Proxy unprotected routes directly to origin
  return proxyToOrigin(c.req.raw, c.env);
});

/**
 * Built-in test endpoint - always public, never requires payment
 * Used for health checks and testing proxy functionality
 */
app.get("/__mpp/health", (c) => {
  return c.json({
    status: "ok",
    proxy: "mpp-proxy",
    paymentMethod: "tempo",
    message: "This endpoint is always public",
    timestamp: Date.now(),
  });
});

/**
 * Config status endpoint - shows current configuration (no secrets exposed)
 * Useful for debugging and verifying deployment
 */
app.get("/__mpp/config", (c) => {
  const patterns = (c.env.PROTECTED_PATTERNS || []) as ProtectedRouteConfig[];
  const botFilteringEnabled = patterns.some(
    (p) => p.bot_score_threshold !== undefined,
  );

  return c.json({
    paymentScheme: "Payment",
    paymentMethod: "tempo",
    tempoTestnet: c.env.TEMPO_TESTNET,
    paymentCurrency: c.env.PAYMENT_CURRENCY,
    payTo: c.env.PAY_TO ? `***${c.env.PAY_TO.slice(-6)}` : null,
    hasOriginUrl: !!c.env.ORIGIN_URL,
    hasOriginService: !!c.env.ORIGIN_SERVICE,
    protectedPatterns: patterns.map((p) => ({
      pattern: p.pattern,
      amount: p.amount,
      botManagementFiltering:
        p.bot_score_threshold !== undefined
          ? {
              threshold: p.bot_score_threshold,
              exceptionsCount: p.except_detection_ids?.length ?? 0,
            }
          : null,
    })),
    botManagementFiltering: botFilteringEnabled,
  });
});

/** Handle AI endpoints directly via Workers AI binding */
async function handleAIEndpoint(path: string, request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;

    if (path === "/api/chat") {
      const messages = body.messages as Array<{ role: string; content: string }>;
      const model = (body.model as string) || "@cf/meta/llama-3.1-8b-instruct";
      const result = await env.AI.run(model as keyof AiModels, { messages } as never);
      return Response.json(result);
    }

    if (path === "/api/embeddings") {
      const text = body.text as string | string[];
      const model = (body.model as string) || "@cf/baai/bge-base-en-v1.5";
      const result = await env.AI.run(model as keyof AiModels, { text: Array.isArray(text) ? text : [text] } as never);
      return Response.json(result);
    }

    return new Response("Not found", { status: 404 });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export default app;
