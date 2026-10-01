import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { httpRequestDuration, ordersTotal, registry } from "../src/metrics.js";

const preimage = "super_secret_htlc_preimage_256_bits_of_entropy_do_not_share";
const hexPreimage = `0x${"ab".repeat(32)}`;
const rpcUrl = "https://admin:RpcT0kenz!@eth-mainnet.internal.example/v3/private";
const authorization = "Bearer eyJhbGciOiJIUzI1Ni.SensitivePayload.Signature";

describe("coordinator observability redaction", () => {
  it("redacts an error log while retaining order id and status", () => {
    let output = "";
    const log = createLogger("info", { write(chunk) { output += chunk; } });

    log.error({
      orderId: "order-291",
      status: "failed",
      preimage,
      authorization,
      rpcUrl,
      err: new Error(`RPC failed for preimage=${preimage}; ${hexPreimage}; Authorization: ${authorization}; ${rpcUrl}`)
    }, "order failed");

    expect(output).not.toContain(preimage);
    expect(output).not.toContain(hexPreimage);
    expect(output).not.toContain("RpcT0kenz!");
    expect(output).not.toContain("SensitivePayload");
    expect(JSON.parse(output)).toMatchObject({
      orderId: "order-291",
      status: "failed",
      msg: "order failed"
    });
  });

  it("redacts the same fixture from metric label values while retaining metric names and status", async () => {
    ordersTotal.inc({ status: "failed" });
    httpRequestDuration.observe({
      method: "GET",
      route: `/orders/${preimage}/${hexPreimage}?rpc=${rpcUrl}&authorization=${authorization}`,
      status_code: "500"
    }, 0.1);

    const output = await registry.metrics();
    expect(output).not.toContain(preimage);
    expect(output).not.toContain(hexPreimage);
    expect(output).not.toContain("RpcT0kenz!");
    expect(output).not.toContain("SensitivePayload");
    expect(output).toContain('coordinator_orders_total{status="failed"}');
    expect(output).toContain("coordinator_http_request_duration_seconds_bucket");
  });
});
