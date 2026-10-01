import { describe, it, expect } from 'vitest';
import {
  validateRpcUrl,
  resolveEthereumRpcUrl,
  infuraRpcUrl,
} from './ethereum-rpc-url.js';

// ---------------------------------------------------------------------------
// validateRpcUrl — unit tests covering all acceptance criteria
// ---------------------------------------------------------------------------

describe('validateRpcUrl (resolver)', () => {
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

  // AC1: neutral hostname with no network segment passes both modes
  it('accepts a neutral hostname (no network segment) in testnet mode', () => {
    expect(() =>
      validateRpcUrl('https://eth-node.example.com/rpc', 'testnet')
    ).not.toThrow();
  });

  it('accepts a neutral hostname (no network segment) in mainnet mode', () => {
    expect(() =>
      validateRpcUrl('https://eth-node.example.com/rpc', 'mainnet')
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
// resolveEthereumRpcUrl — integration: validation is called during resolution
// ---------------------------------------------------------------------------

describe('resolveEthereumRpcUrl (resolver) — validation integration', () => {
  it('resolves and accepts a clean sepolia URL from env', () => {
    const url = resolveEthereumRpcUrl('testnet', {
      SEPOLIA_RPC_URL: 'https://sepolia.infura.io/v3/abc123',
    });
    expect(url).toBe('https://sepolia.infura.io/v3/abc123');
  });

  it('resolves and accepts a clean mainnet URL from env', () => {
    const url = resolveEthereumRpcUrl('mainnet', {
      MAINNET_RPC_URL: 'https://mainnet.infura.io/v3/abc123',
    });
    expect(url).toBe('https://mainnet.infura.io/v3/abc123');
  });

  it('throws when a credentialed URL is supplied via env', () => {
    expect(() =>
      resolveEthereumRpcUrl('testnet', {
        SEPOLIA_RPC_URL: 'https://user:pass@sepolia.infura.io/v3/abc123',
      })
    ).toThrow(/credentials/i);
  });

  it('does not expose the password when rejecting a credentialed env URL', () => {
    const password = 'mySecretKey99';
    let errorMessage = '';
    try {
      resolveEthereumRpcUrl('testnet', {
        SEPOLIA_RPC_URL: `https://user:${password}@sepolia.infura.io/v3/abc123`,
      });
    } catch (err) {
      errorMessage = (err as Error).message;
    }
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).not.toContain(password);
  });

  it('throws when a mainnet URL is supplied for a testnet resolver', () => {
    expect(() =>
      resolveEthereumRpcUrl('testnet', {
        SEPOLIA_RPC_URL: 'https://mainnet.infura.io/v3/abc123',
      })
    ).toThrow(/mainnet.*testnet|testnet.*mainnet/i);
  });

  it('throws when a testnet URL is supplied for a mainnet resolver', () => {
    expect(() =>
      resolveEthereumRpcUrl('mainnet', {
        MAINNET_RPC_URL: 'https://sepolia.infura.io/v3/abc123',
      })
    ).toThrow(/testnet.*mainnet|mainnet.*testnet/i);
  });
});

// ---------------------------------------------------------------------------
// infuraRpcUrl helper
// ---------------------------------------------------------------------------

describe('infuraRpcUrl (resolver)', () => {
  it('builds a valid sepolia infura URL', () => {
    expect(infuraRpcUrl('testnet', 'mykey')).toBe(
      'https://sepolia.infura.io/v3/mykey'
    );
  });

  it('builds a valid mainnet infura URL', () => {
    expect(infuraRpcUrl('mainnet', 'mykey')).toBe(
      'https://mainnet.infura.io/v3/mykey'
    );
  });
});
