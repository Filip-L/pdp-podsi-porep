import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioContext } from "../runtime.js";
import { envNumber } from "../runtime.js";
import { run, sleep } from "../shell.js";
import type { PieceInfo } from "./piece.js";
import { sectorEvidenceNotificationPayloadHex as buildSectorEvidenceNotificationPayloadHex } from "../fixtures/sectorEvidencePieceSet.js";
import { dockerExec, dockerExecEnv, requireDevnet } from "./docker.js";

type CurioStatus = {
  generation?: unknown;
  chain?: { networkVersion?: unknown; actorsVersion?: unknown };
  miner?: { provider?: unknown; sectorSize?: unknown };
  curio?: {
    apiReady?: unknown;
    marketReady?: unknown;
    databaseReady?: unknown;
    taskCount?: unknown;
  };
};

export type Mk20DealInput = {
  provider: string;
  pieceCidV2: string;
  allocationId: bigint;
  notificationAddress: string;
  notificationPayload: string;
  marketAddress?: string;
  marketDealId?: bigint;
};

export function notificationPayloadHex(id: bigint): string {
  if (id < 0n || id > 0xffff_ffff_ffff_ffffn) {
    throw new Error("notification payload ID must fit in uint64");
  }
  return `01${id.toString(16).padStart(16, "0")}`;
}

export function postDataCapNotificationPayloadHex(
  allocationId: bigint,
  porepDealId: bigint,
): string {
  if (allocationId < 0n || allocationId > 0xffff_ffff_ffff_ffffn) {
    throw new Error("notification allocation ID must fit in uint64");
  }
  if (porepDealId < 0n || porepDealId >= 1n << 256n) {
    throw new Error("notification PoRep deal ID must fit in uint256");
  }
  return `02${allocationId.toString(16).padStart(16, "0")}${porepDealId.toString(16).padStart(64, "0")}`;
}

export function decodePostDataCapNotificationPayload(payload: string): {
  allocationId: bigint;
  porepDealId: bigint;
} {
  const hex = payload.startsWith("0x") ? payload.slice(2) : payload;
  if (!/^[0-9a-fA-F]{82}$/.test(hex) || hex.slice(0, 2) !== "02") {
    throw new Error("invalid post-DataCap notification payload");
  }
  return {
    allocationId: BigInt(`0x${hex.slice(2, 18)}`),
    porepDealId: BigInt(`0x${hex.slice(18)}`),
  };
}

export function buildMk20DealArgs(input: Mk20DealInput): string[] {
  const args = [
    "sptool", "--actor", input.provider, "toolbox", "mk20-client", "deal",
    "--provider", input.provider,
    "--http-url", `http://piece-server:12320/pieces?id=${input.pieceCidV2}`,
    "--pcidv2", input.pieceCidV2,
    "--allocation", input.allocationId.toString(),
    "--notification-address", input.notificationAddress,
    "--notification-payload", input.notificationPayload,
  ];
  if (input.marketAddress) args.push("--market-address", input.marketAddress);
  if (input.marketDealId !== undefined) {
    args.push("--market-deal-id", input.marketDealId.toString());
  }
  return args;
}

export function parseAllocationId(output: string, pieceCid: string): bigint {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("allocation list did not contain JSON");
  const parsed = JSON.parse(output.slice(start)) as {
    allocations?: Record<string, { Data?: { "/"?: unknown } }>;
  };
  const matches = Object.entries(parsed.allocations ?? {})
    .filter(([, allocation]) => allocation.Data?.["/"] === pieceCid)
    .map(([id]) => BigInt(id))
    .sort((left, right) => left < right ? 1 : left > right ? -1 : 0);
  if (matches.length === 0) throw new Error(`allocation not found for piece ${pieceCid}`);
  return matches[0]!;
}

export function createCurioAllocation(
  context: ScenarioContext,
  piece: PieceInfo,
): { allocationId: bigint; messageCid?: string } {
  ensureCurioReady(context);
  const providerEnv = { SP_ADDRESS: context.config.provider };
  const output = dockerExecEnv(context, "piece-server", providerEnv, [
    "sptool", "toolbox", "mk12-client", "allocate",
    "-y", "-p", context.config.provider,
    "--piece-cid", piece.pieceCid,
    "--piece-size", piece.pieceSize.toString(),
    "--confidence", "0",
    "--json",
  ]);
  const allocations = dockerExecEnv(context, "piece-server", providerEnv, [
    "sptool", "toolbox", "mk12-client", "list-allocations", "-j",
  ]);
  const result: { allocationId: bigint; messageCid?: string } = {
    allocationId: parseAllocationId(allocations, piece.pieceCid),
  };
  const messageCid = output.match(/sent message:\s+(\S+)/)?.[1];
  if (messageCid) result.messageCid = messageCid;
  return result;
}

