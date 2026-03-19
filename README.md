# MPP Dynamic Pricing Proxy

**[Live](https://mpp-dynamic-pricing.0x471.workers.dev)** | Fork of [cloudflare/mpp-proxy](https://github.com/cloudflare/mpp-proxy)

A Cloudflare Worker that gates AI model inference behind MPP payments with real-time demand-based surge pricing. Built for the [Tempo Hackathon](https://hackathon.tempo.xyz/).

## What this fork adds

The upstream [mpp-proxy](https://github.com/cloudflare/mpp-proxy) is a generic payment-gated reverse proxy with static prices. This fork adds:

- **Dynamic surge pricing engine** — A Durable Object tracks demand per route with a 60-second sliding window, 5-tier piecewise pricing curve, and EMA smoothing. Prices rise automatically under load.
- **Workers AI endpoints** — `/api/chat` and `/api/embeddings` serve LLM inference and text embeddings directly via the Workers AI binding (Llama, Mistral, BGE). No external API keys needed.
- **Pricing API** — `/__mpp/api/prices`, `/__mpp/api/status`, and WebSocket streaming for live price monitoring.
- **Simulator dashboard** — The landing page at `/` is a Svelte visualization with traffic scenarios, real-time charts, and revenue analysis.

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/chat` | MPP (402) | AI chat completion — dynamic surge pricing |
| `POST /api/embeddings` | MPP (402) | Text embeddings — separate pricing tier |
| `GET /__mpp/api/prices` | Public | Current prices for all protected routes |
| `GET /__mpp/api/status` | Public | Demand, tier, config per route |
| `GET /__mpp/api/ws/:pattern` | Public | WebSocket live pricing stream |
| `GET /__mpp/health` | Public | Health check |
| `GET /__mpp/config` | Public | Runtime config |
| `GET /` | Public | Simulator dashboard |

## Quick start

```bash
npm install

# Local secrets
echo "JWT_SECRET=$(openssl rand -hex 32)" > .dev.vars
echo "MPP_SECRET_KEY=$(openssl rand -hex 32)" >> .dev.vars

# Start dev server (DOs work locally via Miniflare)
npm run dev
```

### Test it

```bash
# Health
curl http://localhost:8787/__mpp/health

# Dynamic prices
curl http://localhost:8787/__mpp/api/prices

# Trigger 402 with surge price
curl -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'

# Flood and watch prices surge
for i in {1..50}; do
  curl -s -o /dev/null -X POST http://localhost:8787/api/chat \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"x"}]}'
done
curl http://localhost:8787/__mpp/api/prices

# Full MPP payment flow (needs funded Tempo wallet)
PRIVATE_KEY=0x... npm run test:client
```

## Deploy

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put MPP_SECRET_KEY
npx wrangler secret put JWT_SECRET
```

## Configuration

### wrangler.jsonc

Protected routes with dynamic pricing are defined in `PROTECTED_PATTERNS`:

```jsonc
"PROTECTED_PATTERNS": [
  {
    "pattern": "/api/chat",
    "amount": "0.01",
    "description": "AI chat completion",
    "pricing": {
      "basePrice": "0.001",
      "minPrice": "0.001",
      "maxPrice": "0.10",
      "windowSizeMs": 60000,
      "surgeThreshold": 10,
      "surgeMultiplierMax": 10
    }
  }
]
```

### Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `PRICING_ENGINE` | Durable Object | Per-route pricing state |
| `AI` | Workers AI | LLM inference (Llama, Mistral, BGE) |

### Required vars

| Variable | Description |
|----------|-------------|
| `PAY_TO` | Recipient wallet address |
| `PAYMENT_CURRENCY` | Token address (USDC) |
| `TEMPO_TESTNET` | `true` for testnet |
| `PROTECTED_PATTERNS` | Routes, amounts, and pricing config |

### Required secrets

| Secret | Description |
|--------|-------------|
| `JWT_SECRET` | Signs the 1-hour auth cookie |
| `MPP_SECRET_KEY` | Signs MPP payment challenges |

## Project structure

```
src/
├── index.ts              # Hono app, routing, AI handlers, CORS
├── auth.ts               # MPP payment middleware + surge pricing integration
├── env.ts                # Environment and type definitions
├── jwt.ts                # JWT utilities
├── pricing/
│   ├── config.ts         # Tier config and defaults
│   ├── pricing-engine.ts # Core: sliding window, tiers, EMA smoothing
│   └── engine.ts         # Durable Object wrapper + WebSocket broadcast
├── api/
│   └── routes.ts         # /__mpp/api/* pricing endpoints
└── bot-management/       # Optional Bot Management filtering (from upstream)
public/                   # Simulator dashboard (built Svelte app)
wrangler.jsonc            # Worker config
test-client.ts            # End-to-end MPP payment test
```

## How pricing works

1. Each request to a protected route is recorded in the route's Durable Object
2. A sliding window (60s, 1s buckets) counts recent demand
3. Demand maps to a 5-tier piecewise curve with linear interpolation
4. EMA smoothing prevents price jitter from short bursts
5. The surged price is used in the 402 payment challenge
6. After payment, Workers AI runs the model and returns the response

| Tier | Threshold | Multiplier |
|------|----------:|----------:|
| Base | 0 | 1.0x |
| Normal | 50 | 1.5x |
| Elevated | 200 | 2.5x |
| High | 1,000 | 5.0x |
| Surge | 5,000 | 10.0x |

## Upstream

This is a fork of [cloudflare/mpp-proxy](https://github.com/cloudflare/mpp-proxy). All upstream features (DNS/external/service-binding proxy modes, bot management, cookie auth) are preserved.

Built by [trionlabs](https://trionlabs.dev) for the [Tempo Hackathon](https://hackathon.tempo.xyz/).
