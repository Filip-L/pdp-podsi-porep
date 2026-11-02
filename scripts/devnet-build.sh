#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/devnet-common.sh"

if [[ "${DEVNET_BUILD_TIMEOUT_ACTIVE:-0}" != 1 ]]; then
  export DEVNET_BUILD_TIMEOUT_ACTIVE=1
  exec node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" \
    --timeout-ms "${DEVNET_BUILD_TIMEOUT_MS}" \
    -- bash "${DEVNET_ROOT}/scripts/devnet-build.sh"
fi

cd "${DEVNET_ROOT}"
devnet_require_command docker
devnet_require_command node
devnet_require_command npm
devnet_require_command shasum

mkdir -p "${DEVNET_BUILD_DIR}" "${DEVNET_LOG_DIR}"
build_started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
build_started_epoch="$(date '+%s')"
build_log_relative=".runtime/devnet/logs/build-${build_started_epoch}.log"
build_log="${DEVNET_ROOT}/${build_log_relative}"
exec > >(devnet_sanitize_build_log | tee -a "${build_log}") 2>&1

build_succeeded=0
on_exit() {
  local exit_code=$?
  if ((build_succeeded == 0)); then
    printf 'build failed with exit %d; retained log: %s\n' \
      "${exit_code}" "${build_log_relative}" >&2
  fi
}
trap on_exit EXIT

printf 'build start=%s log=%s\n' "${build_started_at}" "${build_log_relative}"

docker_version="$(docker version --format 'client={{.Client.Version}} server={{.Server.Version}}')"
docker_architecture_raw="$(docker info --format '{{.Architecture}}')"
docker_architecture="$(devnet_normalize_architecture "${docker_architecture_raw}")"
docker_memory_bytes="$(docker info --format '{{.MemTotal}}')"
docker_cpu_count="$(docker info --format '{{.NCPU}}')"
host_free_bytes="$(df -Pk "${DEVNET_ROOT}" | awk 'NR == 2 { printf "%.0f", $4 * 1024 }')"
minimum_free_bytes=$((14 * 1024 * 1024 * 1024))
minimum_memory_bytes=$((7 * 1024 * 1024 * 1024))

[[ "${docker_memory_bytes}" =~ ^[0-9]+$ ]] || devnet_die "Docker reported invalid memory capacity"
[[ "${host_free_bytes}" =~ ^[0-9]+$ ]] || devnet_die "host filesystem reported invalid free capacity"
((docker_memory_bytes >= minimum_memory_bytes)) ||
  devnet_die "Docker memory ${docker_memory_bytes} is below required ${minimum_memory_bytes} bytes"
((host_free_bytes >= minimum_free_bytes)) ||
  devnet_die "host free space ${host_free_bytes} is below required ${minimum_free_bytes} bytes"

buildx_state="$(docker buildx inspect)"
grep -Eq "linux/${docker_architecture}([,[:space:]]|$)" <<<"${buildx_state}" ||
  devnet_die "active BuildKit builder does not support linux/${docker_architecture}"

printf 'resource docker="%s" platform=linux/%s cpus=%s memory_bytes=%s host_free_bytes=%s\n' \
  "${docker_version}" "${docker_architecture}" "${docker_cpu_count}" \
  "${docker_memory_bytes}" "${host_free_bytes}"

runtime_lock_output="$(npm --prefix tools run cli -- runtime lock verify)"
source_verify_output="$(npm --prefix tools run cli -- sources verify)"

declare -A image_references=()
declare -A tool_commits=()
declare -A tool_managed_sources=()
while IFS=$'\t' read -r record_kind record_name field_three field_four field_five; do
  case "${record_kind}" in
    image)
      image_references["${record_name}"]="${field_three}"
      ;;
    tool)
      if [[ -n "${field_four:-}" ]]; then
        tool_commits["${record_name}"]="${field_four}"
      fi
      if [[ "${field_five:-}" == managed-source=* ]]; then
        tool_managed_sources["${record_name}"]="${field_five#managed-source=}"
      fi
      ;;
  esac
done <<<"${runtime_lock_output}"