export type CurioNotificationDeal = {
  dealId: string;
  allocationId: bigint;
  allocationMessageCid?: string;
  notificationAddress: string;
  notificationPayload: string;
  submissionOutput: string;
};

export type CurioSectorEvidenceDeal = CurioNotificationDeal & {
  pieceIndex: number;
  pieceCount: number;
};

export function sectorEvidenceNotificationPayloadHex(
  dealId: bigint,
  pieceIndex: number,
  pieceCount: number,
  proof: string[],
): string {
  return sectorEvidenceNotificationPayloadHexFromPieceSet(dealId, pieceIndex, pieceCount, proof);
}

const sectorEvidenceNotificationPayloadHexFromPieceSet = buildSectorEvidenceNotificationPayloadHex;

export type CurioPipelineState = {
  id: string;
  sector: number | null;
  sealed: boolean;
  complete: boolean;
  allocationId: number | null;
  pieceCid: string;
};

export type CurioCommitMessageMetrics = {
  messageCid: string;
  unsignedMessageBytes: bigint;
  signedMessageBytes: bigint;
  gasUsed: bigint;
};

export type CurioCommitBatchMetrics = CurioCommitMessageMetrics & {
  sectorCount: number;
  gasLimit: bigint;
};

export function parseCurioCommitMessageMetrics(value: string): CurioCommitMessageMetrics {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (typeof parsed.messageCid !== "string" || parsed.messageCid.length === 0) {
    throw new Error("Curio commit message CID is missing");
  }
  return {
    messageCid: parsed.messageCid,
    unsignedMessageBytes: metricBigInt(parsed.unsignedMessageBytes, "unsigned message bytes"),
    signedMessageBytes: metricBigInt(parsed.signedMessageBytes, "signed message bytes"),
    gasUsed: metricBigInt(parsed.gasUsed, "gas used"),
  };
}

// Curio deletes finalized pipeline rows; sectors_meta keeps the commit message afterwards.
function commitMessagesSql(providerActorId: number): string {
  return `with commits as (
    select sector_number, commit_msg_cid as cid from curio.sectors_sdr_pipeline
    where sp_id = ${providerActorId} and commit_msg_cid is not null
    union
    select sector_num, msg_cid_commit from curio.sectors_meta
    where sp_id = ${providerActorId} and msg_cid_commit is not null
  )`;
}

export function readCurioCommitMessageMetrics(
  context: ScenarioContext,
  sector: number,
): CurioCommitMessageMetrics {
  if (!Number.isSafeInteger(sector) || sector < 0) {
    throw new Error(`invalid sector number ${sector}`);
  }
  const providerActorId = Number(context.config.provider.slice(2));
  const output = queryScalar(
    context,
    `${commitMessagesSql(providerActorId)}
    select json_build_object(
      'messageCid', commits.cid,
      'unsignedMessageBytes', octet_length(sends.unsigned_data),
      'signedMessageBytes', octet_length(sends.signed_data),
      'gasUsed', waits.executed_rcpt_gas_used
    )
    from commits
    join curio.message_waits waits on waits.signed_message_cid = commits.cid
    join curio.message_sends sends on sends.signed_cid = commits.cid
    where commits.sector_number = ${sector}
    limit 1`,
  );
  if (!output) throw new Error(`Curio commit message metrics missing for sector ${sector}`);
  return parseCurioCommitMessageMetrics(output);
}

export function parseCurioCommitBatchMetrics(
  value: string,
  expectedSectorCount: number,
): CurioCommitBatchMetrics {
  const rows = JSON.parse(value) as unknown;
  if (!Array.isArray(rows)) throw new Error("Curio commit batch metrics are invalid");
  if (rows.length !== 1) {
    throw new Error(`expected one shared commit message, found ${rows.length}`);
  }
  const row = rows[0] as Record<string, unknown>;
  const sectorCount = Number(row.sectorCount);
  if (sectorCount !== expectedSectorCount) {
    throw new Error(`shared commit message contains ${sectorCount} sectors, expected ${expectedSectorCount}`);
  }
  return {
    ...parseCurioCommitMessageMetrics(JSON.stringify(row)),
    sectorCount,
    gasLimit: metricBigInt(row.gasLimit, "gas limit"),
  };
}

