import { describe, it, expect } from "vitest";
import {
  ACTION_TARGET_STATUS,
  ORDER_EDGES,
  ORDER_FAILURE_CODES,
  ORDER_STATUSES,
  TRANSITIONS,
  actionForStatus,
  canTransition,
  classifyIllegalTransition,
  describeTransitionFailure,
  evaluateTransition,
  isTerminal,
  isStaleTransition,
  legalSourcesFor
} from "../src/state-machine/order-machine.js";
import type { OrderStatus } from "../src/persistence/orders-repo.js";

/**
 * The legal edges, written out by hand. This is the contract the rest of the
 * coordinator relies on: escrow, secret relay, secret, claim and refund, plus
 * the two terminal-ish edges (`failed`, `expired`).
 */
const LEGAL_EDGES: Array<[OrderStatus, OrderStatus]> = [
  ["announced", "src_locked"],
  ["announced", "failed"],
  ["announced", "expired"],
  ["src_locked", "dst_locked"],
  ["src_locked", "secret_revealed"],
  ["src_locked", "refunded"],
  ["src_locked", "failed"],
  ["src_locked", "expired"],
  ["dst_locked", "secret_revealed"],
  ["dst_locked", "refunded"],
  ["dst_locked", "failed"],
  ["dst_locked", "expired"],
  ["secret_revealed", "completed"],
  ["secret_revealed", "refunded"],
  ["secret_revealed", "failed"],
  ["expired", "refunded"],
  ["expired", "failed"]
];

const LEGAL = new Set(LEGAL_EDGES.map(([from, to]) => `${from}->${to}`));

describe("order state machine — legal edges", () => {
  it("accepts every legal edge and rejects every other pair", () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const expected = LEGAL.has(`${from}->${to}`);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
        expect(TRANSITIONS[from].includes(to), `${from} -> ${to} (table)`).toBe(expected);
      }
    }
  });

  it("derives TRANSITIONS from ORDER_EDGES without drift", () => {
    const derived: Record<string, string[]> = {};
    for (const status of ORDER_STATUSES) derived[status] = [];
    for (const edge of ORDER_EDGES) {
      for (const from of edge.from) derived[from]!.push(edge.to);
    }
    expect(TRANSITIONS).toEqual(derived);
  });

  it("keeps terminal states terminal", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("refunded")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("secret_revealed")).toBe(false);
  });

  it("maps every action to its target status and back", () => {
    expect(ACTION_TARGET_STATUS).toEqual({
      escrow: "src_locked",
      secret_relay: "dst_locked",
      secret: "secret_revealed",
      claim: "completed",
      refund: "refunded",
      fail: "failed",
      expire: "expired"
    });
    expect(actionForStatus("src_locked")).toBe("escrow");
    expect(actionForStatus("dst_locked")).toBe("secret_relay");
    expect(actionForStatus("secret_revealed")).toBe("secret");
    expect(actionForStatus("completed")).toBe("claim");
    expect(actionForStatus("refunded")).toBe("refund");
    expect(actionForStatus("announced")).toBeNull();
  });

  it("exposes the legal sources of every action", () => {
    expect(legalSourcesFor("escrow")).toEqual(["announced"]);
    expect(legalSourcesFor("secret_relay")).toEqual(["src_locked"]);
    expect(legalSourcesFor("secret")).toEqual(["src_locked", "dst_locked"]);
    expect(legalSourcesFor("claim")).toEqual(["secret_revealed"]);
    expect(legalSourcesFor("refund")).toEqual([
      "src_locked",
      "dst_locked",
      "secret_revealed",
      "expired"
    ]);
    // A refund can never follow a claim.
    expect(legalSourcesFor("refund")).not.toContain("completed");
  });
});

