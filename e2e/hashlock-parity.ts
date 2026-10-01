/**
 * Offline hashlock v1 commitment preview. The e2e test submits the same
 * commitment to a local EVM escrow and Soroban simulator.
 */
import { generateSecret, hashOrderPreimage, hashSecret } from "../packages/sdk/src/secrets/index.js";

export interface ParityProof {
  preimage: `0x${string}`;
  orderId: bigint;
  hashlock: `0x${string}`;
}

export function runParityCheck(preimage?: `0x${string}`, orderId = 1n): ParityProof {
  const secret = preimage ? hashSecret(preimage) : generateSecret();
  return {
    preimage: secret.preimage,
    orderId,
    hashlock: hashOrderPreimage(orderId, secret.preimage),
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url === `file://${process.argv[1]}.ts`);

if (isMain) {
  const envPreimage = process.env.PREIMAGE as `0x${string}` | undefined;
  const proof = runParityCheck(envPreimage);

  process.stdout.write(`\n${"═".repeat(58)}\n`);
  process.stdout.write(`  OverSync Cross-Chain Hashlock Parity Check\n`);
  process.stdout.write(`  (offline preview — no RPC or wallet)\n`);
  process.stdout.write(`${"═".repeat(58)}\n\n`);

  process.stdout.write(`  Secret generated:  ${envPreimage ? "supplied by caller" : "fresh demo secret"}\n\n`);

  process.stdout.write(`  Preimage     ${proof.preimage}\n`);
  process.stdout.write(`  Order ID     ${proof.orderId}\n`);
  process.stdout.write(`  Hashlock     ${proof.hashlock}\n`);
  process.stdout.write(`\n  Hashlock v1: SHA256(uint256 orderId, big-endian || preimage bytes)\n`);
  process.stdout.write(`\n`);
}
