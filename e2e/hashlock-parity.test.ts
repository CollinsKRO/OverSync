import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { hashOrderPreimage } from "@oversync/sdk/secrets";
import { SorobanHtlcSim } from "./sim.js";
import { startEvmFixture } from "./evm-fixture.js";
import { runParityCheck } from "./hashlock-parity.js";

const vectorLine = readFileSync(
  fileURLToPath(new URL("./fixtures/hashlock-v1.tsv", import.meta.url)),
  "utf8"
).split("\n").find((line) => line && !line.startsWith("#"))!;
const [vectorOrderId, vectorPreimage, vectorHashlock] = vectorLine.split("\t") as [
  string,
  `0x${string}`,
  `0x${string}`
];

describe("hashlock parity check", () => {
  it("matches the canonical shared order-bound hashlock vector", () => {
    const orderId = BigInt(vectorOrderId);
    const proof = runParityCheck(vectorPreimage, orderId);

    expect(proof.hashlock).toBe(vectorHashlock);
    expect(hashOrderPreimage(orderId + 1n, vectorPreimage)).not.toBe(vectorHashlock);
  });

  it("accepts matching preimages and rejects mutations and other-order preimages on both local sides", async () => {
    const evm = await startEvmFixture();
    const soroban = new SorobanHtlcSim();
    const orderId = BigInt(vectorOrderId);
    const proof = runParityCheck(vectorPreimage, orderId);
    const changedBytes = Buffer.from(vectorPreimage.slice(2), "hex");
    changedBytes[changedBytes.length - 1] ^= 1;
    const changedPreimage = `0x${changedBytes.toString("hex")}` as `0x${string}`;

    try {
      const evmOrderId = await evm.nextOrderId();
      const sorobanOrderId = soroban.nextOrderId();
      expect(evmOrderId).toBe(orderId);
      expect(sorobanOrderId).toBe(orderId);
      await evm.createOrder(proof.hashlock, 600);
      soroban.createOrder({ hashlock: proof.hashlock, timelockSeconds: 600 });

      expect(await evm.claimOrderExpectRevert(evmOrderId, changedPreimage)).toMatch(/InvalidPreimage/);
      expect(() => soroban.claimOrder(sorobanOrderId, changedPreimage)).toThrow(/InvalidPreimage/);
      await evm.claimOrder(evmOrderId, vectorPreimage);
      soroban.claimOrder(sorobanOrderId, vectorPreimage);
      expect(await evm.getOrderStatus(evmOrderId)).toBe("Claimed");
      expect(soroban.getOrder(sorobanOrderId).status).toBe("Claimed");

      const otherPreimage = `0x${"02".repeat(32)}` as `0x${string}`;
      const nextEvmId = await evm.nextOrderId();
      const nextSorobanId = soroban.nextOrderId();
      const otherHashlock = hashOrderPreimage(nextEvmId, otherPreimage);
      expect(nextEvmId).toBe(nextSorobanId);
      await evm.createOrder(otherHashlock, 600);
      soroban.createOrder({ hashlock: otherHashlock, timelockSeconds: 600 });

      expect(await evm.claimOrderExpectRevert(nextEvmId, vectorPreimage)).toMatch(/InvalidPreimage/);
      expect(() => soroban.claimOrder(nextSorobanId, vectorPreimage)).toThrow(/InvalidPreimage/);
      await evm.claimOrder(nextEvmId, otherPreimage);
      soroban.claimOrder(nextSorobanId, otherPreimage);
    } finally {
      await evm.stop();
    }
  }, 60_000);

  it("is deterministic for a given order and preimage", () => {
    const first = runParityCheck(vectorPreimage, BigInt(vectorOrderId));
    const second = runParityCheck(vectorPreimage, BigInt(vectorOrderId));
    expect(first.hashlock).toBe(second.hashlock);
  });
});
