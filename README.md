# Bull A1 PoC — Buyer-side payout-redirection non-verification

Proof of concept for a bug-bounty report to Bull (bull.family), filed 2026-11-17.

**Finding:** the official Bull SDK (`bull.mjs`) and local MCP server (`bull-mcp.mjs`) never verify the escrow deal's payout-redirection fields — `sellerPayout` (index 10) and `buyerReceive` (index 11) of `deals()` — on the buyer side. The seller-side clients pin both fields before signing; the buyer-side clients read the created deal from chain but drop exactly those two indices from their comparison. A deal created (by a malicious seller or a malicious/compromised API server, which builds the `createDeal` transaction) with `buyerReceive` pointing at a third wallet settles the purchased tokens in full to that third wallet while the buyer's unmodified official client opens and funds the deal with no error and no warning.

## Evidence

Full run log: [`a1/output.log`](a1/output.log). Headline results, local anvil fork of Robinhood Chain (4663), unmodified official SDK:

- `open()` returned deal id 3 — no error, no warning about the redirection.
- On-chain `deals(3)`: `buyerReceive` (idx 11) = third wallet `0xaE2c0B7c…A84cc` the whole time.
- Deal settled (status 2); third wallet received the full sellAmount (100,000,000 MOCK); **buyer received 0**; seller paid in full (~0.0099 ETH on a 0.01 ETH deal, after the 1% fee).

## Reproduce

```bash
./start-fork.sh &     # anvil fork of chain 4663 on http://localhost:8546
node setup-fork.mjs   # once per fresh fork: patch feeSigner to a test signer, fund throwaway wallets, deploy MOCK, snapshot
node a1/run.mjs       # drives the unmodified SDK against a1/stub.mjs (stub API, port 8791)
```

Notes:

- The clients under test are byte-identical to the files Bull serves: `bull.mjs` sha256 `220d326f1a047d7ea82060e741e272fa5989c0fc9133f43fe8f7bcc94c2bc841`, `bull-mcp.mjs` sha256 `18304bfd43c3d39f48249a56dcbb6e5ab7771455d273a04f06ab8121449e3055`. Place a copy of the served `bull.mjs` next to `lib.mjs` before running (it is Bull's own file, served at https://www.bull.family/sdk/bull.mjs).
- `setup-fork.mjs` patches only the feeSigner constant in the fork's copy of the escrow bytecode so the stub can issue valid fee quotes. No client code and no contract logic is modified; every run reverts to the post-setup snapshot first.
- All keys are throwaway test keys generated locally by `lib.mjs` on first run (`keys.json`, gitignored). No transaction was sent to the real chain and no real funds were used.
- The upstream RPC is not an archive node: if fork calls fail with "historical state … is not available", restart the fork and re-run `setup-fork.mjs`.
