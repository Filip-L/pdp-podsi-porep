import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";

import { loadVersionLock } from "./lock.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CID_PATTERN = /^baf[a-z2-7]{20,}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const IMAGE_REGISTRY_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const IMAGE_PATH_COMPONENT_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const RFC3339_PATTERN =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$/;

export const runtimeImageNames = [
  "yugabyte",
  "go_builder",
  "rust_toolchain",
  "ubuntu_runtime",
  "node_runtime",
  "foundry",
] as const;

const sourceToolNames = [
  "foundry",
  "go_car",
  "piece_server",
  "storetheindex",
  "go_ethereum",
  "blst",
] as const;

type RuntimeImageName = (typeof runtimeImageNames)[number];
type SourceToolName = (typeof sourceToolNames)[number];
type RuntimeArchitecture = "amd64" | "arm64";
type RuntimePlatform = `linux/${RuntimeArchitecture}`;

export interface RuntimeImage {
  name: RuntimeImageName;
  reference: string;
  indexDigest: string;
  platformDigests: Record<RuntimePlatform, string>;
  resolvedReference: string;
}

export interface RuntimeSourceTool {
  name: SourceToolName;
  repository: string;
  tag: string;
  commit: string;
  managedSource?: string;
  compatibility?: string;
}

export interface RuntimePort {
  name: string;
  service: string;
  host: number;
  container: number;
}

export interface RuntimeLock {
  schemaVersion: 1;
  selectedAt: string;
  network: {
    chainId: number;
    genesis: {
      networkVersion: number;
      actorsVersion: number;
    };
    upgrade: {
      name: string;
      epoch: number;
      networkVersion: number;
      actorsVersion: number;
    };
    upgradeActors: {
      manifestCid: string;
      storageMinerActorCid: string;
    };
  };
  images: Record<RuntimeImageName, RuntimeImage>;
  buildTools: {
    node: { version: string };
    npm: { version: string };
    sources: Record<SourceToolName, RuntimeSourceTool>;
  };
  expectedHost: {
    architectures: RuntimeArchitecture[];
    minimumNodeMajor: number;
  };
  runtime: {
    composeProject: string;
    services: string[];
    ports: Record<string, RuntimePort>;
  };
}

export async function loadRuntimeLock(path: string): Promise<RuntimeLock> {
  const contents = await readFile(path, "utf8");
  let document;
  try {
    document = parseDocument(contents, {
      logLevel: "error",
      prettyErrors: false,
    });
  } catch {
    throw new Error(`version lock ${path} contains invalid or unsafe YAML`);
  }
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`version lock ${path} contains invalid or unsafe YAML`);
  }

  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error(`version lock ${path} contains invalid or unsafe YAML`);
  }

  if (!isPlainRecord(parsed)) {
    throw new Error(`version lock ${path} must be a mapping`);
  }
  rejectReservedKeys(parsed);
  assertExactKeys(
    parsed,
    ["schema_version", "selected_at", "network", "sources", "images", "build_tools", "expected_host", "runtime"],
    `version lock ${path}`,
  );

  if (parsed.schema_version !== 1) {
    throw new Error(`version lock ${path} has unsupported schema_version ${String(parsed.schema_version)}`);
  }
  const selectedAt = requiredString(parsed.selected_at, `version lock ${path} selected_at`);
  if (!isValidRfc3339Timestamp(selectedAt)) {
    throw new Error(`version lock ${path} selected_at must be a valid RFC3339 timestamp`);
  }

  // Preserve the Phase 1 source-lock validation contract for the shared file.
  const versionLock = await loadVersionLock(path);

  const network = parseNetwork(requiredMapping(parsed.network, "network"));
  const images = parseImages(requiredMapping(parsed.images, "images"));
  const buildTools = parseBuildTools(requiredMapping(parsed.build_tools, "build_tools"));
  const expectedHost = parseExpectedHost(requiredMapping(parsed.expected_host, "expected_host"));
  const runtime = parseRuntime(requiredMapping(parsed.runtime, "runtime"));
  validateBlstManagedSource(
    requiredMapping(parsed.sources, "sources"),
    versionLock,
    buildTools.sources.blst,
  );

  if (expectedHost.minimumNodeMajor > Number(buildTools.node.version.split(".")[0])) {
    throw new Error("build_tools node version must satisfy expected_host minimum_node_major");
  }
  if (!images.node_runtime.reference.includes(`:${buildTools.node.version}-`)) {
    throw new Error("node_runtime reference must match build_tools node version");
  }
  if (!images.foundry.reference.endsWith(`:${buildTools.sources.foundry.tag}`)) {
    throw new Error("foundry image reference must match build_tools foundry tag");
  }
  const expectedHostRecord = requiredMapping(parsed.expected_host, "expected_host");
  if (expectedHostRecord.docker_compose_project !== runtime.composeProject) {
    throw new Error("expected_host docker_compose_project must match runtime compose_project");
  }

  return {
    schemaVersion: 1,
    selectedAt,
    network,
    images,
    buildTools,
    expectedHost,
    runtime,
  };
}

