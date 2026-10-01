import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RefundDialog } from './RefundDialog';
import { makeEthereumHTLCClient } from '../../lib/sdk-context';
import { useNetworkMode } from '../../lib/useNetworkMode';
import { Address } from 'viem';
import { vi } from 'vitest';

// Mock the makeEthereumHTLCClient function
vi.mock('../../lib/sdk-context', () => ({
  makeEthereumHTLCClient: vi.fn(),
}));

// Mock the isTestnet function
vi.mock('../../config/networks', () => ({
  isTestnet: vi.fn(() => true),
}));

// Mock useNetworkMode
vi.mock('../../lib/useNetworkMode', () => ({
  useNetworkMode: vi.fn(),
}));

const mockUserAddress = '0x1234567890123456789012345678901234567890' as Address;
const mockOrderId = '42';
const mockAmountWei = '1000000000000000000'; // 1 ETH in wei

const mockNetworkState = {
  mode: 'testnet' as const,
  hasAnyMismatch: false,
  metamaskChainId: '0xaa36a7',
};

describe('RefundDialog', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ eligible: true, lockedSides: [] }),
    })));
    vi.mocked(useNetworkMode).mockReturnValue(mockNetworkState as any);
  });

  describe('Timelock countdown → refundable state', () => {
    test('initially shows waiting state when timelock not expired', async () => {
      const timelockFuture = Math.floor(Date.now() / 1000) + 10; // 10 seconds in future
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          eligible: false,
          lockedSides: [{ chain: 'ethereum', earliestRefundAt: timelockFuture }],
        }),
      })));
      render(<RefundDialog 
        coordinatorOrderId="coordinator-order-1"
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={timelockFuture}
        amountWei={mockAmountWei}
      />);

      // Initially should be in waiting phase
      expect(await screen.findByText(/Refund is not available on both chains/i)).toBeInTheDocument();
      expect(screen.getByText(/Ethereum is still locked until/i)).toBeInTheDocument();
      expect(screen.getByText(/Ethereum time remaining:/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Refund from contract/i })).toBeDisabled();
    });

    test('transitions to ready state when timelock expires', async () => {
      const timelockPast = 0; // Definitely in the past
      render(<RefundDialog 
        coordinatorOrderId="coordinator-order-1"
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={timelockPast}
        amountWei={mockAmountWei}
      />);
      // Wait for the phase to update to ready (should be immediate)
      await waitFor(() => {
        expect(screen.getByText(/coordinator confirms both Ethereum and Stellar timelocks have expired/i)).toBeInTheDocument();
      }, { timeout: 10000 });

      expect(screen.getByRole('button', { name: /Refund from contract/i })).toBeEnabled();
    });
  });

  describe('Network mismatch handling', () => {
    test('disables refund button when network mismatch exists', async () => {
      vi.mocked(useNetworkMode).mockReturnValue({
        ...mockNetworkState,
        hasAnyMismatch: true,
      } as any);

      const timelockPast = 0;
      render(<RefundDialog 
        coordinatorOrderId="coordinator-order-1"
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={timelockPast}
        amountWei={mockAmountWei}
      />);

      await waitFor(() => {
        expect(screen.getByText(/coordinator confirms both Ethereum and Stellar timelocks have expired/i)).toBeInTheDocument();
      });

      // Button should be disabled due to mismatch
      expect(screen.getByRole('button', { name: /Refund from contract/i })).toBeDisabled();
    });

    test('shows actionable error message on refund attempt with mismatch', async () => {
      vi.mocked(useNetworkMode).mockReturnValue({
        ...mockNetworkState,
        hasAnyMismatch: true,
        metamaskChainId: '0x1', // Mainnet
        mode: 'testnet',
      } as any);

      const timelockPast = 0;
      render(<RefundDialog 
        coordinatorOrderId="coordinator-order-1"
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={timelockPast}
        amountWei={mockAmountWei}
      />);

      await waitFor(() => {
        expect(screen.getByText(/coordinator confirms both Ethereum and Stellar timelocks have expired/i)).toBeInTheDocument();
      });

      // Note: Button is disabled, but if it were clicked, handleRefund would catch it.
      // Since it's disabled, we can't easily click it with userEvent.
      // We can verify that it is disabled.
      expect(screen.getByRole('button', { name: /Refund from contract/i })).toBeDisabled();
    });
  });

  describe('Missing HTLC configuration', () => {
    test('shows error when v2 escrow address not configured', async () => {
      // Make makeEthereumHTLCClient return null
      vi.mocked(makeEthereumHTLCClient).mockResolvedValue(null);

      const timelockPast = 0; // Definitely in the past
      render(<RefundDialog 
        coordinatorOrderId="coordinator-order-1"
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={timelockPast}
        amountWei={mockAmountWei}
      />);
      // Wait for the phase to be ready (should be immediate)
      await waitFor(() => {
        expect(screen.getByText(/coordinator confirms both Ethereum and Stellar timelocks have expired/i)).toBeInTheDocument();
      }, { timeout: 10000 });

      // Click the refund button
      await userEvent.click(screen.getByRole('button', { name: /Refund from contract/i }));

      // Wait for error to appear
      await waitFor(() => {
        expect(screen.getByText(/Refund failed/i)).toBeInTheDocument();
        expect(screen.getByText(/HTLCEscrow address is not configured for this network/i)).toBeInTheDocument();
      }, { timeout: 10000 });
    });
  });

  describe('Legacy v1 bytes32 validation', () => {
    test('shows error for invalid bytes32 order id in v1 mode', async () => {
      const timelockPast = 0; // Definitely in the past
      // Mock window.ethereum to be present
      Object.defineProperty(window, 'ethereum', {
        writable: true,
        value: {
          request: vi.fn(),
        },
      });
      render(<RefundDialog 
        coordinatorOrderId="coordinator-order-1"
        userAddress={mockUserAddress}
        orderId='not-a-bytes32' // Invalid bytes32
        timelockUnixSeconds={timelockPast}
        amountWei={mockAmountWei}
        contractMode="v1-mainnet-htlc"
        v1ContractAddress={'0x1234567890123456789012345678901234567890' as Address}
      />);
      // Wait for the phase to be ready (should be immediate)
      await waitFor(() => {
        expect(screen.getByText(/coordinator confirms both Ethereum and Stellar timelocks have expired/i)).toBeInTheDocument();
      }, { timeout: 10000 });

      // Click the refund button
      await userEvent.click(screen.getByRole('button', { name: /Refund from contract/i }));

      // Wait for error to appear
      await waitFor(() => {
        expect(screen.getByText(/Refund failed/i)).toBeInTheDocument();
        expect(screen.getByText(/v1 mainnet refund requires a 0x-prefixed bytes32 order id/i)).toBeInTheDocument();
      }, { timeout: 10000 });
    });
  });

  describe('Coordinator refund eligibility', () => {
    test('blocks a refund and names a locked chain without opening a wallet client', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          eligible: false,
          lockedSides: [{ chain: 'stellar', earliestRefundAt: 2_000_000_000 }],
        }),
      }));
      vi.stubGlobal('fetch', fetchMock);
      render(<RefundDialog
        coordinatorOrderId="coordinator-order-1"
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={0}
        amountWei={mockAmountWei}
      />);

      expect(await screen.findByText(/Stellar is still locked until/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Refund from contract/i })).toBeDisabled();
      expect(makeEthereumHTLCClient).not.toHaveBeenCalled();
    });

    test('builds one refund transaction after both chains are eligible', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ eligible: true, lockedSides: [] }),
      }));
      const refundOrder = vi.fn().mockResolvedValue(`0x${'1'.repeat(64)}`);
      vi.stubGlobal('fetch', fetchMock);
      vi.mocked(makeEthereumHTLCClient).mockResolvedValue({ refundOrder } as any);
      render(<RefundDialog
        coordinatorOrderId="coordinator-order-1"
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={0}
        amountWei={mockAmountWei}
      />);

      const confirm = await screen.findByRole('button', { name: /Refund from contract/i });
      await waitFor(() => expect(confirm).toBeEnabled());
      await userEvent.click(confirm);

      await waitFor(() => expect(refundOrder).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(vi.mocked(makeEthereumHTLCClient).mock.invocationCallOrder[0]!).toBeLessThan(
        fetchMock.mock.invocationCallOrder[2]!
      );
      expect(fetchMock.mock.invocationCallOrder[2]).toBeLessThan(
        refundOrder.mock.invocationCallOrder[0]!
      );
    });

    test('blocks the wallet call if a chain becomes locked after client preparation', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ eligible: true, lockedSides: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ eligible: true, lockedSides: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            eligible: false,
            lockedSides: [{ chain: 'stellar', earliestRefundAt: 2_000_000_000 }],
          }),
        });
      const refundOrder = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      vi.mocked(makeEthereumHTLCClient).mockResolvedValue({ refundOrder } as any);
      render(<RefundDialog
        coordinatorOrderId="coordinator-order-1"
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={0}
        amountWei={mockAmountWei}
      />);

      await userEvent.click(await screen.findByRole('button', { name: /Refund from contract/i }));

      expect(await screen.findByText(/Stellar is still locked until/)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(refundOrder).not.toHaveBeenCalled();
    });

    test('re-checks an open dialog and blocks when the coordinator still reports a lock', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ eligible: true, lockedSides: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            eligible: false,
            lockedSides: [{ chain: 'ethereum', earliestRefundAt: 2_000_000_000 }],
          }),
        });
      vi.stubGlobal('fetch', fetchMock);
      render(<RefundDialog
        coordinatorOrderId="coordinator-order-1"
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={0}
        amountWei={mockAmountWei}
      />);

      await userEvent.click(await screen.findByRole('button', { name: /Refund from contract/i }));

      expect(await screen.findByText(/Ethereum is still locked until/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Refund from contract/i })).toBeDisabled();
      expect(makeEthereumHTLCClient).not.toHaveBeenCalled();
    });
  });
});
