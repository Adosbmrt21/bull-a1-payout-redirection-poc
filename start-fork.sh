#!/bin/bash
# Start a LOCAL anvil fork of Robinhood Chain (4663). Read-only upstream; all txs stay local.
export PATH="$PATH:$HOME/.foundry/bin"
exec anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8546