describe("order state machine — refusal codes", () => {
  it("classifies a secret before escrow", () => {
    expect(classifyIllegalTransition("announced", "secret_revealed")).toBe(
      ORDER_FAILURE_CODES.SECRET_BEFORE_ESCROW
    );
  });

  it("classifies a destination lock before escrow", () => {
    expect(classifyIllegalTransition("announced", "dst_locked")).toBe(
      ORDER_FAILURE_CODES.SECRET_RELAY_BEFORE_ESCROW
    );
  });

  it("classifies a claim before the secret is known", () => {
    for (const from of ["announced", "src_locked", "dst_locked"] as OrderStatus[]) {
      expect(classifyIllegalTransition(from, "completed"), `${from} -> completed`).toBe(
        ORDER_FAILURE_CODES.CLAIM_BEFORE_SECRET
      );
    }
  });

  it("classifies a refund after a claim", () => {
    expect(classifyIllegalTransition("completed", "refunded")).toBe(
      ORDER_FAILURE_CODES.REFUND_AFTER_CLAIM
    );
  });

  it("classifies late events and repeats", () => {
    expect(classifyIllegalTransition("dst_locked", "src_locked")).toBe(
      ORDER_FAILURE_CODES.LATE_STEP
    );
    expect(classifyIllegalTransition("secret_revealed", "src_locked")).toBe(
      ORDER_FAILURE_CODES.LATE_STEP
    );
    expect(classifyIllegalTransition("src_locked", "src_locked")).toBe(
      ORDER_FAILURE_CODES.REPEATED_STEP
    );
  });

  it("classifies anything else as not allowed, and never as legal", () => {
    const weird = classifyIllegalTransition("secret_revealed", "expired");
    expect(weird).toBe(ORDER_FAILURE_CODES.NOT_ALLOWED);
    // A code is only ever produced for an edge the machine refuses.
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (LEGAL.has(`${from}->${to}`)) continue;
        expect(typeof classifyIllegalTransition(from, to)).toBe("string");
      }
    }
  });

  it("never classifies a legal edge", () => {
    for (const [from, to] of LEGAL_EDGES) {
      const assessment = evaluateTransition(from, to);
      expect(assessment.allowed, `${from} -> ${to}`).toBe(true);
      expect(assessment.code, `${from} -> ${to}`).toBeNull();
    }
  });

  it("returns a code and a human reason for refused edges", () => {
    const assessment = evaluateTransition("announced", "completed", "claim");
    expect(assessment.allowed).toBe(false);
    expect(assessment.code).toBe(ORDER_FAILURE_CODES.CLAIM_BEFORE_SECRET);
    expect(assessment.reason).toMatch(/preimage has not been recorded/);
  });

  it("describes every stable code", () => {
    for (const code of Object.values(ORDER_FAILURE_CODES)) {
      const message = describeTransitionFailure(code, "announced", "completed");
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("undefined");
    }
  });

  it("keeps the failure codes stable (they are part of the HTTP contract)", () => {
    expect(ORDER_FAILURE_CODES).toEqual({
      SECRET_BEFORE_ESCROW: "illegal_transition_secret_before_escrow",
      SECRET_RELAY_BEFORE_ESCROW: "illegal_transition_secret_relay_before_escrow",
      CLAIM_BEFORE_SECRET: "illegal_transition_claim_before_secret",
      REFUND_AFTER_CLAIM: "illegal_transition_refund_after_claim",
      LATE_STEP: "illegal_transition_late_step",
      REPEATED_STEP: "illegal_transition_repeated_step",
      CONFLICTING_STEP: "illegal_transition_conflicting_step",
      ALREADY_SETTLED: "illegal_transition_already_settled",
      NOT_ALLOWED: "illegal_transition_not_allowed"
    });
  });

  it("ranks stale transitions by lifecycle order", () => {
    expect(isStaleTransition("dst_locked", "src_locked")).toBe(true);
    expect(isStaleTransition("src_locked", "dst_locked")).toBe(false);
    expect(isStaleTransition("completed", "secret_revealed")).toBe(true);
  });
});
