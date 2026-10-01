import { renderHook, waitFor } from '@testing-library/react'
import { vi, test, expect, beforeEach, describe } from 'vitest'
import {
  useNetworkMode,
  normalizeFreighterPassphrase,
  verifyFreighterNetworkAgreement,
  STELLAR_TESTNET_PASSPHRASE,
  STELLAR_MAINNET_PASSPHRASE,
} from './useNetworkMode'
import freighterApi from '@stellar/freighter-api'

vi.mock('@stellar/freighter-api', () => ({
  default: {
    isConnected: vi.fn().mockResolvedValue(false),
    getNetwork: vi.fn().mockResolvedValue(null),
  },
  isConnected: vi.fn().mockResolvedValue(false),
  getNetwork: vi.fn().mockResolvedValue(null),
}))

beforeEach(() => {
  vi.stubEnv('VITE_MAINNET_ENABLED', 'false')
  window.history.replaceState({}, '', '/?network=mainnet')
  Object.defineProperty(window, 'ethereum', {
    writable: true,
    value: {
      request: vi.fn().mockResolvedValue('0xaa36a7'),
    },
  })
})

test('requested mainnet stays alive while disabled and gate state disables UI actions', async () => {
  const { result } = renderHook(() =>
    useNetworkMode({
      ethAddress: '0x1234567890123456789012345678901234567890',
      stellarAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    }),
  )

  await waitFor(() => expect(result.current.requestedMode).toBe('mainnet'))
  expect(result.current.mode).toBe('testnet')
  expect(result.current.guard.status).toBe('mainnet_gated')
  expect(result.current.guard.disableUiActions).toBe(true)
  expect(result.current.guard.reason).toMatch(/Mainnet operations are currently gated/i)
})

describe('normalizeFreighterPassphrase & verifyFreighterNetworkAgreement', () => {
  test('normalizes various freighter responses', () => {
    expect(normalizeFreighterPassphrase(null)).toBeNull()
    expect(normalizeFreighterPassphrase({ networkPassphrase: STELLAR_TESTNET_PASSPHRASE })).toBe(
      STELLAR_TESTNET_PASSPHRASE,
    )
    expect(normalizeFreighterPassphrase({ network: 'TESTNET' })).toBe(STELLAR_TESTNET_PASSPHRASE)
    expect(normalizeFreighterPassphrase({ network: 'PUBLIC' })).toBe(STELLAR_MAINNET_PASSPHRASE)
    expect(normalizeFreighterPassphrase('TESTNET')).toBe(STELLAR_TESTNET_PASSPHRASE)
    expect(normalizeFreighterPassphrase('PUBLIC')).toBe(STELLAR_MAINNET_PASSPHRASE)
  })

  test('verifies agreement between freighter network and expected order mode', () => {
    const match = verifyFreighterNetworkAgreement(
      { networkPassphrase: STELLAR_TESTNET_PASSPHRASE },
      'testnet',
    )
    expect(match.matches).toBe(true)
    expect(match.actualPassphrase).toBe(STELLAR_TESTNET_PASSPHRASE)

    const mismatch = verifyFreighterNetworkAgreement(
      { networkPassphrase: STELLAR_MAINNET_PASSPHRASE },
      'testnet',
    )
    expect(mismatch.matches).toBe(false)
    expect(mismatch.reason).toContain('does not match expected order network passphrase')
  })
})

describe('useNetworkMode — Freighter network matching', () => {
  test('flags mismatch when Freighter is on mainnet while app mode is testnet', async () => {
    window.history.replaceState({}, '', '/?network=testnet')
    vi.mocked(freighterApi.isConnected).mockResolvedValue(true)
    vi.mocked(freighterApi.getNetwork).mockResolvedValue({
      network: 'PUBLIC',
      networkPassphrase: STELLAR_MAINNET_PASSPHRASE,
    })

    const { result } = renderHook(() =>
      useNetworkMode({
        ethAddress: '0x1234567890123456789012345678901234567890',
        stellarAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      }),
    )

    await waitFor(() =>
      expect(result.current.freighterNetworkPassphrase).toBe(STELLAR_MAINNET_PASSPHRASE),
    )
    expect(result.current.freighterMatches).toBe(false)
    expect(result.current.hasAnyMismatch).toBe(true)
  })

  test('re-checks Freighter network when networkChange event is dispatched', async () => {
    window.history.replaceState({}, '', '/?network=testnet')
    vi.mocked(freighterApi.isConnected).mockResolvedValue(true)
    vi.mocked(freighterApi.getNetwork).mockResolvedValue({
      network: 'TESTNET',
      networkPassphrase: STELLAR_TESTNET_PASSPHRASE,
    })

    const { result } = renderHook(() =>
      useNetworkMode({
        ethAddress: '0x1234567890123456789012345678901234567890',
        stellarAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      }),
    )

    await waitFor(() => expect(result.current.freighterMatches).toBe(true))

    // Now wallet switches to mainnet and event fires
    vi.mocked(freighterApi.getNetwork).mockResolvedValue({
      network: 'PUBLIC',
      networkPassphrase: STELLAR_MAINNET_PASSPHRASE,
    })
    window.dispatchEvent(new Event('networkChange'))

    await waitFor(() => expect(result.current.freighterMatches).toBe(false))
    expect(result.current.hasAnyMismatch).toBe(true)
  })
})
