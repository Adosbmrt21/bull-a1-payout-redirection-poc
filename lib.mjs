// Shared helpers for the Bull PoC evidence package.
// All keys are THROWAWAY test keys generated for this PoC only (poc/keys.json) — they hold
// no real funds and are only ever used against eth_call overrides and a LOCAL anvil fork.
import { createPublicClient, defineChain, http, keccak256, toHex, encodeAbiParameters, concatHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const POC_DIR = dirname(fileURLToPath(import.meta.url));
export const RPC_LIVE = "https://rpc.mainnet.chain.robinhood.com";
export const RPC_FORK = process.env.BULL_FORK_RPC || "http://localhost:8546";
export const CHAIN_ID = 4663;

export const ESCROW = "0xd961cA37e339E14e0D3478383a252E218fe7aa4a";
export const AGREEMENTS = "0x84C6D5dAf99BC65ed3A1D26Ca88ffa834D143999";
export const BURNER = "0x1B3b7abb6553a1bbc9B285E6ab3F2012e88e4d5f";
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const REAL_FEE_SIGNER = "0x585770c10434fa6d434b6b27316354f9d1688bd0";
export const ZERO = "0x0000000000000000000000000000000000000000";

export const robinhood = defineChain({
  id: CHAIN_ID, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_LIVE] } },
});
export const liveClient = () => createPublicClient({ chain: robinhood, transport: http(RPC_LIVE) });
export const forkChain = defineChain({
  id: CHAIN_ID, name: "Robinhood Chain (local anvil fork)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_FORK] } },
});
export const forkClient = () => createPublicClient({ chain: forkChain, transport: http(RPC_FORK) });

// ---- throwaway keys -------------------------------------------------------
const ROLES = ["feeSigner", "buyer", "seller", "third", "arbiter", "relayer", "payee"];
export function loadKeys() {
  const path = POC_DIR + "/keys.json";
  if (!existsSync(path)) {
    const keys = {};
    for (const r of ROLES) keys[r] = generatePrivateKey();
    writeFileSync(path, JSON.stringify({ warning: "THROWAWAY PoC keys. No real funds. Local fork / eth_call use only.", keys }, null, 2));
  }
  const { keys } = JSON.parse(readFileSync(path, "utf8"));
  const out = {};
  for (const r of ROLES) out[r] = privateKeyToAccount(keys[r]);
  return out;
}

// ---- bytecode patching ----------------------------------------------------
// Replace every occurrence of a 20-byte address constant inside runtime bytecode.
// Used to substitute the contracts' feeSigner constant with a test signer we control,
// so fee quotes can be signed end-to-end without anyone else's keys (B-2 technique).
export function patchAddressConstant(codeHex, fromAddr, toAddr) {
  const from = fromAddr.toLowerCase().replace(/^0x/, "");
  const to = toAddr.toLowerCase().replace(/^0x/, "");
  const code = codeHex.toLowerCase().replace(/^0x/, "");
  const count = code.split(from).length - 1;
  return { code: "0x" + code.split(from).join(to), count };
}

// ---- fee quote (v2 construction, confirmed identical in v3 by Lane B-2) ---
// digest = keccak256(abi.encode(chainid, address(this), msg.sender, paramsHash, feeBpsOrFeeWei, expiry))
// paramsHash = keccak256(abi.encode(params struct)); signed with the EIP-191 "\x19Ethereum
// Signed Message:\n32" prefix (i.e. signMessage over the raw 32-byte digest).
export const ESCROW_PARAMS_TUPLE = {
  type: "tuple",
  components: [
    { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" },
    { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint64" },
  ],
};
export function escrowParamsHash(p) {
  return keccak256(encodeAbiParameters([ESCROW_PARAMS_TUPLE],
    [[p.seller, p.sellerPayout, p.buyerReceive, p.sellToken, p.sellAmount, p.payToken, p.payAmount, p.deadline]]));
}
export function quoteDigest({ contract, sender, paramsHash, fee, expiry }) {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    [BigInt(CHAIN_ID), contract, sender, paramsHash, BigInt(fee), BigInt(expiry)]));
}
export async function signQuote(signerAccount, digest) {
  return signerAccount.signMessage({ message: { raw: digest } });
}