export function readCurioCommitBatchMetrics(
  context: ScenarioContext,
  sectors: number[],
): CurioCommitBatchMetrics {
  if (sectors.length === 0 || sectors.some((sector) => !Number.isSafeInteger(sector) || sector < 0)) {
    throw new Error("Curio commit batch sectors are missing or invalid");
  }
  const providerActorId = Number(context.config.provider.slice(2));
  const output = queryScalar(
    context,
    `select coalesce(json_agg(batch), '[]'::json) from (
      ${commitMessagesSql(providerActorId)}
      select
        commits.cid as "messageCid",
        count(*) as "sectorCount",
        octet_length(sends.unsigned_data) as "unsignedMessageBytes",
        octet_length(sends.signed_data) as "signedMessageBytes",
        sends.signed_json #>> '{Message,GasLimit}' as "gasLimit",
        waits.executed_rcpt_gas_used as "gasUsed"
      from commits
      join curio.message_waits waits on waits.signed_message_cid = commits.cid
      join curio.message_sends sends on sends.signed_cid = commits.cid
      where commits.sector_number in (${sectors.join(",")})
      group by commits.cid, sends.unsigned_data, sends.signed_data,
        sends.signed_json, waits.executed_rcpt_gas_used
    ) batch`,
  );
  return parseCurioCommitBatchMetrics(output, sectors.length);
}

export type CurioCommitFailure = {
  sector: number;
  taskId: number;
  error: string;
};

export function evmToFilecoinAddress(context: ScenarioContext, evmAddress: string): string {
  const output = dockerExec(context, "lotus", ["lotus", "evm", "stat", evmAddress]);
  const address = filecoinAddressFromEvmStat(output);
  if (!address) throw new Error(`Lotus did not resolve Filecoin address for ${evmAddress}`);
  return address;
}

export async function submitCurioNotification(
  context: ScenarioContext,
  piece: PieceInfo,
  receiverEvmAddress: string,
  porepDealId?: bigint,
): Promise<CurioNotificationDeal> {
  const allocation = createCurioAllocation(context, piece);
  const notificationAddress = evmToFilecoinAddress(context, receiverEvmAddress);
  const notificationPayload = porepDealId === undefined
    ? notificationPayloadHex(allocation.allocationId)
    : postDataCapNotificationPayloadHex(allocation.allocationId, porepDealId);
  const providerEnv = { SP_ADDRESS: context.config.provider };
  const submissionOutput = dockerExecEnv(
    context,
    "piece-server",
    providerEnv,
    buildMk20DealArgs({
      provider: context.config.provider,
      pieceCidV2: piece.pieceCidV2,
      allocationId: allocation.allocationId,
      notificationAddress,
      notificationPayload,
    }),
  );

  for (let attempt = 1; attempt <= 60; attempt++) {
    const dealId = queryScalar(
      context,
      `select id from curio.market_mk20_deal where piece_cid_v2='${sqlToken(piece.pieceCidV2)}' order by created_at desc limit 1`,
    );
    if (dealId) {
      return {
        dealId,
        allocationId: allocation.allocationId,
        ...(allocation.messageCid ? { allocationMessageCid: allocation.messageCid } : {}),
        notificationAddress,
        notificationPayload,
        submissionOutput,
      };
    }
    await sleep(1000);
  }
  throw new Error(`Curio deal row not found for ${piece.pieceCidV2} after 60 seconds`);
}

export async function submitCurioSectorEvidenceDeal(
  context: ScenarioContext,
  piece: PieceInfo,
  porepDealId: bigint,
  pieceIndex: number,
  pieceCount: number,
  proof: string[],
  allocation: { allocationId: bigint; messageCid?: string } = createCurioAllocation(context, piece),
): Promise<CurioSectorEvidenceDeal> {
  const notificationAddress = evmToFilecoinAddress(context, context.config.addresses.sectorEvidenceAdapter);
  const notificationPayload = sectorEvidenceNotificationPayloadHexFromPieceSet(
    porepDealId,
    pieceIndex,
    pieceCount,
    proof,
  ).slice(2);
  const submissionOutput = dockerExecEnv(context, "piece-server", { SP_ADDRESS: context.config.provider }, buildMk20DealArgs({
    provider: context.config.provider,
    pieceCidV2: piece.pieceCidV2,
    allocationId: allocation.allocationId,
    notificationAddress,
    notificationPayload,
  }));
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const dealId = queryScalar(
      context,
      `select id from curio.market_mk20_deal where piece_cid_v2='${sqlToken(piece.pieceCidV2)}' order by created_at desc limit 1`,
    );
    if (dealId) {
      return {
        dealId,
        allocationId: allocation.allocationId,
        ...(allocation.messageCid ? { allocationMessageCid: allocation.messageCid } : {}),
        notificationAddress,
        notificationPayload,
        submissionOutput,
        pieceIndex,
        pieceCount,
      };
    }
    await sleep(1000);
  }
  throw new Error(`Curio deal row not found for ${piece.pieceCidV2} after 60 seconds`);
}