curio_commit=""
lotus_commit=""
blst_commit=""
curio_source_reported=""
blst_source_reported=""
curio_state=""
lotus_state=""
blst_state=""
while IFS=$'\t' read -r source_name source_path expected_commit actual_commit detached_state clean_state _; do
  case "${source_name}" in
    blst)
      blst_commit="${expected_commit}"
      blst_source_reported="${source_path}"
      blst_state="${actual_commit}:${detached_state}:${clean_state}"
      ;;
    curio)
      curio_commit="${expected_commit}"
      curio_source_reported="${source_path}"
      curio_state="${actual_commit}:${detached_state}:${clean_state}"
      ;;
    lotus)
      lotus_commit="${expected_commit}"
      lotus_state="${actual_commit}:${detached_state}:${clean_state}"
      ;;
  esac
done <<<"${source_verify_output}"

[[ "${curio_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "typed source verification did not report Curio commit"
[[ "${lotus_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "typed source verification did not report Lotus commit"
[[ "${blst_commit}" =~ ^[0-9a-f]{40}$ ]] || devnet_die "typed source verification did not report BLST commit"
[[ "${curio_state}" == "${curio_commit}:detached:clean" ]] ||
  devnet_die "Curio managed source is not exact, detached, and clean"
[[ "${lotus_state}" == "${lotus_commit}:detached:clean" ]] ||
  devnet_die "Lotus managed source is not exact, detached, and clean"
[[ "${blst_state}" == "${blst_commit}:detached:clean" ]] ||
  devnet_die "BLST managed source is not exact, detached, and clean"
[[ "${tool_managed_sources[blst]:-}" == blst ]] ||
  devnet_die "typed runtime lock did not bind BLST to the blst managed source"
[[ "${tool_commits[blst]:-}" == "${blst_commit}" ]] ||
  devnet_die "typed BLST tool commit does not match the verified managed source"

curio_source="$(devnet_curio_source_path "${curio_commit}")"
blst_source="$(devnet_blst_source_path "${blst_commit}")"
curio_source_relative=".cache/sources/curio/${curio_commit}"
blst_source_relative=".cache/sources/blst/${blst_commit}"
lotus_source_relative=".cache/sources/lotus/${lotus_commit}"
[[ "${curio_source_reported}" == "${curio_source}" ]] ||
  devnet_die "typed Curio source path does not match the managed source path"
[[ "${blst_source_reported}" == "${blst_source}" ]] ||
  devnet_die "typed BLST source path does not match the managed source path"
[[ -d "${curio_source}" && ! -L "${curio_source}" ]] ||
  devnet_die "managed Curio source path is missing or symbolic"
[[ -d "${blst_source}" && ! -L "${blst_source}" ]] ||
  devnet_die "managed BLST source path is missing or symbolic"
[[ -d "${DEVNET_ROOT}/${lotus_source_relative}/extern/filecoin-ffi/rust" && ! -L "${DEVNET_ROOT}/${lotus_source_relative}" ]] ||
  devnet_die "managed Lotus source path or its filecoin-ffi submodule is missing"
for blst_input in build.sh build src bindings LICENSE; do
  [[ -e "${blst_source}/${blst_input}" && ! -L "${blst_source}/${blst_input}" ]] ||
    devnet_die "managed BLST source is missing required tracked input ${blst_input}"
done

for required_image in \
  yugabyte go_builder rust_toolchain ubuntu_runtime node_runtime foundry; do
  [[ "${image_references[${required_image}]:-}" =~ @sha256:[0-9a-f]{64}$ ]] ||
    devnet_die "typed runtime lock did not report immutable ${required_image} image"
done

for required_tool in go_car piece_server storetheindex go_ethereum blst; do
  [[ "${tool_commits[${required_tool}]:-}" =~ ^[0-9a-f]{40}$ ]] ||
    devnet_die "typed runtime lock did not report exact ${required_tool} commit"
done

dockerfile_relative="docker/curio-all-in-one.Dockerfile"
dockerfile="${DEVNET_ROOT}/${dockerfile_relative}"
dockerfile_sha256="$(devnet_build_inputs_sha256)"
curio_short_commit="${curio_commit:0:12}"
platform="linux/${docker_architecture}"

base_image="porep-market-curio-devnet/curio-all-in-one:${curio_short_commit}"
lotus_image="porep-market-curio-devnet/lotus:${curio_short_commit}"
contracts_bootstrap_image="porep-market-curio-devnet/contracts-bootstrap:${curio_short_commit}"
lotus_miner_image="porep-market-curio-devnet/lotus-miner:${curio_short_commit}"
curio_image="porep-market-curio-devnet/curio:${curio_short_commit}"
piece_server_image="porep-market-curio-devnet/piece-server:${curio_short_commit}"
indexer_image="porep-market-curio-devnet/indexer:${curio_short_commit}"

manifest_relative=".runtime/devnet/build/images.json"
manifest_path="${DEVNET_ROOT}/${manifest_relative}"
if [[ -f "${manifest_path}" && ! -L "${manifest_path}" ]] &&
  ( devnet_write_compose_env ) >/dev/null 2>&1; then
  printf 'reusing validated local images manifest=%s\n' "${manifest_relative}"
  build_succeeded=1
  exit 0
fi

manifest_history_directory="${DEVNET_BUILD_DIR}/history"
archive_name="images.before-${build_started_epoch}-${BASHPID}.json"
archived_manifest="$(
  devnet_archive_active_manifest \
    "${manifest_path}" "${manifest_history_directory}" "${archive_name}"
)"
if [[ -n "${archived_manifest}" ]]; then
  printf 'archived previous manifest=%s\n' "${archived_manifest#"${DEVNET_ROOT}/"}"
fi

printf 'building %s from verified context %s\n' \
  "${base_image}" "${curio_source_relative}"
docker buildx build \
  --load \
  --provenance=false \
  --platform "${platform}" \
  --progress plain \
  --file "${dockerfile_relative}" \
  --target curio-all-in-one \
  --build-context "blst-source=${blst_source_relative}" \
  --build-context "lotus-source=${lotus_source_relative}" \
  --build-context "harness-overlay=." \
  --build-arg "GO_BUILDER_IMAGE=${image_references[go_builder]}" \
  --build-arg "RUST_TOOLCHAIN_IMAGE=${image_references[rust_toolchain]}" \
  --build-arg "UBUNTU_RUNTIME_IMAGE=${image_references[ubuntu_runtime]}" \
  --build-arg "NODE_RUNTIME_IMAGE=${image_references[node_runtime]}" \
  --build-arg "FOUNDRY_IMAGE=${image_references[foundry]}" \
  --build-arg "CURIO_COMMIT=${curio_commit}" \
  --build-arg "CURIO_FFI_COMMIT=f9b4aecf63c4ee7c90119693aad3fed947856527" \
  --build-arg "CURIO_TAGS=cunative debug nosupraseal" \
  --build-arg "GO_CAR_COMMIT=${tool_commits[go_car]}" \
  --build-arg "PIECE_SERVER_COMMIT=${tool_commits[piece_server]}" \
  --build-arg "STORETHEINDEX_COMMIT=${tool_commits[storetheindex]}" \
  --build-arg "GO_ETHEREUM_COMMIT=${tool_commits[go_ethereum]}" \
  --build-arg "LOTUS_COMMIT=${lotus_commit}" \
  --build-arg "BLST_COMMIT=${blst_commit}" \
  --build-arg "DOCKERFILE_SHA256=${dockerfile_sha256}" \
  --tag "${base_image}" \
  "${curio_source_relative}"

derived_builds=(
  "docker/lotus/Dockerfile|docker/lotus|${lotus_image}"
  "docker/contracts-bootstrap/Dockerfile|docker/contracts-bootstrap|${contracts_bootstrap_image}"
  "docker/lotus-miner/Dockerfile|docker/lotus-miner|${lotus_miner_image}"
  "docker/curio/Dockerfile|docker/curio|${curio_image}"
  "docker/piece-server/Dockerfile|docker/piece-server|${piece_server_image}"
  "docker/indexer/Dockerfile|docker/indexer|${indexer_image}"
)

for derived_build in "${derived_builds[@]}"; do
  IFS='|' read -r relative_dockerfile relative_context derived_image <<<"${derived_build}"
  context_path="${curio_source_relative}/${relative_context}"
  if [[ "${relative_context}" == docker/contracts-bootstrap ]]; then
    # filecoin-services v1.5+ renamed FWSS deployment keys; patch a copy, never the verified source.
    context_patch="${DEVNET_ROOT}/patches/curio/0003-contracts-bootstrap-fwss-erc8167-addresses.patch"
    context_path=".runtime/devnet/build/contexts/contracts-bootstrap"
    rm -rf "${context_path}"
    mkdir -p "${context_path}"
    cp -R "${curio_source_relative}/${relative_context}/." "${context_path}/"
    patch -p3 --batch --forward --dry-run -d "${context_path}" <"${context_patch}" >/dev/null ||
      devnet_die "contracts-bootstrap patch does not apply to the verified Curio context"
    patch -p3 --batch --forward -d "${context_path}" <"${context_patch}" >/dev/null
  fi
  printf 'building %s from verified upstream service context %s\n' \
    "${derived_image}" "${context_path}"
  docker buildx build \
    --load \
    --provenance=false \
    --platform "${platform}" \
    --progress plain \
    --file "${relative_dockerfile}" \
    --build-arg "CURIO_TEST_IMAGE=${base_image}" \
    --build-arg "BUILD_VERSION=${curio_short_commit}" \
    --tag "${derived_image}" \
    "${context_path}"
done

images=(
  "${base_image}"
  "${lotus_image}"
  "${contracts_bootstrap_image}"
  "${lotus_miner_image}"
  "${curio_image}"
  "${piece_server_image}"
  "${indexer_image}"
)
inspect_evidence="${DEVNET_BUILD_DIR}/images.inspect.${build_started_epoch}.ndjson"
: > "${inspect_evidence}"
for image in "${images[@]}"; do
  docker image inspect "${image}" --format '{{json .}}' >> "${inspect_evidence}"
done

build_finished_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
build_finished_epoch="$(date '+%s')"
build_duration_seconds=$((build_finished_epoch - build_started_epoch))
manifest_temporary="$(mktemp "${DEVNET_BUILD_DIR}/images.json.XXXXXX")"

node - "${inspect_evidence}" "${manifest_temporary}" \
  "${build_started_at}" "${build_finished_at}" "${build_duration_seconds}" \
  "${platform}" "${curio_commit}" "${lotus_commit}" "${blst_commit}" "${dockerfile_sha256}" \
  "${curio_short_commit}" "${DEVNET_IMAGE_NAMESPACE}" <<'NODE'
const fs = require("node:fs");

const [
  inspectPath,
  outputPath,
  startedAt,
  finishedAt,
  durationText,
  platform,
  curioCommit,
  lotusCommit,
  blstCommit,
  dockerfileSha256,
  tag,
  namespace,
] = process.argv.slice(2);
const expectedLabels = {
  "io.porep-market.curio.commit": curioCommit,
  "io.porep-market.lotus.commit": lotusCommit,
  "io.porep-market.blst.commit": blstCommit,
  "io.porep-market.dockerfile.sha256": dockerfileSha256,
};
const inspections = fs.readFileSync(inspectPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (inspections.length !== 7) {
  throw new Error(`expected 7 built image inspections, found ${inspections.length}`);
}
const images = inspections.map((inspection) => {
  const labels = inspection.Config?.Labels ?? {};
  const volumes = inspection.Config?.Volumes ?? {};
  if (Object.keys(volumes).length !== 0) {
    throw new Error(
      `${inspection.RepoTags?.[0] ?? inspection.Id} declares unexpected image volumes`,
    );
  }
  for (const [name, value] of Object.entries(expectedLabels)) {
    if (labels[name] !== value) {
      throw new Error(`${inspection.RepoTags?.[0] ?? inspection.Id} has invalid ${name}`);
    }
  }
  if (`${inspection.Os}/${inspection.Architecture}` !== platform) {
    throw new Error(`${inspection.RepoTags?.[0] ?? inspection.Id} has invalid platform`);
  }
  const reference = inspection.RepoTags?.find((candidate) =>
    candidate.startsWith(`${namespace}/`) && candidate.endsWith(`:${tag}`));
  if (reference === undefined) {
    throw new Error(`${inspection.Id} is missing the exact namespaced tag`);
  }
  return {
    reference,
    id: inspection.Id,
    os: inspection.Os,
    architecture: inspection.Architecture,
    labels: expectedLabels,
  };
});
const manifest = {
  schemaVersion: 1,
  namespace,
  tag,
  platform,
  curioCommit,
  lotusCommit,
  blstCommit: blstCommit,
  dockerfileSha256,
  startedAt,
  finishedAt,
  durationSeconds: Number(durationText),
  images,
};
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
NODE

devnet_publish_manifest "${manifest_temporary}" "${manifest_path}"
printf 'build complete finish=%s duration_seconds=%s manifest=%s\n' \
  "${build_finished_at}" "${build_duration_seconds}" "${manifest_relative}"
node -e '
  const manifest = require(process.argv[1]);
  for (const image of manifest.images) {
    console.log(`${image.reference}\t${image.id}\t${image.os}/${image.architecture}`);
  }
' "${manifest_path}"

build_succeeded=1
