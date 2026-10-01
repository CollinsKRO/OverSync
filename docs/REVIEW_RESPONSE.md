# OverSync — Review Feedback Response

This document is OverSync's point-by-point response to the v1 review
feedback. Every claim below links to source code or test output so
reviewers can verify it independently.

---

## 1. *"Single relayer = single point of failure"*

**Response.** We restructured the operator model around an open
on-chain resolver registry; the reference coordinator is now one
participant, not a privileged operator.

**Evidence.**

- Solidity registry: [`contracts/contracts/v2/ResolverRegistry.sol`](../contracts/contracts/v2/ResolverRegistry.sol) — anyone can stake; misbehaviour is slashable by the registry owner (intended to become a multisig before mainnet).
- Soroban registry: [`soroban/contracts/resolver-registry/src/lib.rs`](../soroban/contracts/resolver-registry/src/lib.rs).
- Resolver runner: [`resolver/`](../resolver/), Docker image: [`resolver/Dockerfile`](../resolver/Dockerfile), guide: [`docs/RESOLVERS.md`](RESOLVERS.md).
- The HTLC contracts have **no admin escape hatch** — verified by the test `non-custodial guarantees > contract has no admin escape hatch` in [`contracts/test/v2/HTLCEscrow.test.ts`](../contracts/test/v2/HTLCEscrow.test.ts).
- New `MainnetHTLC` deployments use the same active-resolver gate at order creation and the same permissionless claim/refund, preimage, and expiry rules as v2. The shared fixture in [`contracts/test/v2/MainnetHTLCParity.test.ts`](../contracts/test/v2/MainnetHTLCParity.test.ts) checks both contracts. This source change does not alter previously deployed v1 bytecode; migration requires a new deployment.
- Full trust analysis: [`docs/TRUST_MODEL.md`](TRUST_MODEL.md).

---

## 2. *"Stellar side uses claimable balances, not a real HTLC"*

**Response.** We wrote a native Soroban HTLC contract in Rust. The
contract enforces sha256 hashlock + ledger-timestamp timelock; refunds
are permissionless after expiry. The v1 claimable-balance
implementation in `stellar/src/claimable-balance.ts` is deprecated and
will be removed once v2 reaches feature parity.

**Evidence.**

- Source: [`soroban/contracts/htlc/src/lib.rs`](../soroban/contracts/htlc/src/lib.rs)
- Tests: 10 unit tests passing locally (`cargo test --release -p oversync-htlc`):
  - `happy_path_create_and_claim`
  - `refund_after_timeout_pays_refund_address`
  - `claim_with_wrong_preimage_fails`
  - `claim_after_expiry_fails`
  - `double_claim_fails`
  - `refund_after_claim_fails`
  - `timelock_outside_bounds_rejected`
  - `safety_deposit_minimum_enforced`
  - `admin_can_update_min_safety_deposit`
  - `initialise_twice_fails`
- Deploy script: [`soroban/scripts/deploy.sh`](../soroban/scripts/deploy.sh)
- CI build: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) job `soroban`

---

## 3. *"Limited Stellar development; no plan to build on Soroban"*

**Response.** The single largest deliverable in v2 is the Soroban
HTLC contract listed above, plus the Soroban-side resolver registry
and a Stellar wallet integration via the SDK
([`packages/sdk/src/soroban/index.ts`](../packages/sdk/src/soroban/index.ts)) that wraps `create_order`, `claim_order` and `refund_order` with type-safe TypeScript and accepts any wallet (Freighter, headless Keypair, WalletConnect) via a `SorobanSigner` callback.

The Soroban-side ledger contains all swap state — there is no
shadow accounting in the coordinator. The coordinator's SQLite cache
is rebuildable from on-chain events.

---

## 4. *"How is this different from Allbridge?"*

**Response.** Two distinct positioning angles, both backed by
code, not marketing:

1. **First native Soroban HTLC bridge for Stellar.** Allbridge and
   similar bridges use a validator-set / multisig committee on the
   Stellar side. OverSync uses a real HTLC contract whose invariants
   are enforced by Soroban WASM, not by a federated committee.
