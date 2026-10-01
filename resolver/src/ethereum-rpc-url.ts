/**
 * @see relayer/src/ethereum-rpc-url.ts — keep in sync when changing resolution rules.
 */

export type EvmNetworkMode = 'testnet' | 'mainnet';

const INFURA_SEPOLIA = 'https://sepolia.infura.io/v3';
const INFURA_MAINNET = 'https://mainnet.infura.io/v3';
const PUBLIC_SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com';
const PUBLIC_MAINNET = 'https://ethereum-rpc.publicnode.com';

/**
 * Network-segment keywords that imply a specific Ethereum network.
 * Any hostname containing a testnet keyword is treated as testnet;
 * any hostname containing a mainnet keyword is treated as mainnet.
 */
const TESTNET_SEGMENTS = ['sepolia', 'goerli', 'holesky', 'testnet'];
const MAINNET_SEGMENTS = ['mainnet'];

/**
 * Validate an EVM RPC URL against basic security and network-agreement rules.
 *
 * Throws if:
 *  - The URL contains userinfo (credentials embedded in the URL).
 *    The error message NEVER includes the password.
 *  - The host is empty (e.g. a bare path URL).
 *  - A network-identifying segment in the hostname contradicts
 *    `expectedNetwork` (e.g. a "sepolia" hostname used in mainnet mode).
 *
 * A URL that carries no network-identifying segment passes the
 * network-agreement check (it might be a plain IP / custom domain).
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

  // Reject empty host (e.g. "file:///path" or a bare string).
  if (!parsed.hostname) {
    throw new Error(`RPC URL has an empty host`);
  }

  // Check network-segment agreement.
  const host = parsed.hostname.toLowerCase();
  const hasTestnetSegment = TESTNET_SEGMENTS.some((seg) => host.includes(seg));
  const hasMainnetSegment = MAINNET_SEGMENTS.some((seg) => host.includes(seg));

  if (expectedNetwork === 'testnet' && hasMainnetSegment && !hasTestnetSegment) {
    throw new Error(
      `RPC URL hostname "${parsed.hostname}" looks like a mainnet endpoint but the resolver is configured for testnet`
    );
  }

  if (expectedNetwork === 'mainnet' && hasTestnetSegment) {
    throw new Error(
      `RPC URL hostname "${parsed.hostname}" looks like a testnet endpoint but the resolver is configured for mainnet`
    );
  }
}

export function infuraRpcUrl(network: EvmNetworkMode, apiKey: string): string {
  const key = apiKey.trim();
  const base = network === 'mainnet' ? INFURA_MAINNET : INFURA_SEPOLIA;
  return `${base}/${key}`;
}

export function resolveEthereumRpcUrl(
  network: EvmNetworkMode,
  env: NodeJS.ProcessEnv = process.env
): string {
  const infuraKey = env.INFURA_API_KEY?.trim();

  let url: string;
  if (network === 'testnet') {
    url =
      env.SEPOLIA_RPC_URL?.trim() ||
      env.ETHEREUM_RPC_URL?.trim() ||
      (infuraKey ? infuraRpcUrl('testnet', infuraKey) : '') ||
      PUBLIC_SEPOLIA;
  } else {
    url =
      env.MAINNET_RPC_URL?.trim() ||
      env.ETHEREUM_RPC_URL?.trim() ||
      (infuraKey ? infuraRpcUrl('mainnet', infuraKey) : '') ||
      PUBLIC_MAINNET;
  }

  validateRpcUrl(url, network);
  return url;
}
