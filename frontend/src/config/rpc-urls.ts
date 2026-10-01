/**
 * Browser-side EVM RPC URLs (MetaMask / wallet reads).
 *
 * Set either the full URL (VITE_SEPOLIA_RPC_URL) or VITE_INFURA_API_KEY.
 * Infura keys in the frontend are visible in the bundle — that is normal for
 * wallet RPC endpoints; restrict the key by HTTP referrer in the Infura dashboard.
 */

const INFURA_SEPOLIA = 'https://sepolia.infura.io/v3';
const INFURA_MAINNET = 'https://mainnet.infura.io/v3';
const PUBLIC_SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com';
const PUBLIC_MAINNET = 'https://ethereum-rpc.publicnode.com';

type ImportMetaEnv = ImportMeta & {
  env?: Record<string, string | undefined>;
};

function env(key: string): string | undefined {
  return (import.meta as ImportMetaEnv).env?.[key]?.trim() || undefined;
}

export type EvmNetworkMode = 'testnet' | 'mainnet';

/**
 * Network-segment keywords that imply a specific Ethereum network.
 */
const TESTNET_SEGMENTS = ['sepolia', 'goerli', 'holesky', 'testnet'];
const MAINNET_SEGMENTS = ['mainnet'];

/**
 * Validate an EVM RPC URL against basic security and network-agreement rules.
 *
 * Throws if:
 *  - The URL contains userinfo (credentials embedded in the URL).
 *    The error message NEVER includes the password.
 *  - The host is empty.
 *  - A network-identifying segment in the hostname contradicts
 *    `expectedNetwork`.
 *
 * A URL without a network-identifying segment passes the network-agreement
 * check (plain IP / custom domain with no network hint).
 */
export function validateRpcUrl(url: string, expectedNetwork: EvmNetworkMode): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid RPC URL: cannot be parsed as a URL`);
  }

  // Reject embedded credentials — never reveal the password in the error.
  if (parsed.username || parsed.password) {
    throw new Error(
      `RPC URL must not contain credentials (userinfo detected for user "${parsed.username}")`
    );
  }

  // Reject empty host.
  if (!parsed.hostname) {
    throw new Error(`RPC URL has an empty host`);
  }

  // Check network-segment agreement.
  const host = parsed.hostname.toLowerCase();
  const hasTestnetSegment = TESTNET_SEGMENTS.some((seg) => host.includes(seg));
  const hasMainnetSegment = MAINNET_SEGMENTS.some((seg) => host.includes(seg));

  if (expectedNetwork === 'testnet' && hasMainnetSegment && !hasTestnetSegment) {
    throw new Error(
      `RPC URL hostname "${parsed.hostname}" looks like a mainnet endpoint but the app is configured for testnet`
    );
  }

  if (expectedNetwork === 'mainnet' && hasTestnetSegment) {
    throw new Error(
      `RPC URL hostname "${parsed.hostname}" looks like a testnet endpoint but the app is configured for mainnet`
    );
  }
}

export function resolveViteSepoliaRpcUrl(): string {
  const url =
    env('VITE_SEPOLIA_RPC_URL') ||
    (env('VITE_INFURA_API_KEY') ? `${INFURA_SEPOLIA}/${env('VITE_INFURA_API_KEY')}` : '') ||
    PUBLIC_SEPOLIA;
  validateRpcUrl(url, 'testnet');
  return url;
}

export function resolveViteMainnetRpcUrl(): string {
  const url =
    env('VITE_MAINNET_RPC_URL') ||
    (env('VITE_INFURA_API_KEY') ? `${INFURA_MAINNET}/${env('VITE_INFURA_API_KEY')}` : '') ||
    PUBLIC_MAINNET;
  validateRpcUrl(url, 'mainnet');
  return url;
}
