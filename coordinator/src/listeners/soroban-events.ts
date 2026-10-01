import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { BridgeOrderEvent } from "./order-events.js";

/** Either an already parsed `ScVal` or its base64 XDR encoding. */
export type SorobanScVal = xdr.ScVal | string;

/**
 * The subset of `rpc.Api.EventResponse` the decoder needs. The SDK returns
 * parsed `ScVal`s; the raw RPC JSON returns base64 XDR strings, so both are
 * accepted.
 */
export interface RawSorobanEvent {
  topic: SorobanScVal[];
  value: SorobanScVal;
  txHash: string;
  ledger: number;
}

/**
 * Topic symbols published by `oversync-htlc` (see
 * `soroban/contracts/htlc/src/lib.rs`):
 *
 *   created  (sender, beneficiary, hashlock)  + (order_id, asset, amount, safety_deposit, timelock)
 *   claimed  (beneficiary, hashlock)          + (order_id, caller, preimage, amount, safety_deposit)
 *   refunded (refund_address, hashlock)       + (order_id, caller, amount, safety_deposit)
 */
const CREATED = "created";
const CLAIMED = "claimed";
const REFUNDED = "refunded";

function decodeScVal(value: SorobanScVal): unknown {
  const scVal = typeof value === "string" ? xdr.ScVal.fromXDR(value, "base64") : value;
  return scValToNative(scVal);
}

function toHex(value: unknown): string | null {
  if (value instanceof Uint8Array) return "0x" + Buffer.from(value).toString("hex");
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)) return value;
  return null;
}

function toDecimalId(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

function toUnixSeconds(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function decodeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Decode one Soroban contract event into a bridge event, or return null when
 * it is not a lifecycle event we act on. Never throws: a partially written or
 * unrelated event must not stop the listener.
 */
export function decodeSorobanOrderEvent(raw: RawSorobanEvent): BridgeOrderEvent | null {
  let topics: unknown[];
  let data: unknown[];
  try {
    topics = raw.topic.map(decodeScVal);
    data = decodeArray(decodeScVal(raw.value));
  } catch {
    return null;
  }

  const name = topics[0];
  if (typeof name !== "string") return null;

  const base = {
    chain: "stellar" as const,
    txHash: raw.txHash,
    blockNumber: raw.ledger
  };

  if (name === CREATED) {
    return {
      ...base,
      kind: "lock",
      hashlock: toHex(topics[3]),
      orderId: toDecimalId(data[0]),
      timelock: toUnixSeconds(data[4])
    };
  }

  if (name === CLAIMED) {
    return {
      ...base,
      kind: "claim",
      hashlock: toHex(topics[2]),
      orderId: toDecimalId(data[0]),
      preimage: toHex(data[2])
    };
  }

  if (name === REFUNDED) {
    return {
      ...base,
      kind: "refund",
      hashlock: toHex(topics[2]),
      orderId: toDecimalId(data[0])
    };
  }

  return null;
}