function parseNetwork(network: Record<string, unknown>): RuntimeLock["network"] {
  assertExactKeys(network, [
    "chain_id",
    "genesis_network_version",
    "genesis_actors_version",
    "upgrade_name",
    "upgrade_epoch",
    "required_network_version",
    "required_actors_version",
    "genesis_actors",
    "upgrade_actors",
  ], "network");

  const chainId = requiredPositiveInteger(network.chain_id, "network chain_id");
  const genesisNetworkVersion =
    requiredPositiveInteger(network.genesis_network_version, "network genesis_network_version");
  const genesisActorsVersion =
    requiredPositiveInteger(network.genesis_actors_version, "network genesis_actors_version");
  const upgradeName = requiredString(network.upgrade_name, "network upgrade_name");
  const upgradeEpoch =
    requiredPositiveInteger(network.upgrade_epoch, "network upgrade_epoch");
  const requiredNetworkVersion =
    requiredPositiveInteger(network.required_network_version, "network required_network_version");
  const requiredActorsVersion =
    requiredPositiveInteger(network.required_actors_version, "network required_actors_version");

  if (requiredNetworkVersion <= genesisNetworkVersion) {
    throw new Error("required network version must be greater than genesis network version");
  }
  if (requiredActorsVersion <= genesisActorsVersion) {
    throw new Error("required actors version must be greater than genesis actors version");
  }
  parseActorBundle(
    requiredMapping(network.genesis_actors, "network genesis_actors"),
    genesisActorsVersion,
    false,
  );
  const upgradeActors = parseActorBundle(
    requiredMapping(network.upgrade_actors, "network upgrade_actors"),
    requiredActorsVersion,
    true,
  );

  return {
    chainId,
    genesis: {
      networkVersion: genesisNetworkVersion,
      actorsVersion: genesisActorsVersion,
    },
    upgrade: {
      name: upgradeName,
      epoch: upgradeEpoch,
      networkVersion: requiredNetworkVersion,
      actorsVersion: requiredActorsVersion,
    },
    upgradeActors: {
      manifestCid: upgradeActors.manifestCid,
      storageMinerActorCid: upgradeActors.storageMinerActorCid,
    },
  };
}

function parseActorBundle(
  actor: Record<string, unknown>,
  version: number,
  requireCids: boolean,
): { manifestCid: string; storageMinerActorCid: string } {
  const baseKeys = ["repository", "tag", "commit"];
  const cidKeys = ["manifest_cid", "storage_miner_actor_cid"];
  assertExactKeys(actor, requireCids ? [...baseKeys, ...cidKeys] : baseKeys, `actors_v${version}`);
  validateHttpsRepository(requiredString(actor.repository, `actors_v${version} repository`), `actors_v${version}`);
  requiredPinnedTag(actor.tag, `actors_v${version} tag`);
  requiredCommit(actor.commit, `actors_v${version} commit`);

  if (!requireCids) {
    return { manifestCid: "", storageMinerActorCid: "" };
  }
  const manifestCid = requiredCid(actor.manifest_cid, `actors_v${version} manifest_cid`);
  const storageMinerActorCid =
    requiredCid(actor.storage_miner_actor_cid, `actors_v${version} storage_miner_actor_cid`);
  return { manifestCid, storageMinerActorCid };
}

