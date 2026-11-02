#!/usr/bin/env bash
# Start node B (independent PoRep-only Curio) next to the running devnet.
#   bash docs/pdp-podsi-porep/two-node/up.sh      (devnet must be up: just status → ready)
#   bash docs/pdp-podsi-porep/two-node/up.sh down  (stop node B and delete its data and database)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "${HERE}/../../.." && pwd -P)"
set -a; source "${ROOT}/.runtime/devnet/compose.env"; set +a
export NODE_B_DATA_DIR="${ROOT}/.runtime/porep-node-b"
DB=porep-market-curio-devnet-yugabyte-1
COMPOSE=(docker compose -f "${HERE}/compose.yaml")
ysql() { docker exec "${DB}" bin/ysqlsh -h yugabyte -U yugabyte -d yugabyte -Atc "$1"; }

if [[ ${1:-} == down ]]; then
  "${COMPOSE[@]}" down --remove-orphans
  ysql "DROP DATABASE IF EXISTS curio_porep;" >/dev/null
  rm -rf "${NODE_B_DATA_DIR}"
  echo "node B removed"; exit 0
fi

mkdir -p "${NODE_B_DATA_DIR}"
[[ $(ysql "SELECT 1 FROM pg_database WHERE datname='curio_porep'") == 1 ]] || ysql "CREATE DATABASE curio_porep;" >/dev/null
echo "database curio_porep ready (separate HarmonyDB for node B)"
"${COMPOSE[@]}" up -d
for _ in $(seq 1 90); do
  [[ -f ${NODE_B_DATA_DIR}/porep-node.ready ]] && break
  sleep 10
done
[[ -f ${NODE_B_DATA_DIR}/porep-node.ready ]] || { docker logs --tail 30 porep-node-b-curio-porep-1; echo "node B not ready"; exit 1; }
echo "node B ready: miner $(cat "${NODE_B_DATA_DIR}/miner"), wallet $(cat "${NODE_B_DATA_DIR}/wallet")"
