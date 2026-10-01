/**
 * Tests for the frontend RPC URL validation helper.
 *
 * NOTE on resolveViteSepoliaRpcUrl / resolveViteMainnetRpcUrl:
 * These functions read from `import.meta.env` which Vite resolves statically
 * at build-time. In the Vitest jsdom environment, no VITE_* env vars are
 * injected, so the resolvers always return the public fallback URLs.  The
 * integration of validateRpcUrl into those resolvers is exercised by testing
 * validateRpcUrl directly below, and by a smoke test that confirms the public
 * fallback URLs themselves pass validation.
 */

import { describe, it, expect } from 'vitest';
import {
  validateRpcUrl,
  resolveViteSepoliaRpcUrl,
  resolveViteMainnetRpcUrl,
} from './rpc-urls';

// ---------------------------------------------------------------------------
// validateRpcUrl — unit tests covering all acceptance criteria
// ---------------------------------------------------------------------------

describe('validateRpcUrl (frontend)', () => {
  // AC1: clean testnet URL is accepted
  it('accepts a clean testnet URL', () => {
    expect(() =>
      validateRpcUrl('https://sepolia.infura.io/v3/abc123', 'testnet')
    ).not.toThrow();
  });

  // AC1: clean mainnet URL is accepted
  it('accepts a clean mainnet URL', () => {
    expect(() =>
      validateRpcUrl('https://mainnet.infura.io/v3/abc123', 'mainnet')
    ).not.toThrow();
  });

  // AC1: public fallback URLs (no network segment) are always accepted
  it('accepts the public sepolia fallback URL for testnet mode', () => {
    expect(() =>
      validateRpcUrl('https://ethereum-sepolia-rpc.publicnode.com', 'testnet')
    ).not.toThrow();
  });

  it('accepts the public mainnet fallback URL for mainnet mode', () => {
    expect(() =>
      validateRpcUrl('https://ethereum-rpc.publicnode.com', 'mainnet')
    ).not.toThrow();
  });

  // AC1: neutral hostname (no network segment) passes both modes
  it('accepts a neutral hostname in testnet mode', () => {
    expect(() =>
      validateRpcUrl('https://my-rpc-node.example.com/rpc', 'testnet')
    ).not.toThrow();
  });

  it('accepts a neutral hostname in mainnet mode', () => {
    expect(() =>
      validateRpcUrl('https://my-rpc-node.example.com/rpc', 'mainnet')
    ).not.toThrow();
  });

  // AC2: URL with userinfo is rejected
  it('rejects a URL with username only', () => {
    expect(() =>
      validateRpcUrl('https://user@sepolia.infura.io/v3/abc123', 'testnet')
    ).toThrow(/credentials/i);
  });

  it('rejects a URL with username and password', () => {
    expect(() =>
      validateRpcUrl('https://user:s3cr3t@sepolia.infura.io/v3/abc123', 'testnet')
    ).toThrow(/credentials/i);
  });

  // AC4: error must NOT contain the password
  it('does not expose the password in the error message', () => {
    const password = 's3cr3tPassw0rd';
    let errorMessage = '';
    try {
      validateRpcUrl(
        `https://user:${password}@mainnet.infura.io/v3/abc123`,
        'mainnet'
      );
    } catch (err) {
      errorMessage = (err as Error).message;
    }
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).not.toContain(password);
  });

  // Empty host
  it('rejects a URL with an empty host', () => {
    expect(() => validateRpcUrl('file:///etc/rpc', 'testnet')).toThrow(/empty host/i);
  });

  // AC3: mainnet URL in a testnet config is rejected
  it('rejects a mainnet hostname when configured for testnet', () => {
    expect(() =>
      validateRpcUrl('https://mainnet.infura.io/v3/abc123', 'testnet')
    ).toThrow(/mainnet.*testnet|testnet.*mainnet/i);
  });

  // AC3: testnet URL in a mainnet config is rejected
  it('rejects a sepolia hostname when configured for mainnet', () => {
    expect(() =>
      validateRpcUrl('https://sepolia.infura.io/v3/abc123', 'mainnet')
    ).toThrow(/testnet.*mainnet|mainnet.*testnet/i);
  });

  it('rejects a goerli hostname when configured for mainnet', () => {
    expect(() =>
      validateRpcUrl('https://goerli.infura.io/v3/abc123', 'mainnet')
    ).toThrow(/testnet.*mainnet|mainnet.*testnet/i);
  });

  it('rejects a holesky hostname when configured for mainnet', () => {
    expect(() =>
      validateRpcUrl('https://holesky.infura.io/v3/abc123', 'mainnet')
    ).toThrow(/testnet.*mainnet|mainnet.*testnet/i);
  });
});

// ---------------------------------------------------------------------------
// resolveViteSepoliaRpcUrl / resolveViteMainnetRpcUrl
// Smoke-test: confirm the no-env default (public fallback) passes validation.
// (import.meta.env is statically resolved by Vite; vi.stubEnv affects
// process.env not import.meta.env, so env-override scenarios are covered
// by the validateRpcUrl unit tests above.)
// ---------------------------------------------------------------------------

describe('resolveViteSepoliaRpcUrl (frontend) — default passes validation', () => {
  it('returns a URL that passes testnet validation when no VITE_* vars are set', () => {
    // In the test environment, import.meta.env has no VITE_SEPOLIA_RPC_URL,
    // so the public fallback is used.  Confirm it does not throw.
    const url = resolveViteSepoliaRpcUrl();
    expect(() => validateRpcUrl(url, 'testnet')).not.toThrow();
  });

  it('returns the public sepolia fallback when no VITE_* vars are set', () => {
    const url = resolveViteSepoliaRpcUrl();
    expect(url).toBe('https://ethereum-sepolia-rpc.publicnode.com');
  });
});

describe('resolveViteMainnetRpcUrl (frontend) — default passes validation', () => {
  it('returns a URL that passes mainnet validation when no VITE_* vars are set', () => {
    const url = resolveViteMainnetRpcUrl();
    expect(() => validateRpcUrl(url, 'mainnet')).not.toThrow();
  });

  it('returns the public mainnet fallback when no VITE_* vars are set', () => {
    const url = resolveViteMainnetRpcUrl();
    expect(url).toBe('https://ethereum-rpc.publicnode.com');
  });
});