function parseImages(images: Record<string, unknown>): RuntimeLock["images"] {
  assertExactAllowlist(images, runtimeImageNames, "images");
  const result = {} as Record<RuntimeImageName, RuntimeImage>;

  for (const name of runtimeImageNames) {
    const image = requiredMapping(images[name], `image ${name}`);
    assertExactKeys(image, ["reference", "index_digest", "platforms"], `image ${name}`);
    const reference = requiredImageReference(image.reference, `image ${name} reference`);
    const indexDigest = requiredDigest(image.index_digest, `image ${name} index_digest`);
    const platforms = requiredMapping(image.platforms, `image ${name} platforms`);
    assertExactKeys(platforms, ["linux_amd64", "linux_arm64"], `image ${name} platforms`);
    const amd64 = requiredDigest(platforms.linux_amd64, `image ${name} platforms linux_amd64`);
    const arm64 = requiredDigest(platforms.linux_arm64, `image ${name} platforms linux_arm64`);
    if (amd64 === arm64 || amd64 === indexDigest || arm64 === indexDigest) {
      throw new Error(`image ${name} index and platform digests must be distinct`);
    }
    result[name] = {
      name,
      reference,
      indexDigest,
      platformDigests: {
        "linux/amd64": amd64,
        "linux/arm64": arm64,
      },
      resolvedReference: `${reference}@${indexDigest}`,
    };
  }
  return result;
}

function parseBuildTools(buildTools: Record<string, unknown>): RuntimeLock["buildTools"] {
  assertExactKeys(buildTools, ["node", "npm", ...sourceToolNames], "build_tools");
  const node = parseVersionTool(requiredMapping(buildTools.node, "build_tools node"), "node");
  const npm = parseVersionTool(requiredMapping(buildTools.npm, "build_tools npm"), "npm");
  const sources = {} as Record<SourceToolName, RuntimeSourceTool>;

  for (const name of sourceToolNames) {
    const tool = requiredMapping(buildTools[name], `build_tools ${name}`);
    const blstKeys = ["managed_source", "repository", "tag", "commit", "compatibility"];
    assertExactKeys(
      tool,
      name === "blst" ? blstKeys : ["repository", "tag", "commit"],
      `build_tools ${name}`,
    );
    const repository = requiredString(tool.repository, `build_tools ${name} repository`);
    validateHttpsRepository(repository, `build_tools ${name}`);
    const parsedTool: RuntimeSourceTool = {
      name,
      repository,
      tag: requiredPinnedTag(tool.tag, `build_tools ${name} tag`),
      commit: requiredCommit(tool.commit, `build_tools ${name} commit`),
    };
    if (name === "blst") {
      const managedSource = requiredString(tool.managed_source, "build_tools blst managed_source");
      const compatibility = requiredString(tool.compatibility, "build_tools blst compatibility");
      if (managedSource !== "blst") {
        throw new Error("build_tools blst managed_source must be blst");
      }
      parsedTool.managedSource = managedSource;
      parsedTool.compatibility = compatibility;
    }
    sources[name] = parsedTool;
  }

  return { node, npm, sources };
}

