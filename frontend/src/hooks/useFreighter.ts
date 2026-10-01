import { useCallback, useEffect, useState } from 'react';
import rawFreighterApi from '@stellar/freighter-api';
import {
  expectedStellarPassphrase,
  normalizeFreighterPassphrase,
  readRequestedModeFromUrl,
  verifyFreighterNetworkAgreement,
  type NetworkMode,
} from '../lib/useNetworkMode';
import { resolveNetworkMode } from '../config/networks';

const freighterApi = (rawFreighterApi as any)?.default ?? rawFreighterApi;

export class FreighterNetworkMismatchError extends Error {
  readonly expectedPassphrase: string;
  readonly actualPassphrase: string | null;

  constructor(expectedPassphrase: string, actualPassphrase: string | null, message?: string) {
    super(
      message ||
        `Freighter network mismatch: wallet is on "${actualPassphrase || 'unknown'}", but order requires "${expectedPassphrase}". Signature refused.`,
    );
    this.name = 'FreighterNetworkMismatchError';
    this.expectedPassphrase = expectedPassphrase;
    this.actualPassphrase = actualPassphrase;
  }
}

export interface UseFreighterOptions {
  networkMode?: NetworkMode;
  expectedPassphrase?: string;
  expectedNetwork?: string;
  orderNetwork?: NetworkMode | string;
  address?: string | null;
}

export interface SignTransactionOptions {
  networkMode?: NetworkMode;
  expectedPassphrase?: string;
  expectedNetwork?: string;
  orderNetwork?: NetworkMode | string;
}

export interface FreighterState {
  isConnected: boolean;
  address: string | null;
  isLoading: boolean;
  error: string | null;
  network: string | null;
  networkPassphrase: string | null;
}

export type UseFreighterInput = UseFreighterOptions | NetworkMode;

