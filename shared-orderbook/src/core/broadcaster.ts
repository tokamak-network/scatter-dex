import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { BroadcastEvent } from "@scatter-dex/types";

export type { BroadcastEvent } from "@scatter-dex/types";

/**
 * WebSocket broadcaster — pushes real-time events to connected relayers.
 *
 * Steam analogy: when a new item is listed on CSGOFloat, all watching
 * bots receive a real-time notification. Same here — relayers subscribe
 * and receive new order summaries as they arrive.
 */
export class OrderBroadcaster {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: "/ws/orders" });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      console.log(`WS client connected (total: ${this.clients.size})`);

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log(`WS client disconnected (total: ${this.clients.size})`);
      });

      ws.on("error", () => {
        this.clients.delete(ws);
      });

      // Ping-pong keepalive
      ws.on("pong", () => {
        (ws as WebSocket & { isAlive: boolean }).isAlive = true;
      });
      (ws as WebSocket & { isAlive: boolean }).isAlive = true;
    });

    // Periodic ping to detect dead connections
    const pingInterval = setInterval(() => {
      for (const ws of this.clients) {
        const client = ws as WebSocket & { isAlive: boolean };
        if (!client.isAlive) {
          client.terminate();
          this.clients.delete(ws);
          continue;
        }
        client.isAlive = false;
        ws.ping();
      }
    }, 30_000);

    this.wss.on("close", () => clearInterval(pingInterval));
  }

  broadcast(event: BroadcastEvent): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, (err) => {
          if (err) console.warn("WS send failed:", err.message);
        });
      }
    }
  }

  close(): void {
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    this.wss?.close();
  }
}