export function readCurioPipeline(context: ScenarioContext, dealId: string): CurioPipelineState | undefined {
  const output = queryScalar(
    context,
    `select json_build_object('id',id,'sector',sector,'sealed',sealed,'complete',complete,'allocationId',allocation_id,'pieceCid',piece_cid) from curio.market_mk20_pipeline where id='${sqlToken(dealId)}' order by created_at desc limit 1`,
  );
  return output ? JSON.parse(output) as CurioPipelineState : undefined;
}

export async function waitForCurioSector(
  context: ScenarioContext,
  dealId: string,
): Promise<CurioPipelineState> {
  const maxSeconds = envNumber(context, "CURIO_ACTIVATION_TIMEOUT_SECONDS", 7200);
  for (let elapsed = 0; elapsed < maxSeconds; elapsed += 2) {
    const state = readCurioPipeline(context, dealId);
    if (state?.sector !== null && state?.sealed && state.complete) return state;
    if (elapsed === 0 || elapsed % 60 === 0) {
      console.log(`  waiting for Curio deal ${dealId}: ${state ? JSON.stringify(state) : "no pipeline row"}`);
    }
    await sleep(2000);
  }
  throw new Error(`Curio deal ${dealId} did not activate within ${maxSeconds} seconds`);
}

export async function waitForCurioSectors(
  context: ScenarioContext,
  dealIds: readonly string[],
): Promise<Map<string, CurioPipelineState>> {
  const maxSeconds = envNumber(context, "CURIO_ACTIVATION_TIMEOUT_SECONDS", 7200);
  const pending = new Set(dealIds);
  const result = new Map<string, CurioPipelineState>();
  for (let elapsed = 0; elapsed < maxSeconds && pending.size > 0; elapsed += 2) {
    for (const dealId of pending) {
      const state = readCurioPipeline(context, dealId);
      if (state?.sector !== null && state?.sealed && state.complete) {
        result.set(dealId, state);
        pending.delete(dealId);
      }
    }
    if (pending.size > 0) await sleep(2000);
  }
  if (pending.size > 0) throw new Error(`Curio deals did not activate within ${maxSeconds} seconds: ${[...pending].join(", ")}`);
  return result;
}

export async function waitForCurioCommitFailure(
  context: ScenarioContext,
  dealId: string,
): Promise<CurioCommitFailure> {
  const maxSeconds = envNumber(context, "CURIO_ACTIVATION_TIMEOUT_SECONDS", 7200);
  for (let elapsed = 0; elapsed < maxSeconds; elapsed += 2) {
    const pipeline = readCurioPipeline(context, dealId);
    if (pipeline?.sector !== null && pipeline?.sector !== undefined) {
      const row = queryScalar(
        context,
        `select json_build_object('sector',sector_number,'afterPorep',after_porep,'afterCommit',after_commit_msg,'taskId',task_id_commit_msg) from curio.sectors_sdr_pipeline where sp_id=${Number(context.config.provider.slice(2))} and sector_number=${pipeline.sector}`,
      );
      if (row) {
        const sector = JSON.parse(row) as {
          sector: number;
          afterPorep: boolean;
          afterCommit: boolean;
          taskId: number | null;
        };
        if (sector.afterPorep && !sector.afterCommit && sector.taskId !== null) {
          const error = queryScalar(
            context,
            `select coalesce(err,'') from curio.harmony_task_history where task_id=${sector.taskId} and result=false and err is not null order by id desc limit 1`,
          );
          const rejection = pipeline.pieceCid
            ? readCommitRejection(context, pipeline.pieceCid)
            : "";
          if (error && rejection) {
            return { sector: sector.sector, taskId: sector.taskId, error: rejection };
          }
        }
      }
    }
    if (elapsed === 0 || elapsed % 60 === 0) {
      console.log(`  waiting for rejected Curio deal ${dealId}: ${pipeline ? JSON.stringify(pipeline) : "no pipeline row"}`);
    }
    await sleep(2000);
  }
  throw new Error(`Curio deal ${dealId} did not reach commit rejection within ${maxSeconds} seconds`);
}