export function useFreighter(optionsInput?: UseFreighterInput) {
  const options: UseFreighterOptions | undefined =
    typeof optionsInput === 'string'
      ? { networkMode: optionsInput }
      : optionsInput;

  const [state, setState] = useState<FreighterState>({
    isConnected: Boolean(options?.address),
    address: options?.address ?? null,
    isLoading: false,
    error: null,
    network: null,
    networkPassphrase: null,
  });

  const refreshNetwork = useCallback(async () => {
    try {
      if (!freighterApi || typeof freighterApi.getNetwork !== 'function') {
        return null;
      }
      const info: any = await freighterApi.getNetwork();
      const passphrase = normalizeFreighterPassphrase(info);
      const networkName =
        typeof info === 'object' && info?.network
          ? String(info.network)
          : typeof info === 'string'
            ? info
            : null;
      setState(prev => ({
        ...prev,
        network: networkName,
        networkPassphrase: passphrase,
      }));
      return info;
    } catch {
      return null;
    }
  }, []);

  // Check if Freighter is connected on mount
  useEffect(() => {
    const checkConnection = async () => {
      console.log('🚀 Checking Freighter connection...');

      try {
        // Check if Freighter is available
        if (!freighterApi || typeof freighterApi.isConnected !== 'function') {
          console.log('❌ Freighter API not available');
          return;
        }

        const isConnected = await freighterApi.isConnected();
        console.log('🚀 Freighter connection status:', isConnected);

        if (isConnected) {
          const { address } = await freighterApi.getAddress();
          console.log('🚀 Freighter address:', address);

          let networkInfo: any = null;
          try {
            if (typeof freighterApi.getNetwork === 'function') {
              networkInfo = await freighterApi.getNetwork();
            }
          } catch {
            // ignore
          }
          const passphrase = normalizeFreighterPassphrase(networkInfo);
          const networkName =
            typeof networkInfo === 'object' && networkInfo?.network
              ? String(networkInfo.network)
              : typeof networkInfo === 'string'
                ? networkInfo
                : null;

          setState(prev => ({
            ...prev,
            isConnected: true,
            address,
            network: networkName,
            networkPassphrase: passphrase,
            error: null,
          }));
        }
      } catch (error) {
        console.error('❌ Error checking Freighter connection:', error);
        setState(prev => ({
          ...prev,
          error: error instanceof Error ? error.message : 'Connection check failed',
        }));
      }
    };

    checkConnection();
  }, []);

  // Re-check after a network change event
  useEffect(() => {
    const handleNetworkChange = () => {
      refreshNetwork();
    };

    window.addEventListener('networkChange', handleNetworkChange);
    window.addEventListener('freighter:networkChange', handleNetworkChange);
    window.addEventListener('stellar:networkChange', handleNetworkChange);
    window.addEventListener('popstate', handleNetworkChange);

    return () => {
      window.removeEventListener('networkChange', handleNetworkChange);
      window.removeEventListener('freighter:networkChange', handleNetworkChange);
      window.removeEventListener('stellar:networkChange', handleNetworkChange);
      window.removeEventListener('popstate', handleNetworkChange);
    };
  }, [refreshNetwork]);

  // Connect to Freighter
  const connect = useCallback(async () => {
    console.log('🚀 Connecting to Freighter...');
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Check if Freighter is available
      if (!freighterApi || typeof freighterApi.isConnected !== 'function') {
        throw new Error("Freighter wallet extension bulunamadı. Lütfen Freighter extension'ı yükleyin.");
      }

      const isAvailable = await freighterApi.isConnected();
      console.log('🚀 Freighter availability:', isAvailable);

      if (!isAvailable) {
        throw new Error('Freighter wallet is not available. Please install Freighter extension.');
      }

      console.log('🚀 Requesting Freighter permission...');
      await freighterApi.setAllowed();

      console.log('🚀 Getting Freighter address...');
      const { address } = await freighterApi.getAddress();
      console.log('🚀 Freighter connected successfully:', address);

      let networkInfo: any = null;
      try {
        if (typeof freighterApi.getNetwork === 'function') {
          networkInfo = await freighterApi.getNetwork();
        }
      } catch {
        // ignore
      }
      const passphrase = normalizeFreighterPassphrase(networkInfo);
      const networkName =
        typeof networkInfo === 'object' && networkInfo?.network
          ? String(networkInfo.network)
          : typeof networkInfo === 'string'
            ? networkInfo
            : null;

      setState(prev => ({
        ...prev,
        isConnected: true,
        address,
        network: networkName,
        networkPassphrase: passphrase,
        isLoading: false,
        error: null,
      }));

      return address;
    } catch (error) {
      console.error('❌ Freighter connection error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to Freighter';
      setState(prev => ({
        ...prev,
        isConnected: false,
        address: null,
        isLoading: false,
        error: errorMessage,
      }));
      throw error;
    }
  }, []);

  // Disconnect from Freighter
  const disconnect = useCallback(() => {
    setState({
      isConnected: false,
      address: null,
      isLoading: false,
      error: null,
      network: null,
      networkPassphrase: null,
    });
  }, []);

  // Get network info
  const getNetworkInfo = useCallback(async () => {
    try {
      if (!freighterApi || typeof freighterApi.getNetwork !== 'function') {
        return null;
      }
      const networkInfo = await freighterApi.getNetwork();
      return networkInfo;
    } catch (error) {
      console.error('Error getting network info:', error);
      return null;
    }
  }, []);

  // Sign transaction
  const signTransaction = useCallback(
    async (
      xdr: string,
      networkPassphrase?: string,
      addressOverride?: string,
      signOptions?: SignTransactionOptions,
    ) => {
      const signerAddress = addressOverride ?? state.address;
      if (!signerAddress) {
        throw new Error('Wallet not connected');
      }

      if (!freighterApi || typeof freighterApi.signTransaction !== 'function') {
        throw new Error('Freighter wallet is not available');
      }

      // Determine expected order network mode and expected passphrase
      const orderNetwork =
        signOptions?.orderNetwork ??
        signOptions?.networkMode ??
        options?.orderNetwork ??
        options?.networkMode;

      const expectedPassphrase =
        signOptions?.expectedPassphrase ??
        options?.expectedPassphrase ??
        (orderNetwork ? expectedStellarPassphrase(orderNetwork as NetworkMode) : networkPassphrase) ??
        expectedStellarPassphrase(resolveNetworkMode(readRequestedModeFromUrl()));

      // Immediately before opening signature request: re-check Freighter's current network
      let currentFreighterNetwork: any = null;
      try {
        if (typeof freighterApi.getNetwork === 'function') {
          currentFreighterNetwork = await freighterApi.getNetwork();
        }
      } catch (netErr) {
        console.error('Error checking Freighter network before signing:', netErr);
      }

      // Compare Freighter's network to the expected order network
      const agreement = verifyFreighterNetworkAgreement(
        currentFreighterNetwork,
        expectedPassphrase,
      );

      if (!agreement.matches) {
        const refusalError = new FreighterNetworkMismatchError(
          expectedPassphrase,
          agreement.actualPassphrase,
        );
        console.error('❌ Refusing Freighter signature due to network disagreement:', refusalError.message);
        // CRITICAL: Do NOT include signed or unsigned XDR in refusal error
        throw refusalError;
      }

      try {
        const result = await freighterApi.signTransaction(xdr, {
          networkPassphrase: expectedPassphrase,
          address: signerAddress,
        });
        return result.signedTxXdr;
      } catch (error) {
        console.error('Error signing transaction:', error);
        throw error;
      }
    },
    [state.address, options],
  );

  return {
    ...state,
    connect,
    disconnect,
    getNetworkInfo,
    refreshNetwork,
    signTransaction,
  };
}