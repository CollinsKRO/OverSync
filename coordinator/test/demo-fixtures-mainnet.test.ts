import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import {
  seedDemoFixtures,
  fixturesAllowedForNetwork,
  DemoFixturesMainnetError,
  MAINNET_STELLAR_PASSPHRASE,
} from "../src/persistence/demo-fixtures.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function makeLog(): Logger & { logs: Array<{ level: string; msg: string; obj?: unknown }> } {
  const logs: Array<{ level: string; msg: string; obj?: unknown }> = [];
  const record = (level: string) => (obj: unknown, msg?: string) => {
    logs.push({ level, msg: msg ?? String(obj), obj });
  };
  const log = {
    logs,
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    child: () => log,
    level: "info",
  } as unknown as Logger & { logs: typeof logs };
  return log;
}

async function freshRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), "oversync-mainnet-guard-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrdersRepository(db);
}

describe("fixturesAllowedForNetwork (#279)", () => {
  it("allows the testnet passphrase", () => {
    expect(fixturesAllowedForNetwork(TESTNET_PASSPHRASE)).toBe(true);
  });

  it("refuses the mainnet passphrase", () => {
    expect(fixturesAllowedForNetwork(MAINNET_STELLAR_PASSPHRASE)).toBe(false);
  });
});

describe("seedDemoFixtures — mainnet guard (#279)", () => {
  it("a testnet passphrase loads fixtures into the database", async () => {
    const repo = await freshRepo();
    const log = makeLog();

    await seedDemoFixtures(repo, log, TESTNET_PASSPHRASE);

    expect(await repo.countFixtures()).toBeGreaterThan(0);
  });

  it("a mainnet passphrase loads nothing and exits with a stable error", async () => {
    const repo = await freshRepo();
    const log = makeLog();

    await expect(
      seedDemoFixtures(repo, log, MAINNET_STELLAR_PASSPHRASE)
    ).rejects.toBeInstanceOf(DemoFixturesMainnetError);

    // Insert nothing: no fixture rows, no orders of any kind.
    expect(await repo.countFixtures()).toBe(0);
  });

  it("the refusal happens before any database access", async () => {
    const repo = await freshRepo();
    const log = makeLog();
    const countSpy = vi.spyOn(repo, "countFixtures");

    await expect(
      seedDemoFixtures(repo, log, MAINNET_STELLAR_PASSPHRASE)
    ).rejects.toBeInstanceOf(DemoFixturesMainnetError);

    expect(countSpy).not.toHaveBeenCalled();
  });

  it("the stable error is detectable by callers without string matching", async () => {
    const repo = await freshRepo();
    const log = makeLog();

    const outcome = await seedDemoFixtures(
      repo,
      log,
      MAINNET_STELLAR_PASSPHRASE
    ).then(
      () => "loaded" as const,
      (err: unknown) => (err instanceof DemoFixturesMainnetError ? "refused" as const : "other" as const)
    );

    expect(outcome).toBe("refused");
  });

  it("refusal logs do not contain any fixture preimage or hashlock", async () => {
    const repo = await freshRepo();
    const log = makeLog();

    await expect(
      seedDemoFixtures(repo, log, MAINNET_STELLAR_PASSPHRASE)
    ).rejects.toBeInstanceOf(DemoFixturesMainnetError);

    const serialized = JSON.stringify(log.logs).toLowerCase();
    expect(serialized).not.toContain("preimage");
    expect(serialized).not.toContain("0xf1xturepreimage");
    expect(serialized).not.toContain("0x" + "a".repeat(64));
    expect(serialized).not.toContain("hashlock");
  });

  it("successful seeding logs do not contain the fixture preimage", async () => {
    const repo = await freshRepo();
    const log = makeLog();

    await seedDemoFixtures(repo, log, TESTNET_PASSPHRASE);

    const serialized = JSON.stringify(log.logs).toLowerCase();
    expect(serialized).not.toContain("0xf1xturepreimage");
    expect(serialized).not.toContain("preimage");
  });
});
