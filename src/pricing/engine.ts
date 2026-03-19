import { DurableObject } from "cloudflare:workers";
import { PricingEngine } from "./pricing-engine";
import type { PricingConfig } from "./config";
import type { Env } from "../env";

export class PricingEngineDO extends DurableObject<Env> {
  private engine: PricingEngine;
  private lastBroadcast = 0;
  private configured = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.engine = new PricingEngine();
  }

  /** Lazily configure with per-route pricing config (idempotent) */
  private ensureConfig(config?: Partial<PricingConfig>): void {
    if (!this.configured && config) {
      this.engine = new PricingEngine(config);
      this.configured = true;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/record": {
        // Accept optional config in query param for lazy init
        const cfgParam = url.searchParams.get("config");
        if (cfgParam) {
          try {
            this.ensureConfig(JSON.parse(cfgParam) as Partial<PricingConfig>);
          } catch { /* ignore bad config */ }
        }
        this.engine.recordRequest();
        this.maybeBroadcast();
        return Response.json(this.engine.getStatus());
      }
      case "/price": {
        const price = this.engine.getCurrentPrice();
        return Response.json({
          price,
          formatted: this.engine.getFormattedPrice(),
          tier: this.engine.getTierInfo(),
        });
      }
      case "/status": {
        return Response.json(this.engine.getStatus());
      }
      case "/reset": {
        this.engine.reset();
        return Response.json({ ok: true });
      }
      case "/configure": {
        const config = (await request.json()) as Partial<PricingConfig>;
        this.engine = new PricingEngine(config);
        this.configured = true;
        return Response.json({ ok: true });
      }
      case "/ws": {
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        // Send initial status
        pair[1].send(
          JSON.stringify({
            type: "price_update",
            data: this.engine.getStatus(),
          }),
        );
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Clients don't send meaningful messages; just keep alive
  }

  webSocketClose(ws: WebSocket): void {
    ws.close();
  }

  private maybeBroadcast(): void {
    const now = Date.now();
    // Debounce: max 2 broadcasts/sec
    if (now - this.lastBroadcast < 500) return;
    this.lastBroadcast = now;

    const status = this.engine.getStatus();
    const msg = JSON.stringify({ type: "price_update", data: status });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // Client disconnected
      }
    }
  }
}