// ---- EIP-712 Consent / Fund ----------------------------------------------
export const CONSENT_FIELDS = [
  { name: "buyer", type: "address" }, { name: "seller", type: "address" },
  { name: "sellerPayout", type: "address" }, { name: "buyerReceive", type: "address" },
  { name: "sellToken", type: "address" }, { name: "sellAmount", type: "uint256" },
  { name: "payToken", type: "address" }, { name: "payAmount", type: "uint256" },
  { name: "deadline", type: "uint64" }, { name: "validUntil", type: "uint64" },
];
export const FUND_FIELDS = [
  { name: "id", type: "uint256" }, { name: "seller", type: "address" },
  { name: "sellToken", type: "address" }, { name: "sellAmount", type: "uint256" },
  { name: "permitDeadline", type: "uint256" },
];
export const NAMED_CONSENT_TYPE = "Consent(address buyer,address seller,address sellerPayout,address buyerReceive,address sellToken,uint256 sellAmount,address payToken,uint256 payAmount,uint64 deadline,uint64 validUntil)";
export const CANON_CONSENT_TYPE = "Consent(address,address,address,address,address,uint256,address,uint256,uint64,uint64)";
export const NAMED_FUND_TYPE = "Fund(uint256 id,address seller,address sellToken,uint256 sellAmount,uint256 permitDeadline)";
export const CANON_FUND_TYPE = "Fund(uint256,address,address,uint256,uint256)";

export const typehashOf = (typeString) => keccak256(toHex(typeString));

// Manual EIP-712 digest for an arbitrary typehash (what the contract computes when its
// type string includes field names — no standard signer produces this).
export function manualTypedDigest({ typehash, fields, message, domainSeparator }) {
  const types = [{ type: "bytes32" }, ...fields.map((f) => ({ type: f.type }))];
  const values = [typehash, ...fields.map((f) => message[f.name])];
  const structHash = keccak256(encodeAbiParameters(types, values));
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}
export const ESCROW_DOMAIN = { name: "BullEscrow", version: "3", chainId: CHAIN_ID, verifyingContract: ESCROW };

// ---- misc ------------------------------------------------------------------
export const ERRORS = {
  "0xc8ee2d1d": "NotParty()", "0xf3fb463d": "BadQuote()", "0x90b8ec18": "TransferFailed()",
  "0x49986e73": "WrongAmount()", "0x2bb9acf7": "BadInput()", "0x8523b62a": "BadState()",
  "0xd5ae2fa4": "NotMet()", "0xcab98054": "NotAttester()", "0xab143c06": "Reentrancy()", "0xed3ba6a6": "Reentrant()",
};
export function describeRevert(data) {
  if (!data || data === "0x") return "revert (no data)";
  const sel = data.slice(0, 10).toLowerCase();
  return `revert ${ERRORS[sel] || sel} [raw: ${data.slice(0, 74)}]`;
}
// Pack an address/uint into a 32-byte storage word at a byte offset counted from the LOW end.
export function setBytes(word, valueHex40orBytes, byteOffsetFromLow, byteLen) {
  const w = BigInt(word);
  const v = BigInt(valueHex40orBytes);
  const shift = BigInt(byteOffsetFromLow * 8);
  const mask = ((1n << BigInt(byteLen * 8)) - 1n) << shift;
  return "0x" + ((w & ~mask) | ((v << shift) & mask)).toString(16).padStart(64, "0");
}
export const wordOf = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
export const slotAdd = (baseHex, n) => "0x" + (BigInt(baseHex) + BigInt(n)).toString(16).padStart(64, "0");
export const mappingSlot = (key, slot) =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(key), BigInt(slot)]));
