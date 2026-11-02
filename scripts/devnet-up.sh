#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/devnet-common.sh"
devnet_require_command docker
devnet_require_command lsof
[[ -f "${DEVNET_COMPOSE}" ]] || devnet_die "compose file is missing"
devnet_prepare_runtime
devnet_write_compose_env
devnet_check_start_ports
devnet_inspect_rendered_compose >/dev/null
node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms "${DEVNET_LIFECYCLE_TIMEOUT_MS}" -- \
  bash -c 'source "$1"; devnet_compose up --detach' devnet-up "${DEVNET_ROOT}/scripts/devnet-common.sh"

[[ -n "${DEVNET_TEST_COMMAND_LOG:-}" ]] && exit 0

for _ in {1..150}; do
  config_state="$(
    devnet_compose exec -T yugabyte ysqlsh -h yugabyte -U yugabyte -d yugabyte -At -c "
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM curio.harmony_config
          WHERE title = 'market'
            AND config LIKE '%ParkPieceMinFreeStoragePercent = 0%'
            AND config LIKE '%SSRFAllowedHosts = [\"piece-server:12320\", \"curio:12310\"]%'
        ) THEN 'configured'
        WHEN EXISTS (
          SELECT 1 FROM curio.harmony_config WHERE title = 'market'
        ) THEN 'pending'
        ELSE 'absent'
      END
    " 2>/dev/null || true
  )"
  if [[ "${config_state}" == "pending" ]]; then
    devnet_compose exec -T yugabyte ysqlsh -h yugabyte -U yugabyte -d yugabyte -q -c "
      UPDATE curio.harmony_config
      SET config = replace(
        config,
        E'[Ingest]\\n',
        E'[Ingest]\\n    SSRFAllowedHosts = [\"piece-server:12320\", \"curio:12310\"]\\n'
      )
      WHERE title = 'market'
        AND config NOT LIKE '%SSRFAllowedHosts%'
    " >/dev/null 2>&1 || { sleep 2; continue; }
    # Migrate an older allow-list in place; the insert above only covers a missing key.
    devnet_compose exec -T yugabyte ysqlsh -h yugabyte -U yugabyte -d yugabyte -q -c "
      UPDATE curio.harmony_config
      SET config = regexp_replace(
        config,
        'SSRFAllowedHosts = \\[[^]]*\\]',
        'SSRFAllowedHosts = [\"piece-server:12320\", \"curio:12310\"]'
      )
      WHERE title = 'market'
        AND config LIKE '%SSRFAllowedHosts%'
        AND config NOT LIKE '%SSRFAllowedHosts = [\"piece-server:12320\", \"curio:12310\"]%'
    " >/dev/null 2>&1 || { sleep 2; continue; }
    devnet_compose exec -T yugabyte ysqlsh -h yugabyte -U yugabyte -d yugabyte -q -c "
      UPDATE curio.harmony_config
      SET config = replace(
        config,
        E'[Subsystems]\\n',
        E'[Subsystems]\\n    ParkPieceMinFreeStoragePercent = 0\\n'
      )
      WHERE title = 'market'
        AND config NOT LIKE '%ParkPieceMinFreeStoragePercent%'
    " >/dev/null 2>&1 || { sleep 2; continue; }
    devnet_compose restart curio >/dev/null
    exit 0
  fi
  [[ "${config_state}" == "configured" ]] && exit 0
  sleep 2
done

devnet_die "Curio market config was not created within 300 seconds"