2. **1inch Fusion+ compatible Stellar gateway.** Our EVM-side
   contracts and resolver pattern mirror 1inch's existing Fusion+
   resolver protocol, so EVM resolver operators can integrate
   Stellar with minimal new tooling.

Full comparison: [`docs/DIFFERENTIATION.md`](DIFFERENTIATION.md).

---

## 5. *"Documentation discrepancies, 'December 2025' typo, '99.5% uptime' claim"*

**Response.** All documentation was rewritten from scratch. The three
overlapping deploy guides (`MAINNET_SETUP.md`, `MAINNET_SETUP_UPDATED.md`,
`RATE_LIMIT_FIX.md`) were deleted; their content was consolidated into
[`docs/DEPLOYMENT.md`](DEPLOYMENT.md). The corrupted duplicate block
in `env.example` (lines 156-307 of the v1 file) was cleaned up. The
`ARCHITECTURE.md` claims of "production-ready" status and Stellar HTLC
predicates that didn't exist in code were removed; the new
[`ARCHITECTURE.md`](../ARCHITECTURE.md) explicitly flags which
components are shipped and which are still in rebuild.

Verifiable uptime / metric claims have been removed pending real
measurements; nothing in the new docs is unsupported by code.

---

## 6. *"Three test transactions failed without refunds being available"*

**Response.** The v1 refund path was mocked
(`relayer/src/recovery-service.ts:364-371` simply logged "refund triggered"
and returned a fake hash). v2 makes refunds **permissionless and direct**:

- On Ethereum: any address can call
  `HTLCEscrow.refundOrder(orderId)` once the timelock has expired.
  Funds always go to `refundAddress`, which the contract pins to the
  original user. Tests:
  - `returns the locked amount to the refund address after timeout, permissionlessly`
  - `rejects refund after a successful claim`
- On Stellar: the Soroban contract's `refund_order` works the same
  way. Tested by `refund_after_timeout_pays_refund_address` and
  `refund_after_claim_fails`.
- The frontend exposes a `RefundDialog`
  ([`frontend/src/features/refund/RefundDialog.tsx`](../frontend/src/features/refund/RefundDialog.tsx))
  that calls `refundOrder` directly from the user's wallet — the
  coordinator is not involved.

A user whose swap fails no longer needs us to act on their behalf;
they recover their own funds via their own wallet.

### 6.1 *"Could the relayer pay a user twice — once as a claim and once as a refund?"*

**Response.** Before this was fixed, the answer was yes, and the
documentation is being explicit about it rather than claiming the
property always held.

Three relayer code paths could each move funds for the same order, and
nothing stopped two of them from running at once:

| Path | Could broadcast | Went through a shared door |
|---|---|---|
| `relayer/src/index.ts` request handlers | ETH release, XLM payout, inline refund, manual refund | only the XLM payout, and only against a fingerprint that included the amount |
| `relayer/src/recovery-service.ts` | simulated refunds (no-ops) | no |
| `relayer/src/refund-watchdog.ts` | XLM refund | no |

The concrete double-payment path was: the ETH release
`sendTransaction` was wrapped in a 30 s timeout, and on timeout the
inline handler submitted an XLM refund. A timeout is not a failure — the
transaction was frequently already in the mempool, so the user received
both the ETH and the XLM refund. A duplicate `POST
/api/orders/xlm-to-eth` had no idempotency guard at all and re-sent the
ETH. And because submission state was an in-memory `Map`, a redeploy
forgot every hash the relayer had already broadcast.

All three paths now submit through one door,
[`relayer/src/relay-submission-tracker.ts`](../relayer/src/relay-submission-tracker.ts),
which enforces per `(orderId, side, action)`:

- **one slot** — the key is the order id, the side, and the action only.
  Amount, destination and extra fields are recorded but never keyed on, so
  a refund recomputed with a slightly different amount cannot fork into a
  second transaction;
- **one action per order** — a submission holds an order-level lock, so a
  refund requested while a claim is unconfirmed is refused outright
  (`RelayOrderBusyError`, surfaced to clients as HTTP `409`) rather than
  paid;
- **hash before broadcast** — the transaction hash is computed locally
  (Stellar signature-base digest; `keccak256` of the locally signed
  payload) and persisted with a `pending` status *before* the transaction
  can reach a node;