function readCommitRejection(context: ScenarioContext, pieceCid: string): string {
  const result = run(
    "docker",
    ["logs", "--since", "15m", "porep-market-curio-devnet-curio-1"],
    context.projectRoot,
  );
  const lines = `${result.stdout}\n${result.stderr}`.split("\n");
  return lines.find((line) =>
    line.includes("sector change rejected") && line.includes(pieceCid)) ?? "";
}

function queryScalar(context: ScenarioContext, sql: string): string {
  return dockerExec(context, "yugabyte", [
    "ysqlsh", "-h", "yugabyte", "-U", "yugabyte", "-d", "yugabyte",
    "-At", "-c", sql,
  ]).trim();
}

function sqlToken(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`invalid database lookup token: ${value}`);
  return value;
}

function metricBigInt(value: unknown, name: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Curio commit ${name} is missing or invalid`);
}

export function assertCurioStatus(
  status: CurioStatus,
  generation: string,
  provider: string,
): void {
  if (status.generation !== generation) throw new Error("DevNet generation is stale");
  if (status.miner?.provider !== provider) throw new Error("Curio provider is stale");
  if (status.chain?.networkVersion !== 29 || status.chain.actorsVersion !== 19) {
    throw new Error("DevNet is not running NV29 actors v19");
  }
  if (status.miner.sectorSize !== 8_388_608) throw new Error("DevNet sector size is not 8 MiB");
  if (status.curio?.apiReady !== true) throw new Error("Curio API is not ready");
  if (status.curio.marketReady !== true) throw new Error("Curio Market is not ready");
  if (status.curio.databaseReady !== true || typeof status.curio.taskCount !== "number" ||
      status.curio.taskCount < 1) {
    throw new Error("Curio database/tasks are not ready");
  }
}

export function ensureCurioReady(context: ScenarioContext): void {
  requireDevnet(context);
  const path = join(context.projectRoot, ".runtime/devnet/status/latest.json");
  let status: CurioStatus;
  try {
    status = JSON.parse(readFileSync(path, "utf8")) as CurioStatus;
  } catch {
    throw new Error(`current DevNet status is missing or invalid: ${path}`);
  }
  assertCurioStatus(status, context.config.generation, context.config.provider);
}

export async function verifyCurioDevnet(context: ScenarioContext): Promise<void> {
  ensureCurioReady(context);
  console.log(`Curio ready: provider=${context.config.provider}, generation=${context.config.generation}`);
}

export async function submitCurioOnboarding(
  context: ScenarioContext,
  input: { allocationId: bigint; pieceCid: string; pieceCidV2: string; pieceCarPath: string },
): Promise<{ startEpoch: bigint; clientF4: string }> {
  ensureCurioReady(context);
  const notificationAddress = evmToFilecoinAddress(
    context,
    context.config.addresses.notificationReceiver,
  );
  const notificationPayload = notificationPayloadHex(input.allocationId);
  const marketAddress = context.config.addresses.dataCapEvidenceAdapter;
  queryScalar(
    context,
    `insert into curio.ddo_contracts (address, allowed) values ('${sqlToken(marketAddress)}', true) on conflict (address) do update set allowed=excluded.allowed`,
  );
  const providerEnv = { SP_ADDRESS: context.config.provider };
  dockerExecEnv(
    context,
    "piece-server",
    providerEnv,
    buildMk20DealArgs({
      provider: context.config.provider,
      pieceCidV2: input.pieceCidV2,
      allocationId: input.allocationId,
      notificationAddress,
      notificationPayload,
      marketAddress,
    }),
  );

  for (let attempt = 1; attempt <= 60; attempt++) {
    const dealId = queryScalar(
      context,
      `select id from curio.market_mk20_deal where piece_cid_v2='${sqlToken(input.pieceCidV2)}' order by created_at desc limit 1`,
    );
    if (dealId) {
      const startEpoch = BigInt(currentLotusEpoch(context));
      context.state.set("CURIO_DEAL_ID", dealId);
      context.state.set("DIRECT_IMPORT_START_EPOCH", startEpoch);
      context.state.set("NOTIFICATION_ADDRESS", notificationAddress);
      context.state.set("NOTIFICATION_PAYLOAD", notificationPayload);
      return { startEpoch, clientF4: notificationAddress };
    }
    await sleep(1000);
  }
  throw new Error(`Curio deal row not found for ${input.pieceCidV2} after 60 seconds`);
}

export function currentLotusEpoch(context: ScenarioContext): number {
  return Number(dockerExec(context, "lotus", ["lotus", "chain", "head", "--height"]).trim());
}

export function filecoinAddressFromEvmStat(output: string): string | undefined {
  return output.match(/Filecoin address:\s+(\S+)/)?.[1];
}
