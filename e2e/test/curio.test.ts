import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCurioStatus,
  buildMk20DealArgs,
  decodePostDataCapNotificationPayload,
  filecoinAddressFromEvmStat,
  notificationPayloadHex,
  parseAllocationId,
  parseCurioCommitBatchMetrics,
  parseCurioCommitMessageMetrics,
  postDataCapNotificationPayloadHex,
} from "../src/devnet/curio.js";

test("filecoinAddressFromEvmStat parses Lotus EVM output", () => {
  assert.equal(
    filecoinAddressFromEvmStat("Filecoin address:  t410fexample\nEth address: 0x1234\n"),
    "t410fexample",
  );
});

test("assertCurioStatus accepts the required live harness state", () => {
  assert.doesNotThrow(() => assertCurioStatus({
    generation: "generation-a",
    chain: { networkVersion: 29, actorsVersion: 19 },
    miner: { provider: "t01004", sectorSize: 8_388_608 },
    curio: { apiReady: true, marketReady: true, databaseReady: true, taskCount: 2 },
  }, "generation-a", "t01004"));
});

test("assertCurioStatus rejects stale or incomplete provider state", () => {
  const base = {
    generation: "generation-a",
    chain: { networkVersion: 29, actorsVersion: 19 },
    miner: { provider: "t01004", sectorSize: 8_388_608 },
    curio: { apiReady: true, marketReady: true, databaseReady: true, taskCount: 2 },
  };
  assert.throws(
    () => assertCurioStatus({ ...base, generation: "generation-b" }, "generation-a", "t01004"),
    /generation is stale/,
  );
  assert.throws(
    () => assertCurioStatus({ ...base, curio: { ...base.curio, marketReady: false } }, "generation-a", "t01004"),
    /Curio Market is not ready/,
  );
});

test("Curio notification request uses the signed stock client path and exact fields", () => {
  assert.equal(notificationPayloadHex(42n), "01000000000000002a");
  assert.deepEqual(buildMk20DealArgs({
    provider: "t01004",
    pieceCidV2: "bafkzcibexample",
    allocationId: 42n,
    notificationAddress: "t410freceiver",
    notificationPayload: "01000000000000002a",
  }), [
    "sptool", "--actor", "t01004", "toolbox", "mk20-client", "deal",
    "--provider", "t01004",
    "--http-url", "http://piece-server:12320/pieces?id=bafkzcibexample",
    "--pcidv2", "bafkzcibexample",
    "--allocation", "42",
    "--notification-address", "t410freceiver",
    "--notification-payload", "01000000000000002a",
  ]);
});

test("post-DataCap notification payload binds allocation and PoRep deal IDs", () => {
  const payload = `02${"2a".padStart(16, "0")}${"7".padStart(64, "0")}`;
  assert.equal(postDataCapNotificationPayloadHex(42n, 7n), payload);
  assert.deepEqual(decodePostDataCapNotificationPayload(`0x${payload}`), {
    allocationId: 42n,
    porepDealId: 7n,
  });
});

test("post-DataCap notification payload rejects invalid versions and integer bounds", () => {
  assert.throws(
    () => postDataCapNotificationPayloadHex(-1n, 7n),
    /allocation ID must fit in uint64/,
  );
  assert.throws(
    () => postDataCapNotificationPayloadHex(42n, 1n << 256n),
    /PoRep deal ID must fit in uint256/,
  );
  assert.throws(
    () => decodePostDataCapNotificationPayload(`0x03${"00".repeat(40)}`),
    /invalid post-DataCap notification payload/,
  );
});

test("Curio request can identify an allowlisted contract allocation owner", () => {
  assert.deepEqual(buildMk20DealArgs({
    provider: "t01004",
    pieceCidV2: "bafkzcibexample",
    allocationId: 42n,
    notificationAddress: "t410freceiver",
    notificationPayload: "01000000000000002a",
    marketAddress: "0x1234",
  }).slice(-2), [
    "--market-address", "0x1234",
  ]);
});

test("parseAllocationId selects the newest matching allocation", () => {
  assert.equal(parseAllocationId(JSON.stringify({
    allocations: {
      "2": { Data: { "/": "baga-piece" } },
      "7": { Data: { "/": "baga-other" } },
      "9": { Data: { "/": "baga-piece" } },
    },
  }), "baga-piece"), 9n);
});

test("Curio commit metrics preserve serialized message bytes and gas", () => {
  assert.deepEqual(parseCurioCommitMessageMetrics(JSON.stringify({
    messageCid: "bafy2bzacecommit",
    unsignedMessageBytes: 1_024,
    signedMessageBytes: 1_122,
    gasUsed: 654_321,
  })), {
    messageCid: "bafy2bzacecommit",
    unsignedMessageBytes: 1_024n,
    signedMessageBytes: 1_122n,
    gasUsed: 654_321n,
  });
});

test("Curio batch metrics require one shared message for every requested sector", () => {
  assert.deepEqual(parseCurioCommitBatchMetrics(JSON.stringify([{
    messageCid: "bafy2bzacecommit",
    sectorCount: 16,
    unsignedMessageBytes: 4_096,
    signedMessageBytes: 4_194,
    gasLimit: 9_000_000_000,
    gasUsed: 8_000_000_000,
  }]), 16), {
    messageCid: "bafy2bzacecommit",
    sectorCount: 16,
    unsignedMessageBytes: 4_096n,
    signedMessageBytes: 4_194n,
    gasLimit: 9_000_000_000n,
    gasUsed: 8_000_000_000n,
  });

  assert.throws(
    () => parseCurioCommitBatchMetrics(JSON.stringify([
      { messageCid: "first", sectorCount: 2 },
      { messageCid: "second", sectorCount: 2 },
    ]), 4),
    /expected one shared commit message, found 2/,
  );
});