- **retry attaches to the hash** — once a hash exists the executor is
  never called again; the retry budget polls that hash to a terminal
  state. An unconfirmed-but-live transaction keeps the record `pending`
  and the order lock **held**, so no refund can race it;
- **restart safety** — records are written atomically to a JSON store
  (`relayer/src/relay-submission-store.ts`, path configurable via
  `RELAYER_SUBMISSION_STORE_PATH`) on every transition. A redeploy serves a
  settled hash from cache and polls an unconfirmed one.

A consequence worth stating plainly: when the claim is unconfirmed, the
refund now fails with `409` instead of succeeding. That is the point —
the alternative is paying both legs — and the refund is retried by the
watchdog once the tracker releases the lock.

Verification (no live chain; every network interaction is an injected
`confirm` closure, and one test replaces `globalThis.fetch` with a
throwing spy to prove it is never called):

- `relayer/test/relay-submission-tracker.test.ts` — the four acceptance
  criteria: two overlapping claims produce one hash; a refund is refused
  while a claim is pending; a confirmed hash is not resubmitted after a
  restart; no live chain.
- `relayer/test/refund-watchdog.test.ts` — the watchdog refunds through the
  tracker, skips an order with a live claim, and produces exactly one
  refund when two doors race.
- `relayer/test/recovery-service.test.ts` — recovery submissions take the
  same order lock, and a deferred recovery stays *pending* (not failed)
  while the order is busy.
- `relayer/test/relay-submission-store.test.ts` — atomic write, corrupt-file
  tolerance, and pruning that can never drop a non-terminal record.

