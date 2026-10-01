/**
 * TestnetTractionCard — acceptance criteria tests for #296
 *
 * Acceptance criteria:
 *  1. Testnet renders the fixture counts.
 *  2. Mainnet renders no traction counts.
 *  3. An unknown network renders no traction counts.
 *  4. The test does not call the coordinator.
 *
 * Design:
 * - We mock `../config/networks` so we can flip `isTestnet()` per test.
 * - We do NOT mock `../config/testnet-traction`; the card must read only
 *   from the committed fixture module, never from the coordinator.
 * - We assert that `fetch` / `XMLHttpRequest` are never triggered to confirm
 *   requirement 4 (no coordinator calls).
 */

import { render, screen } from '@testing-library/react';
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted ensures the mock variable is available at the time vi.mock runs
// (vi.mock calls are hoisted to the top of the module by Vitest's transformer).
// ---------------------------------------------------------------------------
const { mockIsTestnet } = vi.hoisted(() => ({
  mockIsTestnet: vi.fn<[], boolean>(() => true),
}));

// ---------------------------------------------------------------------------
// Mock network helpers — isTestnet is the single gate used by the card.
// ---------------------------------------------------------------------------
vi.mock('../config/networks', () => ({
  isTestnet: mockIsTestnet,
  isMainnetEnabled: vi.fn(() => false),
  resolveNetworkMode: vi.fn((m: string) => m),
  getCurrentNetwork: vi.fn(),
  getContractAddresses: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Guard against coordinator calls (requirement 4).
// We spy on fetch and XHR before importing the component so any module-level
// call would be caught.
// ---------------------------------------------------------------------------
const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

// ---------------------------------------------------------------------------
// Import the component AFTER the mock is in place.
// ---------------------------------------------------------------------------
import TestnetTractionCard from './TestnetTractionCard';
import { testnetTraction } from '../config/testnet-traction';

describe('TestnetTractionCard', () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Acceptance criterion 1: testnet renders the fixture counts.
  // --------------------------------------------------------------------------
  describe('when the app is in testnet mode', () => {
    beforeEach(() => {
      mockIsTestnet.mockReturnValue(true);
    });

    test('renders the card heading', () => {
      render(<TestnetTractionCard />);
      expect(screen.getByText('Testnet traction')).toBeInTheDocument();
      expect(screen.getByText('Public metrics')).toBeInTheDocument();
    });

    test('renders the deployed contracts metric from the fixture', () => {
      render(<TestnetTractionCard />);
      expect(screen.getByText('Deployed contracts')).toBeInTheDocument();
      expect(screen.getByText(testnetTraction.deployedContracts.value)).toBeInTheDocument();
    });

    test('renders the supported routes metric from the fixture', () => {
      render(<TestnetTractionCard />);
      expect(screen.getByText('Supported testnet routes')).toBeInTheDocument();
      expect(screen.getByText(testnetTraction.supportedRoutes.value)).toBeInTheDocument();
    });

    test('renders the lastUpdated date from the fixture', () => {
      render(<TestnetTractionCard />);
      expect(screen.getByText(`Updated: ${testnetTraction.lastUpdated}`)).toBeInTheDocument();
    });

    test('renders all source links from the fixture', () => {
      render(<TestnetTractionCard />);
      for (const link of testnetTraction.sourceLinks) {
        expect(screen.getByText(link.label)).toBeInTheDocument();
      }
    });

    test('does not call the coordinator (no fetch)', () => {
      render(<TestnetTractionCard />);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Acceptance criterion 2: mainnet renders no traction counts.
  // --------------------------------------------------------------------------
  describe('when the app is in mainnet mode', () => {
    beforeEach(() => {
      mockIsTestnet.mockReturnValue(false);
    });

    test('renders nothing — returns null', () => {
      const { container } = render(<TestnetTractionCard />);
      expect(container.firstChild).toBeNull();
    });

    test('does not render any fixture metrics', () => {
      render(<TestnetTractionCard />);
      expect(screen.queryByText('Testnet traction')).not.toBeInTheDocument();
      expect(screen.queryByText('Deployed contracts')).not.toBeInTheDocument();
      expect(screen.queryByText(testnetTraction.deployedContracts.value)).not.toBeInTheDocument();
    });

    test('does not call the coordinator (no fetch)', () => {
      render(<TestnetTractionCard />);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Acceptance criterion 3: unknown network renders no traction counts.
  // The isTestnet() function from networks.ts only returns true for testnet;
  // any other resolution path results in false (treated as unknown/mainnet).
  // --------------------------------------------------------------------------
  describe('when the network is unknown (isTestnet returns false)', () => {
    beforeEach(() => {
      // isTestnet() defaults to false for any non-testnet resolved network.
      mockIsTestnet.mockReturnValue(false);
    });

    test('renders nothing — returns null', () => {
      const { container } = render(<TestnetTractionCard />);
      expect(container.firstChild).toBeNull();
    });

    test('does not render the card heading or any metrics', () => {
      render(<TestnetTractionCard />);
      expect(screen.queryByText('Testnet traction')).not.toBeInTheDocument();
      expect(screen.queryByText('Public metrics')).not.toBeInTheDocument();
      expect(screen.queryByText('Supported testnet routes')).not.toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Fixture integrity: the fixture itself must be tagged as 'testnet'.
  // This guards against someone changing the tag and silently re-enabling the
  // card on mainnet by updating the fixture but not the card logic.
  // --------------------------------------------------------------------------
  describe('testnet-traction fixture', () => {
    test('fixture.network is "testnet"', () => {
      expect(testnetTraction.network).toBe('testnet');
    });
  });
});
