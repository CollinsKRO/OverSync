import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FusionWebSocketServer,
  EventType,
  WS_POLICY_VIOLATION,
  allowedOriginsFromEnv,
  isSocketOriginAllowed,
  redactOutbound
} from "../src/websocket-server.js";

// No server is started: sockets are in-memory fakes, so no port is bound.

const ALLOWED = "https://app.oversync.example";
const FOREIGN = "https://evil.example";
const PREIMAGE = "0x" + "ab".repeat(32);

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private handlers = new Map<string, (...args: any[]) => void>();
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; }
  terminate() { this.readyState = 3; }
  ping() {}
  on(event: string, cb: (...args: any[]) => void) { this.handlers.set(event, cb); }
  emit(event: string, ...args: any[]) { this.handlers.get(event)?.(...args); }
}

function connect(server: FusionWebSocketServer, origin?: string) {
  const socket = new FakeSocket();
  const headers: Record<string, string> = origin ? { origin } : {};
  const client = server.handleConnection(socket as any, { headers });
  return { socket, client };
}

function subscribe(socket: FakeSocket) {
  socket.emit("message", JSON.stringify({ id: "1", method: "subscribe", params: { events: Object.values(EventType) } }));
  socket.sent.length = 0;
}

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
afterEach(() => logSpy.mockClear());

describe("FusionWebSocketServer origin policy", () => {
  it("lets an allowed origin receive an order status", () => {
    const server = new FusionWebSocketServer(0, [ALLOWED]);
    const { socket, client } = connect(server, ALLOWED);
    expect(client).not.toBeNull();
    subscribe(socket);

    server.broadcast(EventType.OrderFilled, { orderHash: "0xorder1", status: "filled" }, { orderHash: "0xorder1" });

    expect(socket.sent).toHaveLength(1);
    const msg = JSON.parse(socket.sent[0]);
    expect(msg.data).toMatchObject({ orderHash: "0xorder1", status: "filled" });
  });

  it("closes a foreign origin before any order message", () => {
    const server = new FusionWebSocketServer(0, [ALLOWED]);
    const { socket, client } = connect(server, FOREIGN);
    expect(client).toBeNull();
    expect(socket.closed?.code).toBe(WS_POLICY_VIOLATION);
    expect(server.getClientCount()).toBe(0);

    server.broadcast(EventType.OrderFilled, { orderHash: "0xorder1", status: "filled" });
    expect(socket.sent).toHaveLength(0);
  });

  it("closes a connection with no Origin header", () => {
    const server = new FusionWebSocketServer(0, [ALLOWED]);
    const { socket, client } = connect(server);
    expect(client).toBeNull();
    expect(socket.closed?.code).toBe(WS_POLICY_VIOLATION);
    expect(socket.sent).toHaveLength(0);
  });

  it("uses the coordinator CORS env vars and rejects a missing origin", () => {
    expect(allowedOriginsFromEnv({ COORDINATOR_CORS_ORIGINS: ALLOWED })).toEqual([ALLOWED]);
    expect(allowedOriginsFromEnv({})).toContain("http://localhost:5173");
    expect(isSocketOriginAllowed(undefined, ["*"])).toBe(false);
  });
});

describe("FusionWebSocketServer outbound redaction", () => {
  it("strips a fixture preimage from a broadcast but keeps order id and status", () => {
    const server = new FusionWebSocketServer(0, [ALLOWED]);
    const { socket } = connect(server, ALLOWED);
    subscribe(socket);

    server.broadcast(
      EventType.SecretShared,
      { orderHash: "0xorder2", status: "secret_revealed", secret: PREIMAGE, preimage: PREIMAGE, secretIndex: 0 },
      { orderHash: "0xorder2" }
    );

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).not.toContain(PREIMAGE);
    expect(socket.sent[0]).not.toContain("ab".repeat(32));
    expect(JSON.parse(socket.sent[0]).data).toMatchObject({ orderHash: "0xorder2", status: "secret_revealed" });
  });

  it("applies the same redaction to a direct reply (event history)", () => {
    const server = new FusionWebSocketServer(0, [ALLOWED]);
    server.broadcast(EventType.SecretShared, { orderHash: "0xorder3", status: "secret_revealed", secret: PREIMAGE });

    const { socket } = connect(server, ALLOWED);
    socket.emit("message", JSON.stringify({ id: "7", method: "getEventHistory", params: {} }));

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).not.toContain(PREIMAGE);
    const reply = JSON.parse(socket.sent[0]);
    expect(reply.result.events[0].data).toMatchObject({ orderHash: "0xorder3", status: "secret_revealed" });
  });

  it("strips RPC userinfo and authorization headers", () => {
    const out = redactOutbound({
      orderId: "ord_1",
      status: "claimed",
      rpcUrl: "https://user:s3cret@rpc.example/v2/key",
      headers: { Authorization: "Bearer tok", "content-type": "application/json" },
      nested: [{ preimage: PREIMAGE, orderId: "ord_2" }]
    });
    expect(JSON.stringify(out)).not.toMatch(/s3cret|Bearer tok|user:/);
    expect(JSON.stringify(out)).not.toContain(PREIMAGE);
    expect(out).toMatchObject({
      orderId: "ord_1",
      status: "claimed",
      rpcUrl: "https://rpc.example/v2/key",
      headers: { "content-type": "application/json" },
      nested: [{ orderId: "ord_2" }]
    });
  });
});
