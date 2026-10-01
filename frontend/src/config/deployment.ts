/**
 * Shared deployment record.
 *
 * Single source for the escrow / registry addresses, network, and
 * bytecode hashes that both the Deployment Self-Check and the Diligence
 * Snapshot render. Built from `deployments.testnet.json` (see
 * docs/DEPLOYMENT.md). Deployer fields and anything secret are
 * deliberately not copied into this record.
 */
import deployments from '../../../deployments.testnet.json';

export interface ChainDeployment {
  escrow: string | null;
  registry: string | null;
  /** Runtime bytecode / wasm hash per contract, when the manifest records one. */
  escrowCodeHash: string | null;
  registryCodeHash: string | null;
}

export interface DeploymentRecord {
  network: string | null;
  ethereumChainId: number | null;
  ethereum: ChainDeployment;
  stellar: ChainDeployment;
}

type RawCodeHash = string | { codeHash?: string } | undefined;

interface RawChain {
  chainId?: number;
  contracts?: Record<string, string | undefined>;
  codeHashes?: Record<string, RawCodeHash>;
}

interface RawManifest {
  network?: string;
  ethereum?: RawChain;
  stellar?: RawChain;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function codeHash(value: RawCodeHash): string | null {
  return str(typeof value === 'string' ? value : value?.codeHash);
}

function chain(raw: RawChain | undefined, escrowKey: string): ChainDeployment {
  return {
    escrow: str(raw?.contracts?.[escrowKey]),
    registry: str(raw?.contracts?.ResolverRegistry),
    escrowCodeHash: codeHash(raw?.codeHashes?.[escrowKey]),
    registryCodeHash: codeHash(raw?.codeHashes?.ResolverRegistry),
  };
}

/** Build a record from a deployment manifest (same shape as deployments.testnet.json). */
export function buildDeploymentRecord(manifest: unknown): DeploymentRecord {
  const m = (manifest ?? {}) as RawManifest;
  return {
    network: str(m.network),
    ethereumChainId: typeof m.ethereum?.chainId === 'number' ? m.ethereum.chainId : null,
    ethereum: chain(m.ethereum, 'HTLCEscrow'),
    stellar: chain(m.stellar, 'HTLC'),
  };
}

/** The deployment record for the current build. */
export function getDeploymentRecord(): DeploymentRecord {
  return buildDeploymentRecord(deployments);
}

/**
 * Field paths where two records disagree (e.g. `ethereum.registry`).
 * Addresses are compared case-insensitively.
 */
export function diffDeploymentRecords(a: DeploymentRecord, b: DeploymentRecord): string[] {
  const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
  const diffs: string[] = [];
  if (norm(a.network) !== norm(b.network)) diffs.push('network');
  if (a.ethereumChainId !== b.ethereumChainId) diffs.push('ethereumChainId');
  for (const side of ['ethereum', 'stellar'] as const) {
    for (const key of ['escrow', 'registry', 'escrowCodeHash', 'registryCodeHash'] as const) {
      if (norm(a[side][key]) !== norm(b[side][key])) diffs.push(`${side}.${key}`);
    }
  }
  return diffs;
}