These run in CI (`pnpm --filter @oversync/relayer test`). The invariant
is also listed in the auditor table in section 10 of
[`ARCHITECTURE.md`](../ARCHITECTURE.md) ("Security boundaries: what is
enforced where").

The v2 HTLC path is unaffected: `claimOrder` and `refundOrder` remain
permissionless, direct, and mutually exclusive at the contract level, so
these are defence-in-depth controls for the legacy v1 relayer.

---

## 7. *"Fake `0x1234567890abcdef` style transactions in history"*

**Response.** All fake / mock data channels were removed in Phase 0 of
the rebuild. Concretely:

- `frontend/src/components/TransactionHistory.tsx` no longer has any
  `mockTransactions` array. It pulls history from `GET
  /api/orders/history` on the coordinator and from real on-chain
  events, and filters out any persisted entry that matches the
  hard-coded list of v1 fake hashes
  (`isRealHash` / `isRealTransaction` helpers).
- `relayer/src/index.ts` no longer returns
  `mock_stellar_${Date.now()}` on Stellar submission failures — it
  returns a real `502` error with a refund hint.
- The v1 `relayer/src/rpc-methods.ts`, `websocket-server.ts`,
  `phase6-bridge-service.ts`, `ethereum-listener.ts`, and `quoter.ts`
  mock data sources were either removed or replaced with explicit
  "not implemented in this build" errors. The legacy relayer cannot
  fabricate data even if a caller hits a deprecated endpoint.

---

## 8. *"Solo team / sustainability concerns"*

**Response.** Two structural changes address this:

1. **Open resolver protocol.** Anyone can run a resolver via
   [`docs/RESOLVERS.md`](RESOLVERS.md); the operator role is not
   solo-coupled. If the original team disappears, community resolvers
   keep the bridge alive.
2. **CI / tests / docs raise the bus factor.** A new contributor can
   onboard by reading [`ARCHITECTURE.md`](../ARCHITECTURE.md),
   [`docs/TRUST_MODEL.md`](TRUST_MODEL.md), and running `pnpm install
   && pnpm test`. There are now 43 automated tests across four
   languages (Rust, Solidity, TS, Hardhat-TS) in CI.

A formal team expansion is planned post-Tranche 1: funding requests
include a full-time auditor liaison and a contracted Soroban
specialist.

---

## 9. *"Budget items don't match grant guidelines"*

**Response.** The revised budget is below. Numbers are USD.

| Tranche | Deliverable | Amount |
|---|---|---|
| 1 — Audit preparation | Foundry fuzz + invariant suite; Slither must-not-fail CI gate; differential test harness for both chains | $8,000 |
| 1 — Soroban hardening | Resolver registry binding enforcement; partial-fill support; second round of unit tests; testnet load test | $7,000 |
| 1 — Coordinator productionising | Postgres migration; horizontal scaling test; observability stack | $5,000 |
| 2 — Independent audit | Engage two independent auditors for both HTLC contracts (audit fees paid directly to firms, not grant-funded) | $0 (separate funding) |
| 2 — Bug bounty bootstrap | Initial bug bounty pool | $5,000 |
| 2 — Resolver onboarding | Grants for the first 3 community resolvers (capped per resolver) | $3,000 each = $9,000 |
| 2 — Beta program | Bridge insurance fund (catastrophic event coverage, returned if unused) | $6,000 |

**Total request: $40,000.**

The previous $30,000 ask (Audit Preparation $10K, Testing $10K, Beta
User Program $10K) was too broad and not mapped to deliverables. The
revised structure is tranche-gated, with the second tranche only
released after first-tranche deliverables ship.

---

## Resubmission positioning

The v1 review was correct: the original build mixed a working demo,
single-relayer custody assumptions, placeholder history data, and
overconfident documentation. The resubmission should therefore be
read as a v2 rebuild, not as a cosmetic update to v1.

What is complete for the resubmission:

- Soroban HTLC contract replaces the Stellar claimable-balance
  custody path for v2 testnet.
- Open resolver registry replaces the single privileged relayer as
  the target operator model.
- Refunds are explicit: on-chain HTLC refund, frontend refund dialog,
  inline XLM refund, and watchdog refund.
- Placeholder transaction history is filtered and no longer presented
  as real activity.
- Uptime, volume, and TVL claims are removed unless they can be
  independently verified.
- Budget is tranche-gated and mapped to concrete engineering
  deliverables.

What remains intentionally unfinished before v2 mainnet:

- v2 is testnet-first. The public frontend is testnet-only
  (`VITE_MAINNET_ENABLED=false`); legacy v1 mainnet code remains in
  the repo but is not exposed in the UI until v2 contracts complete
  hardening and independent audit.
- The legacy claimable-balance implementation remains in the repo only
  for v1 compatibility and historical reference; it is not the v2
  trust model.
- Foundry fuzzing, cross-chain differential tests, Slither
  must-not-fail CI, multisig governance, and public audits are still
  pre-mainnet deliverables.
- Team expansion is planned, not completed. The open resolver network
  lowers operational dependence on the founding developer, but formal
  staffing remains a grant milestone.

Suggested summary for the SCF resubmission:

> After the SCF #40 review, we rebuilt OverSync around a native
> Soroban HTLC, permissionless refunds, and an open resolver model.
> The v2 testnet no longer depends on Stellar claimable-balance custody
> or fabricated history data. We are not asking reviewers to treat v2
> as mainnet-ready: mainnet launch is gated on fuzz/differential tests,
> multisig governance, and independent audits. The grant request funds
> those concrete hardening steps rather than broad "audit preparation"
> or generic beta spend.

## Evidence to attach before final submission

Before submitting, attach real testnet evidence rather than relying on
claims in prose:

- At least one successful ETH→XLM v2 testnet swap with Sepolia
  Etherscan and Stellar Expert links.
- At least one successful XLM→ETH v2 testnet swap with both explorer
  links.
- One failed/expired order recovered through `refundOrder` with the
  refund transaction link.
- One XLM→ETH failure path recovered through the automatic refund or
  watchdog refund, with Stellar Expert link.
- Screenshot or dashboard export showing the coordinator history API
  returning only real transactions.

---

## Verification commands

A reviewer can verify the claims above with:

```bash
pnpm install
pnpm --filter @oversync/sdk test           # 8 tests
pnpm --filter @oversync/coordinator test   # 4 tests
pnpm --filter @oversync/contracts compile
pnpm --filter @oversync/contracts exec hardhat test test/v2  # 21 tests
cd soroban && cargo test --release         # 10 tests
```

All 43 tests are expected to pass on a clean checkout of the
`v2-rebuild` branch.
