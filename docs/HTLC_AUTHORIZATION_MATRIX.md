# HTLC Authorization Matrix (Ethereum ↔ Soroban)

The v2 Ethereum `HTLCEscrow` and the Soroban `oversync-htlc` are the two
halves of one bridge. A rule that exists on only one side lets the
other side settle when it should not — for example, paying a resolver
that the registry has removed.

This document is the **single shared specification** both contracts are
held to. Every row below must produce the same outcome class on both
chains. Any divergence is a parity bug.

## Outcome classes

| Class | EVM (`HTLCEscrow.sol`) | Soroban (`oversync-htlc`) |
|---|---|---|
| success | transaction succeeds | transaction succeeds |
| `ResolverNotAuthorised` | `revert ResolverNotAuthorised()` | `Error::ResolverNotAuthorised` (13) |
| `OrderNotFound` | `revert OrderNotFound()` | `Error::OrderNotFound` (4) |
| `OrderNotClaimable` | `revert OrderNotClaimable()` | `Error::OrderNotClaimable` (5) |
| `OrderNotRefundable` | `revert OrderNotRefundable()` | `Error::OrderNotRefundable` (6) |
| `InvalidPreimage` | `revert InvalidPreimage()` | `Error::InvalidPreimage` (7) |
| `Expired` | `revert Expired()` | `Error::Expired` (9) |
| `NotExpired` | `revert NotExpired()` | `Error::NotExpired` (8) |

`OrderNotFound` is reserved for calls against an id that has never been
created; once an order reaches a terminal state it returns
`OrderNotClaimable` / `OrderNotRefundable`.

## Matrix

| # | Condition | EVM outcome | Soroban outcome |
|---|---|---|---|
| 1 | **Registered resolver** creates an order (registry configured) | success | success |
| 2 | **Unregistered resolver** creates an order (registry configured) | `ResolverNotAuthorised` | `ResolverNotAuthorised` |
| 3 | Correct **preimage**, timelock open, claim | success | success |
| 4 | Wrong preimage, claim | `InvalidPreimage` | `InvalidPreimage` |
| 5 | **Timelock open** (`now <= timelock`), claim | success | success |
| 6 | **Timelock expired** (`now > timelock`), claim | `Expired` | `Expired` |
| 7 | **Timelock open**, refund | `NotExpired` | `NotExpired` |
| 8 | **Timelock expired**, refund | success | success |
| 9 | **Already claimed**, claim again | `OrderNotClaimable` | `OrderNotClaimable` |
| 10 | **Already refunded**, refund again | `OrderNotRefundable` | `OrderNotRefundable` |
| 11 | Already claimed, then refund | `OrderNotRefundable` | `OrderNotRefundable` |
| 12 | Already refunded, then claim | `OrderNotClaimable` | `OrderNotClaimable` |
| 13 | Non-resolver claims (registry configured) | success | success |
| 14 | Non-resolver refunds (registry configured) | success | success |
| 15 | Claim against an unknown order id | `OrderNotFound` | `OrderNotFound` |
| 16 | Refund against an unknown order id | `OrderNotFound` | `OrderNotFound` |

### The registry gates creation only

Rows 1–2 and 13–14 are the load-bearing nuance. The `ResolverRegistry`
is a soft sybil filter on **who may create an order**. It never gates
`claim` or `refund`: those paths stay permissionless so a registry
compromise or a deactivated resolver can never strand or misroute
locked funds. An unregistered resolver therefore:

- **fails** when it tries to create an order (row 2), and
- **succeeds** when it relays a claim or refund (rows 13–14).

Known intentional asymmetry (not part of this matrix): the EVM contract
accepts either `sha256` or `keccak256` preimages for compatibility with
classic EVM tooling, while Soroban verifies `sha256` only. Cross-chain
swaps therefore commit to `sha256` end-to-end.

## Where each row is enforced

| Row group | Rust | Solidity | Simulator parity |
|---|---|---|---|
| 1–2 | `soroban/contracts/htlc/src/test.rs` (`create_order_rejects_unregistered_sender_when_registry_is_set`, `create_order_succeeds_for_active_registered_resolver`) | `contracts/test/v2/HTLCEscrow.test.ts` (`resolver registry gate`) | `e2e/authorization-matrix.ts` |
| 3–12 | `soroban/contracts/htlc/src/test.rs` (`happy_path_create_and_claim`, `claim_with_wrong_preimage_fails`, `claim_after_expiry_fails`, `refund_after_timeout_pays_refund_address`, `double_claim_fails`, `second_refund_fails`, `refund_after_claim_fails`) | `contracts/test/v2/HTLCEscrow.test.ts` (`claimOrder`, `refundOrder`) | `e2e/authorization-matrix.ts` |
| 13–16 | `soroban/contracts/htlc/src/test.rs` (`claim_by_unregistered_caller_succeeds_when_registry_configured`, `refund_by_unregistered_caller_succeeds_when_registry_configured`, `claim_unknown_order_fails_not_found`, `refund_unknown_order_fails_not_found`) | `contracts/test/v2/HTLCEscrow.test.ts` (`resolver registry gate`, unknown-order cases) | `e2e/authorization-matrix.ts` |

The simulated matrix is executed against both chain simulators by
`e2e/parity.test.ts`; it fails if the two result sets differ. It needs
no RPC endpoint and no mainnet keys.