function validateBlstManagedSource(
  rawSources: Record<string, unknown>,
  versionLock: Awaited<ReturnType<typeof loadVersionLock>>,
  blstTool: RuntimeSourceTool,
): void {
  const rawBlst = requiredMapping(rawSources.blst, "source blst");
  assertExactKeys(
    rawBlst,
    ["repository", "tag", "commit", "compatibility", "submodules"],
    "source blst",
  );
  const repository = requiredString(rawBlst.repository, "source blst repository");
  const tag = requiredString(rawBlst.tag, "source blst tag");
  const commit = requiredString(rawBlst.commit, "source blst commit");
  const compatibility = requiredString(rawBlst.compatibility, "source blst compatibility");
  const submodules = requiredMapping(rawBlst.submodules, "source blst submodules");
  const managedBlst = versionLock.sources.blst;
  if (
    managedBlst === undefined
    || blstTool.managedSource !== "blst"
    || blstTool.repository !== repository
    || blstTool.tag !== tag
    || blstTool.commit !== commit
    || blstTool.compatibility !== compatibility
    || managedBlst.repository !== repository
    || managedBlst.commit !== commit
    || JSON.stringify(managedBlst.submodules) !== JSON.stringify(submodules)
  ) {
    throw new Error("managed source blst must match the selected build input");
  }
}

function parseVersionTool(tool: Record<string, unknown>, name: "node" | "npm"): { version: string } {
  assertExactKeys(tool, ["version"], `build_tools ${name}`);
  const version = requiredString(tool.version, `build_tools ${name} version`);
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`build_tools ${name} version must be an exact three-part numeric version`);
  }
  return { version };
}

function parseExpectedHost(expectedHost: Record<string, unknown>): RuntimeLock["expectedHost"] {
  assertExactKeys(
    expectedHost,
    ["architecture", "minimum_node_major", "docker_compose_project"],
    "expected_host",
  );
  const architecture = expectedHost.architecture;
  if (!Array.isArray(architecture) || !architecture.every((value) => typeof value === "string")) {
    throw new Error("expected_host architecture must be a sequence");
  }
  if (
    architecture.length === 0
    || new Set(architecture).size !== architecture.length
    || architecture.some((value) => value !== "amd64" && value !== "arm64")
  ) {
    throw new Error("expected_host architecture contains unsupported or duplicate values");
  }
  const minimumNodeMajor =
    requiredPositiveInteger(expectedHost.minimum_node_major, "expected_host minimum_node_major");
  requiredString(expectedHost.docker_compose_project, "expected_host docker_compose_project");
  return {
    architectures: architecture as RuntimeArchitecture[],
    minimumNodeMajor,
  };
}

function parseRuntime(runtime: Record<string, unknown>): RuntimeLock["runtime"] {
  assertExactKeys(runtime, ["compose_project", "services", "ports"], "runtime");
  const composeProject = requiredString(runtime.compose_project, "runtime compose_project");
  const rawServices = runtime.services;
  if (!Array.isArray(rawServices) || !rawServices.every((value) => typeof value === "string")) {
    throw new Error("runtime services must be a sequence of names");
  }
  if (
    rawServices.length === 0
    || new Set(rawServices).size !== rawServices.length
    || rawServices.some((service) => !/^[a-z0-9][a-z0-9-]*$/.test(service))
  ) {
    throw new Error("runtime services must contain unique safe names");
  }

  const rawPorts = requiredMapping(runtime.ports, "runtime ports");
  if (Object.keys(rawPorts).length === 0) throw new Error("runtime ports must not be empty");
  const ports: Record<string, RuntimePort> = {};
  const seenHostPorts = new Set<number>();
  for (const name of Object.keys(rawPorts)) {
    if (!/^[a-z0-9][a-z0-9_]*$/.test(name)) {
      throw new Error(`runtime port name is invalid: ${name}`);
    }
    const port = requiredMapping(rawPorts[name], `runtime port ${name}`);
    assertExactKeys(port, ["service", "host", "container"], `runtime port ${name}`);
    const service = requiredString(port.service, `runtime port ${name} service`);
    if (!rawServices.includes(service)) {
      throw new Error(`runtime port ${name} service must reference a runtime service`);
    }
    const host = requiredPort(port.host, `runtime port ${name} host`);
    const container = requiredPort(port.container, `runtime port ${name} container`);
    if (seenHostPorts.has(host)) {
      throw new Error(`duplicate host port ${host}`);
    }
    seenHostPorts.add(host);
    ports[name] = { name, service, host, container };
  }

  return {
    composeProject,
    services: [...rawServices],
    ports,
  };
}

