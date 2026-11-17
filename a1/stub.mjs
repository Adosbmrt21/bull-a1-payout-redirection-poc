// A1 stub: stands in for the Bull API server in the direct-settle flow.
// It behaves honestly EXCEPT for the one thing A1 is about: the createDeal transaction
// it returns sets buyerReceive = a THIRD wallet, although the buyer never asked for any
// redirection. The fee quote is signed by the fork's (patched) test fee signer; the
// seller consent is the one the run script passes through (signed with buyerReceive =
// third wallet, as a malicious counterparty can sign with raw tooling).
import { createServer } from "node:http";
import { parseAbi, encodeFunctionData, parseUnits, parseEther } from "viem";
import { readFileSync } from "node:fs";
import { loadKeys, forkClient, ESCROW, ZERO, escrowParamsHash, quoteDigest, signQuote, POC_DIR } from "../lib.mjs";

const K = loadKeys();
const pub = forkClient();
const st = JSON.parse(readFileSync(POC_DIR + "/fork-state.json", "utf8"));
const MOCK = st.mock;
const PORT = 8791;
const DEALS = parseAbi(["function deals(uint256) view returns (address buyer,address seller,address sellToken,uint256 sellAmount,address payToken,uint256 payAmount,uint64 deadline,bool buyerFunded,bool sellerFunded,uint8 status,address sellerPayout,address buyerReceive,uint16 feeBps)"]);
const CREATE = parseAbi(["function createDeal((address seller,address sellerPayout,address buyerReceive,address sellToken,uint256 sellAmount,address payToken,uint256 payAmount,uint64 deadline) p,(uint16 feeBps,uint64 expiry,bytes sig) q,(uint64 validUntil,bytes sig) c) returns (uint256)"]);
const FUND = parseAbi(["function fundPayment(uint256 id) payable", "function fundTokens(uint256 id)", "function approve(address spender,uint256 amount) returns (bool)", "function allowance(address owner,address spender) view returns (uint256)"]);

const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b ? JSON.parse(b) : {})); });
const send = (res, obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/v1/settle") {
      const b = await readBody(req);
      const now = Number((await pub.getBlock()).timestamp);
      const sellAmount = parseUnits(String(b.sellAmount), 6);
      const payAmount = parseEther(String(b.payAmount));
      const params = {
        seller: b.seller, sellerPayout: ZERO,
        buyerReceive: K.third.address, // <<< THE REDIRECTION: buyer never asked for this
        sellToken: b.sellToken, sellAmount, payToken: ZERO, payAmount, deadline: BigInt(b.deadline),
      };
      const qExp = BigInt(now + 3600);
      const qSig = await signQuote(K.feeSigner, quoteDigest({ contract: ESCROW, sender: b.buyer, paramsHash: escrowParamsHash(params), fee: 100, expiry: qExp }));
      const data = encodeFunctionData({ abi: CREATE, functionName: "createDeal", args: [
        [params.seller, params.sellerPayout, params.buyerReceive, params.sellToken, params.sellAmount, params.payToken, params.payAmount, params.deadline],
        [100, qExp, qSig], [BigInt(b.validUntil), b.sellerSig]] });
      console.log(`[stub] settle: built createDeal with buyerReceive=${params.buyerReceive} (buyer asked for none)`);
      return send(res, { transaction: { to: ESCROW, data, value: "0" }, feeBps: 100 });
    }
    const m = req.url.match(/^\/api\/v1\/settle\/(\d+)$/);
    if (req.method === "GET" && m) {
      const id = BigInt(m[1]);
      const d = await pub.readContract({ address: ESCROW, abi: DEALS, functionName: "deals", args: [id] });
      const buyerSteps = [], sellerSteps = [];
      if (Number(d[9]) === 1 && !d[7]) buyerSteps.push({ from: d[0], transaction: { to: ESCROW, data: encodeFunctionData({ abi: FUND, functionName: "fundPayment", args: [id] }), value: d[5].toString() } });
      if (Number(d[9]) === 1 && !d[8]) {
        const al = await pub.readContract({ address: d[2], abi: FUND, functionName: "allowance", args: [d[1], ESCROW] });
        if (al < d[3]) sellerSteps.push({ from: d[1], transaction: { to: d[2], data: encodeFunctionData({ abi: FUND, functionName: "approve", args: [ESCROW, d[3]] }), value: "0" } });
        sellerSteps.push({ from: d[1], transaction: { to: ESCROW, data: encodeFunctionData({ abi: FUND, functionName: "fundTokens", args: [id] }), value: "0" } });
      }
      return send(res, { status: Number(d[9]) === 2 ? "settled" : Number(d[9]) === 3 ? "cancelled" : "open", buyerSteps, sellerSteps });
    }
    res.writeHead(404); res.end("{}");
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) })); }
}).listen(PORT, () => console.log(`[stub] A1 stub on http://localhost:${PORT}`));
