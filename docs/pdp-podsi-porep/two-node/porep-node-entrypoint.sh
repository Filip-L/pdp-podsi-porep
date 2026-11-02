#!/usr/bin/env bash
# Second, independent Curio SP on the same devnet: PoRep only (no PDP).
# Same image and the same first-run steps as upstream docker/curio/entrypoint.sh, except:
#   - own wallet (separate nonces), own miner actor, own HarmonyDB database (CURIO_DB_NAME),
#   - market layer without EnablePDP and without PDP registration,
#   - DomainName = curio-porep, SSRF allows fetching pieces from node A (curio:12310).
set -euo pipefail

: "${CURIO_REPO_PATH:=/var/lib/curio}"
: "${CURIO_DB_NAME:?CURIO_DB_NAME must name the own database of node B}"
DOMAIN=${POREP_DOMAIN:-curio-porep}
PDP_NODE=${PDP_NODE_HOSTPORT:-curio:12310}
log() { printf '[porep-node] %s\n' "$*"; }

log "waiting for Lotus"
lotus wait-api
until [[ $(lotus chain head --height) -gt 9 ]]; do sleep 2; done

if [[ ! -f ${CURIO_REPO_PATH}/.init.setup ]]; then
  WALLET=$(lotus wallet new bls)
  log "own wallet ${WALLET}; funding 1000 FIL from the genesis wallet"
  lotus state wait-msg "$(lotus send "${WALLET}" 1000 | tail -1)" >/dev/null
  before=$(lotus state list-miners | sort)
  sptool --actor t01000 actor new-miner --owner "${WALLET}" --worker "${WALLET}" --from "${WALLET}" \
    --sector-size 8MiB --confidence 1
  MINER=$(comm -13 <(echo "${before}") <(lotus state list-miners | sort) | head -1)
  [[ ${MINER} =~ ^t0[0-9]+$ ]] || { log "could not determine the new miner"; exit 1; }
  echo "${MINER}" >"${CURIO_REPO_PATH}/miner"
  echo "${WALLET}" >"${CURIO_REPO_PATH}/wallet"
  touch "${CURIO_REPO_PATH}/.init.setup"
fi
MINER=$(cat "${CURIO_REPO_PATH}/miner")
log "miner ${MINER}"

if [[ ! -f ${CURIO_REPO_PATH}/.init.config ]]; then
  curio config new-cluster "${MINER}"
  curio config get base | sed -e 's/#Miners = \[\]/Miners = ["'"${MINER}"'"]/g' | curio config set --title base
  curio config create --title market <<EOF
[HTTP]
  DelegateTLS = true
  DomainName = "${DOMAIN}"
  Enable = true

[Ingest]
  MaxDealWaitTime = "0h0m30s"
  SSRFAllowedHosts = ["${PDP_NODE}"]

[Market]
  [Market.StorageMarketConfig]
    [Market.StorageMarketConfig.MK12]
      ExpectedPoRepSealDuration = "0h1m0s"
      ExpectedSnapSealDuration = "0h1m0s"
      PublishMsgPeriod = "0h0m10s"

[Subsystems]
  ParkPieceMinFreeStoragePercent = 0
  EnableCommP = true
  EnableDealMarket = true
  EnableParkPiece = true
  EnablePDP = false
  # Node B keeps its sectors alive with WindowPoSt only. Producing blocks too would make two miners
  # race every 4 s epoch; node A then misses blocks, and after repeated WinPost failures Curio
  # reports its PDP service as unavailable (503).
  EnableWinningPost = false

[Batching]
  [Batching.PreCommit]
    Timeout = "0h0m5s"
    Slack = "6h0m0s"
  [Batching.Commit]
    Timeout = "0h0m5s"
    Slack = "1h0m0s"
EOF
  touch "${CURIO_REPO_PATH}/.init.config"
fi

# Contract addresses (Curio's devnet build reads them from the environment even without PDP).
if [[ -f /var/lib/contracts/curio-devnet.env ]]; then
  set -a; source /var/lib/contracts/curio-devnet.env; set +a
fi

myip=$(hostname -i | awk '{print $1}')
log "starting Curio (layers seal,post,market,gui) at ${myip}"
curio run --nosync --name porep-node --layers seal,post,market,gui &
CURIO_PID=$!
until curio cli --machine "${myip}:12300" wait-api 2>/dev/null; do sleep 5; done
if [[ ! -f ${CURIO_REPO_PATH}/.init.storage ]]; then
  curio cli --machine "${myip}:12300" storage attach --init --seal --store "${CURIO_REPO_PATH}"
  touch "${CURIO_REPO_PATH}/.init.storage"
fi
touch "${CURIO_REPO_PATH}/porep-node.ready"
log "ready: miner ${MINER}, market http://${DOMAIN}:12310 (PDP disabled)"
wait "${CURIO_PID}"