function requiredMapping(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a plain mapping`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function requiredPort(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error(`${label} must be an integer from 1 through 65535`);
  }
  return value as number;
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be sha256: followed by 64 lowercase hexadecimal characters`);
  }
  return value;
}

function requiredCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new Error(`${label} must be exactly 40 lowercase hexadecimal characters`);
  }
  return value;
}

function requiredCid(value: unknown, label: string): string {
  if (typeof value !== "string" || !CID_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase base32 CID`);
  }
  return value;
}

function requiredImageReference(value: unknown, label: string): string {
  const reference = requiredString(value, label);
  const firstSlash = reference.indexOf("/");
  const tagSeparator = reference.lastIndexOf(":");
  const invalid = (): never => {
    throw new Error(`${label} must be a credential-free tagged Docker/OCI reference`);
  };
  if (
    /[\s\u0000-\u001f]/.test(reference)
    || /[@?#\\]/.test(reference)
    || reference.includes("://")
    || firstSlash <= 0
    || tagSeparator <= firstSlash + 1
  ) {
    return invalid();
  }

  const registry = reference.slice(0, firstSlash);
  const imagePath = reference.slice(firstSlash + 1, tagSeparator);
  const tag = reference.slice(tagSeparator + 1);
  const registryColon = registry.lastIndexOf(":");
  const registryHost = registryColon === -1 ? registry : registry.slice(0, registryColon);
  const registryPort = registryColon === -1 ? undefined : registry.slice(registryColon + 1);
  if (!IMAGE_REGISTRY_HOST_PATTERN.test(registryHost)) {
    return invalid();
  }
  if (
    registryPort !== undefined
    && (!/^[0-9]+$/.test(registryPort)
      || Number(registryPort) < 1
      || Number(registryPort) > 65_535)
  ) {
    return invalid();
  }
  const pathComponents = imagePath.split("/");
  if (
    pathComponents.length === 0
    || pathComponents.some((component) => !IMAGE_PATH_COMPONENT_PATTERN.test(component))
    || !IMAGE_TAG_PATTERN.test(tag)
    || tag.toLowerCase() === "latest"
  ) {
    return invalid();
  }
  return reference;
}

function isValidRfc3339Timestamp(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);

  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return false;
  }
  return true;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function requiredPinnedTag(value: unknown, label: string): string {
  const tag = requiredString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag) || /^(?:latest|main|master)$/i.test(tag)) {
    throw new Error(`${label} must be an exact non-floating tag`);
  }
  return tag;
}

function validateHttpsRepository(repository: string, label: string): void {
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw new Error(`${label} repository must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} repository must use HTTPS`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${label} repository URL must not include credentials or userinfo`);
  }
  if (url.search !== "") {
    throw new Error(`${label} repository URL must not include query or search text`);
  }
  if (url.hash !== "") {
    throw new Error(`${label} repository URL must not include a fragment or hash`);
  }
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(record)) {
    if (!expectedSet.has(key)) {
      throw new Error(`${label} has unknown field ${key}`);
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(record, key)) {
      throw new Error(`${label} is missing field ${key}`);
    }
  }
}

function assertExactAllowlist(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record);
  if (
    actual.length !== expected.length
    || expected.some((name) => !Object.hasOwn(record, name))
  ) {
    throw new Error(`${label} must exactly contain ${expected.join(",")}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectReservedKeys(value: unknown, seen = new WeakSet<object>(), context = ""): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      rejectReservedKeys(item, seen, context);
    }
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      const kind = context === "runtime.ports" ? "runtime port" : "mapping";
      throw new Error(`reserved ${kind} key ${key}`);
    }
    const childContext = context === "" ? key : `${context}.${key}`;
    rejectReservedKeys(child, seen, childContext);
  }
}
