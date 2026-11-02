#!/usr/bin/env bash
# End-to-end: raw + CAR pieces -> PDP (Synapse) -> PoDSI aggregate -> DDO deal -> sealed PoRep sector,
# then independent verification (bytes, PDP on-chain, sector messages on-chain, podsicheck).
#
# Runs against the local porep-market-devnet (`just up` / `just status` must be ready).
#   bash docs/pdp-podsi-porep/e2e.sh
# Env:
#   PDP_PIECE_BASE  where the PoRep SP fetches the children from (default: the PDP SP, http://curio:12310)
#   TWO_NODE=1      PoRep on a separate, independent Curio (node B, two-node/up.sh); PDP stays on node A.
#                   Adds: transfer count (one fetch per child, PDP node -> PoRep node) and a tampered-data check.
#   WORK            host directory for evidence (default: .runtime/pdp-podsi-porep/<timestamp>)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
P=porep-market-curio-devnet
LOTUS=${P}-lotus-1 CURIO=${P}-curio-1 CLIENT=${P}-piece-server-1 DB=${P}-yugabyte-1
HOST_PIECE=http://127.0.0.1:22310/piece
PDP_PIECE_BASE=${PDP_PIECE_BASE:-http://curio:12310}
SYNAPSE_TAG=synapse-sdk-v2.0.2
WORK=${WORK:-${ROOT}/.runtime/pdp-podsi-porep/$(date +%Y%m%d-%H%M%S)}
CW=/var/lib/curio-client/e2e          # client working dir (inside the client container)
GO_IMAGE=docker.io/library/golang:1.26-trixie
mkdir -p "${WORK}"
if [[ ${TWO_NODE:-0} == 1 ]]; then
  POREP_CONTAINER=porep-node-b-curio-porep-1 POREP_DB=curio_porep
else
  POREP_CONTAINER=${CURIO} POREP_DB=yugabyte
fi

step() { printf '\n=== %s\n' "$*"; }
ok()   { printf '  OK  %s\n' "$*"; }
die()  { printf '  FAIL %s\n' "$*" >&2; exit 1; }
SQL()  { docker exec "${DB}" bin/ysqlsh -h yugabyte -U yugabyte -d yugabyte -Atc "$1"; }      # PDP node (A)
SQLP() { docker exec "${DB}" bin/ysqlsh -h yugabyte -U yugabyte -d "${POREP_DB}" -Atc "$1"; } # PoRep node
CLI()  { docker exec -w /var/lib/curio-client "${CLIENT}" bash -c "$1"; }
CAST() { docker exec "${CURIO}" cast call --rpc-url http://lotus:1234/rpc/v1 "$@"; }
wait_for() { # <timeout-s> <description> <command...>
  local t=$1 d=$2; shift 2
  for ((i = 0; i < t; i += 10)); do "$@" >/dev/null 2>&1 && return 0; sleep 10; done
  die "timeout after ${t}s: ${d}"
}

# ---------------------------------------------------------------- 0. readiness
step "0. Devnet and PDP provider readiness"
PDP_PROVIDER=$(SQL "SELECT config FROM curio.harmony_config WHERE title='base'" | grep -o 't0[0-9]*' | head -1)
[[ ${PDP_PROVIDER} =~ ^t0[0-9]+$ ]] || die "no PDP storage provider found"
if [[ ${TWO_NODE:-0} == 1 ]]; then
  docker exec "${POREP_CONTAINER}" test -f /var/lib/curio/porep-node.ready || die "node B not ready (two-node/up.sh)"
  PROVIDER=$(docker exec "${POREP_CONTAINER}" cat /var/lib/curio/miner)
  SQLP "SELECT config FROM curio.harmony_config WHERE title='market'" | grep -q 'EnablePDP = false' ||
    die "node B must not run PDP"
  ok "node B multiaddr on chain: $(docker exec "${LOTUS}" lotus state miner-info "${PROVIDER}" | awk '/Multiaddrs/ {print $2}')"
else
  PROVIDER=${PDP_PROVIDER}
fi
[[ $(SQL "SELECT count(*) FROM curio.harmony_machines") -gt 0 ]] ||
  die "PDP node has no harmony_machines row (host slept?): docker restart ${CURIO}"
[[ $(SQLP "SELECT count(*) FROM curio.harmony_machines") -gt 0 ]] ||
  die "PoRep node has no harmony_machines row (host slept?): docker restart ${POREP_CONTAINER}"
NV=$(docker exec "${LOTUS}" lotus state network-version | awk '{print $3}')
ok "PDP node: ${PDP_PROVIDER} (${CURIO}); PoRep node: ${PROVIDER} (${POREP_CONTAINER}, db ${POREP_DB}); network version ${NV}"
wait_for 1800 "PDP provider registered/approved/endorsed" docker exec "${CURIO}" test -f /var/lib/curio/provider.ready
wait_for 600 "devnet-info.json for Synapse" docker exec "${CLIENT}" test -s /var/lib/contracts/devnet-info.json
ok "PDP provider ready ($(docker exec "${CURIO}" sh -c 'ls -a /var/lib/curio | grep -c "^\.init\.pdp"') PDP init markers)"
SQL "SELECT config FROM curio.harmony_config WHERE title='market'" | grep -q '"curio:12310"' ||
  die "SSRFAllowedHosts does not allow curio:12310"
PDP=$(docker exec "${CURIO}" jq -r .contracts.pdp_verifier /var/lib/contracts/contract_addresses.json)
# eth_call exactly at the upgrade epoch is refused by Lotus ("state fork at epoch 200"); retry briefly.
for _ in 1 2 3 4 5 6; do v=$(CAST "${PDP}" 'VERSION()(string)' 2>/dev/null) && break; sleep 10; done
ok "SSRF allow-list ok; PDPVerifier ${PDP} version ${v:-?}"

# ---------------------------------------------------------------- 1. client tooling
step "1. Synapse SDK ${SYNAPSE_TAG} (client)"
if ! CLI "test -f synapse-sdk/.built-${SYNAPSE_TAG}"; then
  CLI "set -e; [ -d synapse-sdk ] || git clone -q https://github.com/FilOzone/synapse-sdk.git synapse-sdk
       cd synapse-sdk && git checkout -q ${SYNAPSE_TAG} && export CI=true
       npx -y pnpm@11.24.0 install --frozen-lockfile >/dev/null && npx -y pnpm@11.24.0 build >/dev/null
       touch .built-${SYNAPSE_TAG}"
fi
ok "synapse-sdk $(CLI 'git -C synapse-sdk rev-parse --short HEAD')"

# ---------------------------------------------------------------- 2. data
step "2. Client data: two raw objects (random bytes, tar backup) and one CAR"
CLI "set -e; rm -rf ${CW} && mkdir -p ${CW}/car
     head -c 1500000 /dev/urandom > ${CW}/random.bin
     tar -cf ${CW}/backup.tar -C / etc 2>/dev/null || true
     sptool --actor t01000 toolbox mk12-client generate-rand-car -s 99700 ${CW}/car >/dev/null
     mv ${CW}/car/*.car ${CW}/child.car && rmdir ${CW}/car
     cd ${CW} && sha256sum random.bin backup.tar child.car > sha256.txt"
CLI "cat ${CW}/sha256.txt" | tee "${WORK}/sha256.txt"
FILES=(random.bin backup.tar child.car)
FORMATS=(raw raw car)
declare -A CID
for f in "${FILES[@]}"; do
  CID[$f]=$(CLI "sptool --actor ${PROVIDER} toolbox mk20-client commp ${CW}/$f" | awk '/CommP CID/ {print $3}')
  [[ ${CID[$f]} == bafkzcib* ]] || die "commp failed for $f"
  ok "$f -> ${CID[$f]}"
done

# ---------------------------------------------------------------- 3. PDP upload
step "3. Upload to PDP via Synapse (one call, one data set)"
# Synapse tops up the Filecoin Pay deposit with an ERC-2612 permit, which the devnet's mock USDFC
# cannot do (no nonces()). After several uploads on one devnet the deposit runs out, so top it up
# with a plain approve + deposit first.
INFO=/var/lib/contracts/devnet-info.json
read -r USER_KEY USER_ADDR USDFC PAY < <(docker exec "${CURIO}" jq -r \
  '.info | "\(.users[0].private_key_hex) \(.users[0].evm_addr) \(.contracts.mockusdfc_addr) \(.contracts.filecoin_pay_v1_addr)"' "${INFO}")
funds=$(CAST "${PAY}" 'accounts(address,address)(uint256,uint256,uint256,uint256)' "${USDFC}" "${USER_ADDR}" | head -1 | awk '{print $1}')
if [[ ${funds} =~ ^[0-9]+$ ]] && ((${#funds} < 19)); then # less than 1 USDFC (18 decimals)
  for call in "${USDFC} approve(address,uint256) ${PAY} 10000000000000000000" \
              "${PAY} deposit(address,address,uint256) ${USDFC} ${USER_ADDR} 10000000000000000000"; do
    # shellcheck disable=SC2086
    docker exec "${CURIO}" cast send --rpc-url http://lotus:1234/rpc/v1 --private-key "${USER_KEY}" ${call} >/dev/null ||
      die "Filecoin Pay top-up failed"
  done
  ok "Filecoin Pay deposit topped up with 10 USDFC (approve + deposit)"
fi
CLI "cd synapse-sdk && NETWORK=devnet DEVNET_INFO_PATH=/var/lib/contracts/devnet-info.json \
     node utils/example-storage-e2e.js ${CW}/random.bin ${CW}/backup.tar ${CW}/child.car" >"${WORK}/synapse.log" 2>&1 ||
  { tail -20 "${WORK}/synapse.log"; die "Synapse upload failed"; }
grep -q "=== SUCCESS" "${WORK}/synapse.log" || die "Synapse did not report SUCCESS"
grep -E "pieceId|VERIFIED" "${WORK}/synapse.log" | sed 's/^/  /'
DATASET=$(grep -o 'dataSetId: [0-9]*' "${WORK}/synapse.log" | head -1 | awk '{print $2}')

# ---------------------------------------------------------------- 4. verify PDP
step "4. Verify: bytes served by the PDP SP and data set on-chain"
for f in "${FILES[@]}"; do
  for _ in $(seq 1 12); do curl -fsS -o "${WORK}/$f" "${HOST_PIECE}/${CID[$f]}" 2>/dev/null && break; sleep 5; done
  want=$(awk -v f="$f" '$2 == f {print $1}' "${WORK}/sha256.txt")
  got=$(shasum -a 256 "${WORK}/$f" | awk '{print $1}')
  [[ ${want} == "${got}" ]] || die "$f served by PDP SP differs from original"
  ok "$f: /piece/ bytes identical (sha256 ${got:0:16}…)"
done
ok "data set ${DATASET}: live=$(CAST "${PDP}" 'dataSetLive(uint256)(bool)' "${DATASET}") nextPieceId=$(CAST "${PDP}" 'getNextPieceId(uint256)(uint256)' "${DATASET}" | awk '{print $1}') nextChallenge=$(CAST "${PDP}" 'getNextChallengeEpoch(uint256)(uint256)' "${DATASET}" | awk '{print $1}')"
PROVEN_BEFORE=$(CAST "${PDP}" 'getDataSetLastProvenEpoch(uint256)(uint256)' "${DATASET}" | awk '{print $1}')

# ---------------------------------------------------------------- 5. expected aggregate
step "5. Expected PoDSI aggregate, computed by the client"
AGG_ARGS=$(printf -- " --files ${CW}/%s" "${FILES[@]}")
size=8388608
out=$(CLI "cd ${CW} && sptool --actor ${PROVIDER} toolbox mk20-client aggregate --out=false --piece-size ${size}${AGG_ARGS}" 2>&1 || true)
if [[ ${out} == *"deal size mismatch"* ]]; then
  size=$(grep -o 'got [0-9]*' <<<"${out}" | awk '{print $2}')
  out=$(CLI "cd ${CW} && sptool --actor ${PROVIDER} toolbox mk20-client aggregate --out=false --piece-size ${size}${AGG_ARGS}")
fi
EXPECTED=$(awk '/CommP CID/ {print $3}' <<<"${out}")
[[ ${EXPECTED} == bafkzcib* ]] || die "could not compute expected aggregate: ${out}"
ok "aggregate ${size} B padded -> ${EXPECTED}"

# ---------------------------------------------------------------- 6. deal
step "6. Manifest (children fetched from ${PDP_PIECE_BASE}) and DDO deal"
manifest=""
for i in "${!FILES[@]}"; do
  f=${FILES[$i]}
  manifest+="${CID[$f]}"$'\t'"${PDP_PIECE_BASE}/piece/${CID[$f]}"$'\t'"${FORMATS[$i]}"$'\n'
done
printf '%s' "${manifest}" | docker exec -i "${CLIENT}" sh -c "cat > ${CW}/manifest.tsv"
printf '%s' "${manifest}" | tee "${WORK}/manifest.tsv" | cut -c1-110 | sed 's/^/  /'
deal_out=$(CLI "sptool --verbose --actor ${PROVIDER} toolbox mk20-client deal --provider ${PROVIDER} \
  --pcidv2 ${EXPECTED} --aggregate ${CW}/manifest.tsv --duration 518400 --indexing=true --announce=false" 2>&1)
DEAL=$(grep -o '"id": "[0-9A-Z]*"' <<<"${deal_out}" | head -1 | cut -d'"' -f4)
[[ -n ${DEAL} ]] || { echo "${deal_out}" | tail -5; die "deal not created"; }
ok "deal ${DEAL} sent to ${PROVIDER}"
DEAL_AT=$(SQLP "SELECT created_at FROM curio.market_mk20_deal WHERE id='${DEAL}'")
SQLP "SELECT data::text FROM curio.market_mk20_deal WHERE id='${DEAL}'" |
  jq -r '.source_aggregate.pieces[] | "  child \(.piece_cid["/"][0:24])… format=\(.format | keys[0])"'

# ---------------------------------------------------------------- 7. sealing
step "7. SP: download, aggregate, seal (polling every 30 s)"
last="" SECTOR="" AGG_V1=""
for _ in $(seq 1 90); do
  row=$(SQLP "SELECT aggregated, coalesce(sector::text,''), coalesce(piece_cid,''), sealed, indexed, complete
             FROM curio.market_mk20_pipeline WHERE id='${DEAL}' ORDER BY aggr_index LIMIT 1")
  failed=$(SQLP "SELECT coalesce(string_agg(failed_reason, ';'),'') FROM curio.sectors_sdr_pipeline WHERE failed")
  [[ -z ${failed} ]] || die "sealing failed: ${failed}"
  [[ ${row} != "${last}" ]] && { printf '  %s  aggregated|sector|piece_cid|sealed|indexed|complete = %s\n' "$(date +%T)" "${row}"; last=${row}; }
  IFS='|' read -r _ s pc _ _ fin <<<"${row}"
  [[ -n ${s} ]] && SECTOR=${s} AGG_V1=${pc}
  [[ ${fin} == t ]] && break
  sleep 30
done
[[ ${fin:-} == t && -n ${SECTOR} ]] || die "deal did not complete"
ok "deal complete in sector ${SECTOR}"

if [[ ${TWO_NODE:-0} == 1 ]]; then
  step "7b. Transfers: PDP node -> PoRep node (one fetch per child expected)"
  [[ $(SQL "SELECT count(*) FROM curio.market_mk20_deal WHERE id='${DEAL}'") == 0 ]] &&
    ok "PDP node never saw the deal (it only served /piece/)"
  SQLP "SELECT count(*) FILTER (WHERE result), count(*) FILTER (WHERE NOT result), coalesce(string_agg(DISTINCT left(err,80), ' | ') FILTER (WHERE NOT result),'')
        FROM curio.harmony_task_history WHERE name='ParkPiece' AND work_start >= '${DEAL_AT}'" |
    { IFS='|' read -r good bad errs
      printf '  ParkPiece on PoRep node since deal: %s successful, %s failed %s\n' "${good}" "${bad}" "${errs:+(${errs})}"
      [[ ${good} == "${#FILES[@]}" ]] && ok "exactly ${#FILES[@]} successful downloads for ${#FILES[@]} children" ||
        printf '  WARN expected %s successful downloads, got %s\n' "${#FILES[@]}" "${good}"; }
fi

# ---------------------------------------------------------------- 8. chain
step "8. On-chain: sector ${SECTOR} messages and status"
docker exec "${CURIO}" sptool --actor "${PROVIDER}" sectors status "${SECTOR}" |
  grep -E "Activation|Sector Type|QAPower" | sed 's/^/  /'
# Bounded range: on a long-running devnet Lotus no longer has the state of old tipsets.
chain=$(docker exec "${LOTUS}" sh -c "H=\$(lotus chain head --height); lotus state list-messages --to ${PROVIDER} --toheight \$(( H > 2000 ? H - 2000 : 0 )) |
  jq -s -r '.[] | select(.Method==28 or .Method==34) | \"\(.Method) \(.Params)\"' |
  while read m p; do lotus chain decode params --encoding=base64 ${PROVIDER} \$m \"\$p\"; done")
UNSEALED=$(jq -r --argjson s "${SECTOR}" '.Sectors[]? | select(.SectorNumber == $s) | .UnsealedCid["/"]' <<<"${chain}" | head -1)
jq -c --argjson s "${SECTOR}" '.SectorActivations[]? | select(.SectorNumber == $s) |
  {sector: .SectorNumber, pieces: [.Pieces[] | {cid: .CID["/"], size: .Size, datacap: .VerifiedAllocationKey}]}' <<<"${chain}" | sed 's/^/  ProveCommit: /'
[[ ${UNSEALED} == baga* ]] || die "PreCommit UnsealedCid of sector ${SECTOR} not found on chain"
ok "PreCommit UnsealedCid (sector CommD) ${UNSEALED}"
SECTOR_BYTES=$(curl -fsS -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"Filecoin.StateMinerInfo\",\"params\":[\"${PROVIDER}\",null]}" \
  http://127.0.0.1:2234/rpc/v1 | jq -r .result.SectorSize)
[[ ${SECTOR_BYTES} =~ ^[0-9]+$ ]] || die "could not read sector size"

# ---------------------------------------------------------------- 9. podsicheck
step "9. PoDSI verification of the sealed aggregate (podsicheck, go-data-segment)"
AGG_ID=$(SQLP "SELECT id FROM curio.parked_pieces WHERE piece_cid='${AGG_V1}' AND long_term ORDER BY id DESC LIMIT 1")
docker cp "${POREP_CONTAINER}:/var/lib/curio/piece/s-t00-${AGG_ID}" "${WORK}/aggregate.bin" >/dev/null
docker run --rm -v podsi-gomod:/go/pkg/mod -v podsi-gocache:/root/.cache/go-build \
  -v "${ROOT}/docs/pdp-podsi-porep/podsicheck:/src:ro" -v "${WORK}:/data:ro" -w /tmp "${GO_IMAGE}" sh -c \
  "cp -r /src /tmp/pc && cd /tmp/pc && go build -o /tmp/podsicheck . && \
   SECTOR_SIZE=${SECTOR_BYTES} SECTOR_COMMD=${UNSEALED} /tmp/podsicheck /data/aggregate.bin ${size} ${EXPECTED} \
   $(for f in "${FILES[@]}"; do printf '%s ' "${CID[$f]}"; done)" | tee "${WORK}/podsicheck.txt" | sed 's/^/  /'
grep -q "equals on-chain UnsealedCid: true" "${WORK}/podsicheck.txt" || die "podsicheck failed"

# ---------------------------------------------------------------- 10. PDP keeps proving
step "10. PDP keeps proving the same data set (waits up to 10 min)"
for _ in $(seq 1 60); do
  now=$(CAST "${PDP}" 'getDataSetLastProvenEpoch(uint256)(uint256)' "${DATASET}" | awk '{print $1}')
  [[ ${now} -gt ${PROVEN_BEFORE} ]] && break
  sleep 10
done
[[ ${now} -gt ${PROVEN_BEFORE} ]] && ok "data set ${DATASET} proven at epoch ${now} (before: ${PROVEN_BEFORE})" ||
  printf '  WARN no new PDP proof yet (last %s)\n' "${now}"

if [[ ${TWO_NODE:-0} == 1 ]]; then
  step "11. Tampered source: same length, different bytes (PoRep node must reject at CommP)"
  # A different file of exactly the same length, stored in PDP on node A; the CIDv2 length check
  # passes, so only CommP verification on the PoRep node can catch the substitution.
  CLI "head -c \$(stat -c %s ${CW}/random.bin) /dev/urandom > ${CW}/impostor.bin"
  IMPOSTOR=$(CLI "sptool --actor ${PROVIDER} toolbox mk20-client commp ${CW}/impostor.bin" | awk '/CommP CID/ {print $3}')
  CLI "cd synapse-sdk && NETWORK=devnet DEVNET_INFO_PATH=/var/lib/contracts/devnet-info.json \
       node utils/example-storage-e2e.js ${CW}/impostor.bin" >"${WORK}/synapse-impostor.log" 2>&1 ||
    die "impostor upload to PDP failed"
  bad_manifest="${CID[random.bin]}"$'\t'"${PDP_PIECE_BASE}/piece/${IMPOSTOR}"$'\t'raw$'\n'
  bad_manifest+="${CID[child.car]}"$'\t'"${PDP_PIECE_BASE}/piece/${CID[child.car]}"$'\t'car$'\n'
  printf '%s' "${bad_manifest}" | docker exec -i "${CLIENT}" sh -c "cat > ${CW}/bad.tsv"
  bad_size=8388608
  bad_out=$(CLI "cd ${CW} && sptool --actor ${PROVIDER} toolbox mk20-client aggregate --out=false --piece-size ${bad_size} --files random.bin --files child.car" 2>&1 || true)
  if [[ ${bad_out} == *"deal size mismatch"* ]]; then
    bad_size=$(grep -o 'got [0-9]*' <<<"${bad_out}" | awk '{print $2}')
    bad_out=$(CLI "cd ${CW} && sptool --actor ${PROVIDER} toolbox mk20-client aggregate --out=false --piece-size ${bad_size} --files random.bin --files child.car" 2>&1)
  fi
  BAD_EXPECTED=$(awk '/CommP CID/ {print $3}' <<<"${bad_out}")
  bad_deal=$(CLI "sptool --verbose --actor ${PROVIDER} toolbox mk20-client deal --provider ${PROVIDER} \
    --pcidv2 ${BAD_EXPECTED} --aggregate ${CW}/bad.tsv --duration 518400 --indexing=true --announce=false" 2>&1 || true)
  BAD=$(grep -o '"id": "[0-9A-Z]*"' <<<"${bad_deal}" | head -1 | cut -d'"' -f4)
  [[ -n ${BAD} ]] || die "tampered deal was not submitted: $(grep -E 'ERROR|WARN' <<<"${bad_deal}" | tail -1 | cut -c1-150)"
  ok "tampered deal ${BAD}: child ${CID[random.bin]:0:24}… served from ${IMPOSTOR:0:24}…"
  BAD_AT=$(SQLP "SELECT created_at FROM curio.market_mk20_deal WHERE id='${BAD}'")
  rejected=""
  for _ in $(seq 1 40); do
    agg=$(SQLP "SELECT coalesce(bool_or(aggregated), false) FROM curio.market_mk20_pipeline WHERE id='${BAD}'")
    [[ ${agg} == t ]] && die "tampered deal ${BAD} was aggregated"
    rejected=$(SQLP "SELECT left(replace(err,E'\n',' '),160) FROM curio.harmony_task_history
                     WHERE work_start >= '${BAD_AT}' AND NOT result AND err ILIKE '%mismatch%' LIMIT 1")
    [[ -n ${rejected} ]] && break
    sleep 15
  done
  [[ -n ${rejected} ]] && ok "tampered child rejected by PoRep node: ${rejected}" ||
    die "tampered deal ${BAD} neither aggregated nor rejected within 10 min"
fi

step "PASS: PDP -> PoDSI -> PoRep (PDP ${PDP_PROVIDER}, PoRep ${PROVIDER}, data set ${DATASET}, deal ${DEAL}, sector ${SECTOR})"
echo "evidence: ${WORK}"
