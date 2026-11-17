// Fork setup: prepare the LOCAL anvil fork of Robinhood Chain (4663) for the PoCs.
// - patches the feeSigner address constant inside the escrow + Agreements bytecode
//   (anvil_setCode) to a throwaway test signer, so fee quotes verify end-to-end;
// - funds the throwaway test wallets with fork ETH (anvil_setBalance);
// - deploys MockERC20 and mints the seller a balance;
// - stores a snapshot id + addresses in fork-state.json; every candidate run reverts
//   to this snapshot first (helper: resetFork()).
// Nothing here touches the real chain beyond the fork's own read-through to the RPC.
// RE-RUN: start the fork first (poc/start-fork.sh), then `node setup-fork.mjs`.
import { createWalletClient, http, parseAbi, parseEther } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { loadKeys, forkClient, forkChain, RPC_FORK, ESCROW, AGREEMENTS, REAL_FEE_SIGNER, patchAddressConstant, POC_DIR } from "./lib.mjs";

const K = loadKeys();
const pub = forkClient();
const rpc = (method, params) => pub.request({ method, params });

export async function resetFork() {
  const st = JSON.parse(readFileSync(POC_DIR + "/fork-state.json", "utf8"));
  await rpc("evm_revert", [st.snapshot]);
  const snap = await rpc("evm_snapshot", []);
  writeFileSync(POC_DIR + "/fork-state.json", JSON.stringify({ ...st, snapshot: snap }, null, 2));
  return st;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = (...a) => console.log(...a);
  log("fork chain id:", await pub.getChainId(), "block:", await pub.getBlockNumber());
  // fund wallets
  for (const role of ["buyer", "seller", "third", "arbiter", "relayer", "payee", "feeSigner"]) {
    await rpc("anvil_setBalance", [K[role].address, "0x" + parseEther("10").toString(16)]);
  }
  log("test wallets funded with 10 fork-ETH each");
  // patch feeSigner in escrow + agreements
  for (const [name, addr] of [["escrow", ESCROW], ["agreements", AGREEMENTS]]) {
    const code = await pub.request({ method: "eth_getCode", params: [addr, "latest"] });
    const patched = patchAddressConstant(code, REAL_FEE_SIGNER, K.feeSigner.address);
    await rpc("anvil_setCode", [addr, patched.code]);
    const fs = await pub.readContract({ address: addr, abi: parseAbi(["function feeSigner() view returns (address)"]), functionName: "feeSigner" });
    log(`${name}: feeSigner constant patched (${patched.count} occurrence(s)); feeSigner() now reads ${fs}`);
  }
  // deploy mock token from the buyer account
  const artifact = JSON.parse(readFileSync(POC_DIR + "/foundry/out/MockERC20.sol/MockERC20.json", "utf8"));
  const buyer = createWalletClient({ account: K.buyer, chain: forkChain, transport: http(RPC_FORK) });
  const hash = await buyer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const mock = rc.contractAddress;
  log("MockERC20 deployed at", mock);
  const seller = createWalletClient({ account: K.seller, chain: forkChain, transport: http(RPC_FORK) });
  const mintHash = await seller.writeContract({ address: mock, abi: artifact.abi, functionName: "mint", args: [K.seller.address, 1000000000n] });
  await pub.waitForTransactionReceipt({ hash: mintHash });
  log("minted 1000 MOCK (1e9 units, 6dp) to seller", K.seller.address);
  const snap = await rpc("evm_snapshot", []);
  writeFileSync(POC_DIR + "/fork-state.json", JSON.stringify({ snapshot: snap, mock, mockAbi: "foundry/out/MockERC20.sol/MockERC20.json" }, null, 2));
  log("snapshot:", snap, "— fork-state.json written");
}
