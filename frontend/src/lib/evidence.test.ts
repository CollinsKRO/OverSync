import { describe, test, expect } from 'vitest';
import {
  buildEvidenceData,
  buildPublicOrderEvidence,
  type EvidenceData,
} from './evidence';

describe('buildEvidenceData', () => {
  const data: EvidenceData = buildEvidenceData();

  test('returns canonical repo URL', () => {
    expect(data.repoUrl).toBe('https://github.com/karagozemin/OverSync');
  });

  test('contains no private RPC URLs or localhost values', () => {
    const serialized = JSON.stringify(data);

    const secrets = [
      'infura.io',
      'alchemy',
      '127.0.0.1',
      'localhost',
      '0x0000000000000000000000000000000000000000',
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ];

    for (const pattern of secrets) {
      expect(serialized).not.toContain(pattern);
    }
  });

  test('exports no orders when none are supplied', () => {
    expect(data.orders).toEqual([]);
  });
});

describe('buildPublicOrderEvidence', () => {
  // A coordinator order as serialised by
  // coordinator/src/server/routes/orders.ts. No network calls are made: the
  // fixture is a plain object, so this test never touches a live coordinator.
  const publicOrder = {
    id: 'order-public-1',
    direction: 'eth_to_xlm',
    status: 'completed',
    src: { lockTx: '0xsrc-lock-tx' },
    dst: { lockTx: '0xdst-lock-tx' },
    secret: { revealed: true, preimage: null, revealedTx: '0xsecret-reveal-tx' },
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
  };

  test('exports the documented public fields', () => {
    const evidence = buildPublicOrderEvidence(publicOrder);

    expect(evidence.orderId).toBe('order-public-1');
    expect(evidence.status).toBe('completed');
    expect(evidence.direction).toBe('eth_to_xlm');
    expect(evidence.timestamps).toEqual({
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
    });
  });

  test('includes the order id, status and transaction hashes', () => {
    const evidence = buildPublicOrderEvidence(publicOrder);

    expect(evidence.orderId).toBe('order-public-1');
    expect(evidence.status).toBe('completed');
    expect(evidence.txHashes).toEqual([
      '0xsrc-lock-tx',
      '0xdst-lock-tx',
      '0xsecret-reveal-tx',
    ]);
  });

  test('accepts a coordinator snapshot shape', () => {
    const snapshot = {
      orderId: 'order-public-2',
      currentState: 'refunded',
      transitions: ['announced', 'src_locked', 'refunded'],
      publicTxHashes: ['0xsnap-src', '0xsnap-dst'],
      timestamps: { createdAt: 10, updatedAt: 20 },
      direction: 'xlm_to_eth',
      outcomeSummary: 'Order refunded',
    };

    const evidence = buildPublicOrderEvidence(snapshot);

    expect(evidence.orderId).toBe('order-public-2');
    expect(evidence.status).toBe('refunded');
    expect(evidence.txHashes).toEqual(['0xsnap-src', '0xsnap-dst']);
    expect(evidence.outcomeSummary).toBe('Order refunded');
  });

  test('refuses an order that still contains a preimage', () => {
    const leaked = {
      ...publicOrder,
      secret: {
        revealed: true,
        preimage: 'super_secret_htlc_preimage_do_not_share',
        revealedTx: '0xsecret-reveal-tx',
      },
    };

    expect(() => buildPublicOrderEvidence(leaked)).toThrow(/preimage/);
  });

  test('refuses an order with a top-level preimage field', () => {
    const leaked = { ...publicOrder, preimage: 'super_secret_htlc_preimage' };

    expect(() => buildPublicOrderEvidence(leaked)).toThrow(/preimage/);
  });

  test('refuses an order with a hashlock or resolver field', () => {
    expect(() =>
      buildPublicOrderEvidence({ ...publicOrder, hashlock: '0xdeadbeef' }),
    ).toThrow(/hashlock/);
    expect(() =>
      buildPublicOrderEvidence({ ...publicOrder, resolver: '0xresolver' }),
    ).toThrow(/resolver/);
  });

  test('buildEvidenceData refuses a payload that still has a preimage', () => {
    const leaked = {
      ...publicOrder,
      secret: { revealed: true, preimage: 'super_secret_htlc_preimage', revealedTx: null },
    };

    expect(() => buildEvidenceData([leaked])).toThrow(/preimage/);
  });

  test('the exported evidence never contains the fixture preimage', () => {
    const fixturePreimage = 'super_secret_htlc_preimage_do_not_share';
    const data = buildEvidenceData([publicOrder]);

    expect(JSON.stringify(data)).not.toContain(fixturePreimage);
    expect(JSON.stringify(data)).not.toContain('preimage');
  });
});
