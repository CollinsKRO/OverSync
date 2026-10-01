import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import { redactSensitive } from "./redaction.js";

class RedactingRegistry extends Registry {
  override async metrics(): Promise<string> {
    return redactSensitive(await super.metrics());
  }
}

export const registry = new RedactingRegistry();

collectDefaultMetrics({ register: registry, prefix: "coordinator_" });

/** Total orders by status label */
export const ordersTotal = new Counter({
  name: "coordinator_orders_total",
  help: "Total number of orders by status",
  labelNames: ["status"] as const,
  registers: [registry]
});

/**
 * Illegal / refused order transitions, labelled with the stable failure
 * code from the order state machine. A non-zero rate here means a chain
 * listener or a client tried to skip, repeat or rewind a lifecycle step.
 */
export const illegalOrderTransitions = new Counter({
  name: "coordinator_illegal_order_transitions_total",
  help: "Total refused order transitions by stable failure code",
  labelNames: ["code"] as const,
  registers: [registry]
});

/** Last block number seen by each listener */
export const listenerLastBlock = new Gauge({
  name: "coordinator_listener_last_block",
  help: "Most recent block processed by each chain listener",
  labelNames: ["chain"] as const,
  registers: [registry]
});

/** HTTP request duration histogram */
export const httpRequestDuration = new Histogram({
  name: "coordinator_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry]
});
