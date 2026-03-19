# Testing Guide

## Prerequisites

1. The Worker running locally: `npm run dev`
2. A Tempo test wallet private key (for payment tests)
3. Test tokens in that wallet (for payment tests)

## 1. Pricing engine (no wallet needed)

```bash
# Health check
curl http://localhost:8787/__mpp/health

# Current prices
curl http://localhost:8787/__mpp/api/prices

# Full status (demand, tier, config)
curl http://localhost:8787/__mpp/api/status

# Trigger 402 on AI endpoint
curl -i -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'

# Surge test — flood requests and watch price climb
for i in {1..50}; do
  curl -s -o /dev/null -X POST http://localhost:8787/api/chat \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"x"}]}'
done

# Check surged prices
curl http://localhost:8787/__mpp/api/prices
# Price should be above $0.001 now

# Wait 60s, prices decay back to base
sleep 65
curl http://localhost:8787/__mpp/api/prices
```

## 2. Automated payment test (wallet required)

```bash
PRIVATE_KEY=0x... npm run test:client
```

The script:
1. Shows current dynamic prices for all routes
2. Requests `/api/chat` and confirms `402 Payment Required`
3. Uses `mppx/client` with Tempo to complete payment at the surge price
4. Verifies `Payment-Receipt` is returned
5. Shows the AI response (if Workers AI is available)
6. Reuses the JWT `auth_token` cookie without paying again

### Environment variables

| Variable | Required | Default |
|----------|----------|---------|
| `PRIVATE_KEY` | Yes | — |
| `SERVER_URL` | No | `http://localhost:8787` |
| `TARGET_PATH` | No | `/api/chat` |

### Against deployed Worker

```bash
PRIVATE_KEY=0x... SERVER_URL=https://mpp-dynamic-pricing.0x471.workers.dev npm run test:client
```

## 3. Manual payment with Tempo CLI

```bash
curl -fsSL tempo.xyz/install | bash
tempo wallet login

# Pay for AI chat completion
tempo request -X POST https://mpp-dynamic-pricing.0x471.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the meaning of life?"}]}'
```

## Notes

- `TEMPO_TESTNET` is `true` in the default config — use testnet tokens
- Prices reset to base after 60s of no traffic (sliding window clears)
- Workers AI requires remote mode — it won't produce completions in `--local` mode
- Never test with a wallet that holds real funds
