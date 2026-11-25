import { BN } from "@coral-xyz/anchor";
import {
  type BridgeRoute,
  type BridgeRouteIdentity,
  type ProviderControls,
  type RouteChain,
  type RouteLimits,
  type RouteSets,
  encodeBridgeRoute,
  encodeBridgeRouteIdentity,
  evmAddressToPublicKey,
  fetchMintAndTokenProgram,
  isValidEvmAddress,
  MAX_COST_BPS,
  MAX_ROUTE_CHAINS,
  RouteManagementMode,
  U64_MAX_BN,
  USDC,
  USDC_DEVNET,
  USDT,
} from "@glamsystems/glam-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Command, Option } from "commander";

import {
  type CliContext,
  executeTxWithErrorHandling,
  formatUiAmount,
  resolveTokenPublicKey,
} from "../utils";
import { fail } from "../errors";
import {
  collectArrayValues,
  collectPublicKeys,
  parseFixedBytes,
  parseHexOrBase64Bytes,
  parseNonNegativeInteger,
  parseNonNegativeUiAmount,
  parseOptionalHexOrBase64Bytes,
  parsePositiveBn,
  parsePositiveUiAmount,
  parseU32,
  validatePublicKey,
} from "../parsing";

function parseTransferId(value: string): PublicKey {
  try {
    return new PublicKey(value.trim());
  } catch {
    return new PublicKey(parseFixedBytes(value, "transferId", 32));
  }
}

function formatBytesHex(value: Buffer | Uint8Array | number[]) {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function parseManagementMode(value: string): RouteManagementMode {
  switch (value) {
    case "managed":
      return RouteManagementMode.ManagedOnly;
    case "either":
      return RouteManagementMode.Either;
    case "unmanaged":
      return RouteManagementMode.UnmanagedOnly;
    default:
      throw new Error(
        `Unsupported management mode: ${value}. Use unmanaged, managed, or either.`,
      );
  }
}

function formatManagementMode(value: RouteManagementMode | number) {
  switch (value) {
    case RouteManagementMode.UnmanagedOnly:
      return "unmanaged";
    case RouteManagementMode.ManagedOnly:
      return "managed";
    case RouteManagementMode.Either:
      return "either";
    default:
      return `unknown(${value})`;
  }
}

function serializeBridgeValue(value: unknown): unknown {
  if (value instanceof PublicKey) {
    return value.toBase58();
  }

  if (BN.isBN(value)) {
    return (value as BN).toString();
  }

  if (Buffer.isBuffer(value)) {
    return formatBytesHex(value);
  }

  if (value instanceof Uint8Array) {
    return formatBytesHex(value);
  }

  if (Array.isArray(value)) {
    return value.map(serializeBridgeValue);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        serializeBridgeValue(entry),
      ]),
    );
  }

  return value;
}

function printJson(value: unknown) {
  console.log(JSON.stringify(serializeBridgeValue(value), null, 2));
}

function toSortableNumber(value: unknown): number {
  if (BN.isBN(value)) {
    return (value as BN).toNumber();
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return 0;
}

type RouteVerb = "add" | "update";

/**
 * The route field options. allow-route gives each a default and requires --max-amount; on
 * update-route an omitted one is undefined and the field keeps the patched route's value.
 */
type RouteOptions = {
  managementMode?: string;
  minAmount?: string;
  maxAmount?: string;
  maxCostBps?: number;
  // The raw --chain-limits entries; their amounts are read under the source mint's decimals,
  // which are known only once the mint is.
  chainLimits: string[];
  yes: boolean;
};

/** allow-route's options, every field set by its option or the option's default. */
type NewRouteOptions = Required<RouteOptions>;

type RouteSetName = "live" | "pending";

/** update-route's own options: the chains whose own limits to drop, and the set to patch. */
type RouteUpdateOptions = RouteOptions & {
  clearChainLimits: string[];
  base?: RouteSetName;
};

/** The route an update patches, and the set it was read from. */
type RouteBase = { route: BridgeRoute; set: RouteSetName };

// A LayerZero endpoint id is a u32, and 0 names no endpoint.
function parseDestinationChain(value: string): number {
  const chain = parseU32(value, "destination-chain");
  if (chain === 0) {
    fail("destination-chain must be a positive integer");
  }
  return chain;
}

// The program takes a CCTP route's finality floor as one of these two values.
function parseMinFinality(value: string): number {
  const threshold = parseU32(value, "min-finality");
  if (threshold !== 1000 && threshold !== 2000) {
    fail("min-finality must be 1000 (confirmed) or 2000 (finalized)");
  }
  return threshold;
}

function parseCostBps(value: string, label: string): number {
  const parsed = parseNonNegativeInteger(value, label);
  if (parsed > MAX_COST_BPS) {
    throw new Error(`${label} must be at most ${MAX_COST_BPS} (ten percent)`);
  }
  return parsed;
}

/** An amount range in UI units under `decimals`, with a cost bound already checked. */
function parseLimits(
  minAmount: string,
  maxAmount: string,
  maxCostBps: number,
  decimals: number,
  labels: { min: string; max: string },
): RouteLimits {
  const min = parseNonNegativeUiAmount(minAmount, decimals, labels.min);
  const max = parsePositiveUiAmount(maxAmount, decimals, labels.max);
  if (max.lt(min)) {
    throw new Error(
      `${labels.max} must be greater than or equal to ${labels.min}`,
    );
  }
  return { minAmount: min, maxAmount: max, maxCostBps };
}

/** The --chain-limits entries by chain, one entry per chain. */
function parseChainLimits(
  entries: string[],
  decimals: number,
): Map<number, RouteLimits> {
  const byChain = new Map<number, RouteLimits>();
  for (const entry of entries) {
    const parts = entry.split(":");
    if (parts.length !== 4) {
      throw new Error(
        `--chain-limits takes <chain>:<min>:<max>:<bps>, for example 6:1:500:5; got ${entry}`,
      );
    }
    const [chainPart, minPart, maxPart, bpsPart] = parts;
    const chain = parseU32(chainPart, "--chain-limits chain");
    if (byChain.has(chain)) {
      throw new Error(`--chain-limits names chain ${chain} more than once`);
    }
    byChain.set(
      chain,
      parseLimits(
        minPart,
        maxPart,
        parseCostBps(bpsPart, `chain ${chain} cost bound`),
        decimals,
        { min: `chain ${chain} minimum`, max: `chain ${chain} maximum` },
      ),
    );
  }
  return byChain;
}

function checkChainCount(count: number) {
  if (count === 0) {
    throw new Error(
      "at least one destination chain is required: list it, or give it its own limits with --chain-limits",
    );
  }
  if (count > MAX_ROUTE_CHAINS) {
    throw new Error(
      `a route lists at most ${MAX_ROUTE_CHAINS} chains, got ${count}`,
    );
  }
}

/**
 * The route's chains, each once: the listed ones in order, then any other chain --chain-limits
 * names. A chain with an entry carries its limits; the others take the route's.
 */
function routeChains(
  listed: string[],
  ownLimits: Map<number, RouteLimits>,
): RouteChain[] {
  const chains = [
    ...new Set([
      ...listed.map((value) => parseU32(value, "chain")),
      ...ownLimits.keys(),
    ]),
  ];
  checkChainCount(chains.length);
  return chains.map((chain) => ({
    chain: new BN(chain),
    limits: ownLimits.get(chain),
  }));
}

/** A route's chains for a confirmation prompt, marking those with their own limits. */
function describeChains(chains: RouteChain[]): string {
  return chains
    .map(({ chain, limits }) =>
      limits ? `${chain.toString()} (own limits)` : chain.toString(),
    )
    .join(", ");
}

/** The route allow-route writes: each field from its option or the option's default. */
function buildRoute(
  identity: BridgeRouteIdentity,
  chains: string[],
  controls: ProviderControls,
  options: NewRouteOptions,
  decimals: number,
): BridgeRoute {
  return {
    sourceMint: identity.sourceMint,
    destinationRecipient: identity.destinationRecipient,
    providerProgram: identity.providerProgram,
    managementMode: parseManagementMode(options.managementMode),
    limits: parseLimits(
      options.minAmount,
      options.maxAmount,
      options.maxCostBps,
      decimals,
      { min: "--min-amount", max: "--max-amount" },
    ),
    controls,
    destinationChains: routeChains(
      chains,
      parseChainLimits(options.chainLimits, decimals),
    ),
  };
}

/**
 * The chains after an update: the listed ones in order when given, else the base's, a kept chain
 * with its own limits; --chain-limits then sets a chain's own limits, adding the chain when the
 * list lacks it, and --clear-chain-limits drops them.
 */
function patchChains(
  base: RouteChain[],
  listed: string[],
  ownLimits: Map<number, RouteLimits>,
  cleared: string[],
): RouteChain[] {
  const kept = new Map(
    base.map(({ chain, limits }) => [chain.toString(), limits ?? null]),
  );
  const ids =
    listed.length > 0
      ? listed.map((value) => parseU32(value, "chain").toString())
      : [...kept.keys()];
  const chains = new Map<string, RouteLimits | null>(
    ids.map((chain) => [chain, kept.get(chain) ?? null]),
  );
  for (const [chain, limits] of ownLimits) {
    chains.set(chain.toString(), limits);
  }
  const clearing = new Set(
    cleared.map((value) => parseU32(value, "--clear-chain-limits chain")),
  );
  for (const chain of clearing) {
    if (ownLimits.has(chain)) {
      throw new Error(
        `chain ${chain} is given both --chain-limits and --clear-chain-limits`,
      );
    }
    const limits = chains.get(chain.toString());
    if (limits === undefined) {
      throw new Error(
        `--clear-chain-limits names chain ${chain}, which the route does not list`,
      );
    }
    if (limits === null) {
      throw new Error(`chain ${chain} has no limits of its own to clear`);
    }
    chains.set(chain.toString(), null);
  }
  checkChainCount(chains.size);
  return [...chains].map(([chain, limits]) =>
    limits ? { chain: new BN(chain), limits } : { chain: new BN(chain) },
  );
}

/** The base route with each option given applied; an omitted option keeps the base's value. */
function patchRoute(
  base: BridgeRoute,
  listed: string[],
  controls: ProviderControls,
  options: RouteUpdateOptions,
  decimals: number,
): BridgeRoute {
  const limits: RouteLimits = {
    minAmount:
      options.minAmount === undefined
        ? base.limits.minAmount
        : parseNonNegativeUiAmount(options.minAmount, decimals, "--min-amount"),
    maxAmount:
      options.maxAmount === undefined
        ? base.limits.maxAmount
        : parsePositiveUiAmount(options.maxAmount, decimals, "--max-amount"),
    maxCostBps: options.maxCostBps ?? base.limits.maxCostBps,
  };
  if (limits.maxAmount.lt(limits.minAmount)) {
    throw new Error(
      "--max-amount must be greater than or equal to --min-amount; an omitted one keeps the route's value",
    );
  }
  return {
    sourceMint: base.sourceMint,
    destinationRecipient: base.destinationRecipient,
    providerProgram: base.providerProgram,
    managementMode:
      options.managementMode === undefined
        ? base.managementMode
        : parseManagementMode(options.managementMode),
    limits,
    controls,
    destinationChains: patchChains(
      base.destinationChains,
      listed,
      parseChainLimits(options.chainLimits, decimals),
      options.clearChainLimits,
    ),
  };
}

function sameIdentity(a: BridgeRouteIdentity, b: BridgeRouteIdentity) {
  return encodeBridgeRouteIdentity(a).equals(encodeBridgeRouteIdentity(b));
}

/** Equal in the program's encoding, so an absent and a null chain limit compare equal. */
function sameRoute(a: BridgeRoute, b: BridgeRoute) {
  return encodeBridgeRoute(a).equals(encodeBridgeRoute(b));
}

function routeIdentity(route: BridgeRouteIdentity): string {
  return `${route.sourceMint.toBase58()} to ${route.destinationRecipient.toBase58()} through ${route.providerProgram.toBase58()}`;
}

function routeName(provider: string, route: BridgeRouteIdentity): string {
  return `the ${provider} route of ${routeIdentity(route)}`;
}

/**
 * The route update-route patches: the live one, or a staged set's copy with --base pending.
 * Without --base the live routes must hold it and a staged set must not hold another version.
 */
function routeToPatch(
  sets: RouteSets,
  identity: BridgeRouteIdentity,
  base: RouteSetName | undefined,
  provider: string,
): RouteBase {
  const find = (routes: BridgeRoute[] | null) =>
    routes?.find((route) => sameIdentity(route, identity));
  const live = find(sets.live);
  const pending = find(sets.pending);
  const name = routeName(provider, identity);
  if (!live && !pending) {
    throw new Error(
      `Neither the live routes nor a staged set hold ${name}: allow it with allow-route`,
    );
  }
  if (base === "pending") {
    if (!pending) {
      throw new Error(`No staged set holds ${name}`);
    }
    return { route: pending, set: "pending" };
  }
  if (!live) {
    throw new Error(
      base === "live"
        ? `The live routes do not hold ${name}`
        : `The live routes do not hold ${name}; a staged set does: patch its copy with --base pending`,
    );
  }
  if (base === undefined && pending && !sameRoute(live, pending)) {
    throw new Error(
      `The live routes and the staged set hold different versions of ${name}: name the one to patch with --base live or --base pending`,
    );
  }
  return { route: live, set: "live" };
}

/** The mint of the one route to `destinationRecipient` through `providerProgram`, live or staged. */
function soleRouteMint(
  sets: RouteSets,
  destinationRecipient: PublicKey,
  providerProgram: PublicKey,
  provider: string,
): PublicKey {
  const mints = new Map<string, PublicKey>();
  for (const route of [...(sets.live ?? []), ...(sets.pending ?? [])]) {
    if (
      route.destinationRecipient.equals(destinationRecipient) &&
      route.providerProgram.equals(providerProgram)
    ) {
      mints.set(route.sourceMint.toBase58(), route.sourceMint);
    }
  }
  if (mints.size === 0) {
    throw new Error(
      `Neither the live routes nor a staged set hold a ${provider} route to ${destinationRecipient.toBase58()}: allow it with allow-route`,
    );
  }
  if (mints.size > 1) {
    throw new Error(
      `The ${provider} routes to ${destinationRecipient.toBase58()} carry ${mints.size} mints (${[...mints.keys()].join(", ")}): name one with --source-mint`,
    );
  }
  return [...mints.values()][0];
}

/** A CCTP destination caller: an address, or anyone, which the default key encodes. */
function parseDestinationCaller(value: string): PublicKey {
  return value.trim().toLowerCase() === "anyone"
    ? PublicKey.default
    : parseRecipientPublicKey(value);
}

function parseRecipientPublicKey(recipient: string): PublicKey {
  const normalized = recipient.trim();
  if (isValidEvmAddress(normalized)) {
    return evmAddressToPublicKey(normalized);
  }

  const hex = normalized.replace(/^0x/, "");
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
    const bytes = Buffer.from(hex, "hex");
    if (bytes.length === 20) {
      return evmAddressToPublicKey(`0x${hex}`);
    }
    if (bytes.length === 32) {
      return new PublicKey(bytes);
    }
  }

  return new PublicKey(normalized);
}

function formatRoute(route: BridgeRoute) {
  return {
    ...route,
    managementMode: formatManagementMode(route.managementMode),
    // Limits show only on a chain that has its own; the route's apply to the rest.
    destinationChains: route.destinationChains.map(({ chain, limits }) => ({
      chain: chain.toString(),
      ...(limits ? { limits } : {}),
    })),
  };
}

function printRouteSets(sets: RouteSets) {
  if (!sets.live && !sets.pending) {
    console.log("No routes are set for this provider.");
    return;
  }
  // `live` is what a send may use now; `committed` is the set the timelock governs, shown when
  // an immediate edit has tightened the live routes below it.
  const tightened =
    sets.live !== null &&
    sets.committed !== null &&
    JSON.stringify(sets.live.map(formatRoute)) !==
      JSON.stringify(sets.committed.map(formatRoute));
  // The generations let an operator recompute a hash: the account's write count, and the one
  // each named set took.
  printJson({
    paused: sets.paused,
    generation: sets.generation?.toString() ?? null,
    live: sets.live?.map(formatRoute) ?? null,
    ...(tightened ? { committed: sets.committed!.map(formatRoute) } : {}),
    liveHash: sets.liveHash,
    committedGeneration: sets.committedGeneration?.toString() ?? null,
    pending: sets.pending?.map(formatRoute) ?? null,
    pendingHash: sets.pendingHash,
    pendingGeneration: sets.pendingGeneration?.toString() ?? null,
    // True when the staged list holds no commitment while the live one does: applying it stops
    // every send, which `pending: null` alone does not say.
    pendingCleared: sets.pendingCleared,
  });
}

function formatLimits(limits: RouteLimits, decimals: number): string {
  return `min-amount ${formatUiAmount(limits.minAmount, decimals)}, max-amount ${formatUiAmount(limits.maxAmount, decimals)}, max-cost-bps ${limits.maxCostBps}`;
}

/** A route's fields but its chains, each by the option that sets it, amounts in UI units. */
function routeFields(
  route: BridgeRoute,
  decimals: number,
): Map<string, string> {
  const fields = new Map<string, string>([
    ["management-mode", formatManagementMode(route.managementMode)],
    ["min-amount", formatUiAmount(route.limits.minAmount, decimals)],
    ["max-amount", formatUiAmount(route.limits.maxAmount, decimals)],
    ["max-cost-bps", route.limits.maxCostBps.toString()],
  ]);
  if ("cctp" in route.controls) {
    const { destinationCaller, minFinalityThreshold } = route.controls.cctp;
    fields.set(
      "destination-caller",
      destinationCaller.equals(PublicKey.default)
        ? "anyone"
        : destinationCaller.toBase58(),
    );
    fields.set("min-finality", minFinalityThreshold.toString());
  } else {
    fields.set("oft-store", route.controls.layerzeroOft.oftStore.toBase58());
  }
  return fields;
}

function chainList(route: BridgeRoute): string {
  return route.destinationChains
    .map(({ chain }) => chain.toString())
    .join(", ");
}

/** Each chain with the limits that apply on it: its own, else the route's. */
function chainLines(route: BridgeRoute, decimals: number): string[] {
  return route.destinationChains.map(
    ({ chain, limits }) =>
      `chain ${chain.toString()}: ${formatLimits(limits ?? route.limits, decimals)} (${limits ? "own limits" : "the route's limits"})`,
  );
}

/**
 * One line per field that differs, then the chain list, each added chain with the limits that
 * apply on it, and each kept chain whose own limits changed.
 */
function routeChanges(
  before: BridgeRoute,
  after: BridgeRoute,
  decimals: number,
): string[] {
  const was = routeFields(before, decimals);
  const lines = [...routeFields(after, decimals)]
    .filter(([field, value]) => was.get(field) !== value)
    .map(([field, value]) => `${field}: ${was.get(field)} -> ${value}`);
  if (chainList(before) !== chainList(after)) {
    lines.push(`chains: ${chainList(before)} -> ${chainList(after)}`);
  }
  const own = (limits: RouteLimits | null | undefined) =>
    limits ? formatLimits(limits, decimals) : "the route's";
  const ownBefore = new Map(
    before.destinationChains.map(({ chain, limits }) => [
      chain.toString(),
      own(limits),
    ]),
  );
  for (const { chain, limits } of after.destinationChains) {
    const previous = ownBefore.get(chain.toString());
    if (previous === undefined) {
      lines.push(
        `chain ${chain.toString()} added: ${formatLimits(limits ?? after.limits, decimals)} (${limits ? "own limits" : "the route's limits"})`,
      );
    } else if (previous !== own(limits)) {
      lines.push(
        `chain ${chain.toString()} limits: ${previous} -> ${own(limits)}`,
      );
    }
  }
  return lines;
}

const indent = (line: string) => `  ${line}`;

function timelockLine(duration: number): string {
  return duration > 0
    ? `Vault timelock: ${duration} seconds`
    : "Vault timelock: none";
}

async function mintDecimals(
  context: CliContext,
  mint: PublicKey,
): Promise<number> {
  const { mint: account } = await fetchMintAndTokenProgram(
    context.glamClient.connection,
    mint,
  );
  return account.decimals;
}

async function timelockDuration(context: CliContext): Promise<number> {
  return (await context.glamClient.fetchStateAccount()).timelockDuration;
}

/**
 * Prints the route allow-route writes, every field with the defaults it took, and the vault's
 * timelock, then signs through the usual confirmation; the lines print with --yes too.
 */
async function sendNewRoute(
  context: CliContext,
  provider: string,
  route: BridgeRoute,
  decimals: number,
  send: () => Promise<string>,
  confirm: { yes: boolean; message: string },
) {
  console.log(
    [
      `Allowing ${routeName(provider, route)}:`,
      ...[...routeFields(route, decimals)].map(([field, value]) =>
        indent(`${field}: ${value}`),
      ),
      "Limits on each chain:",
      ...chainLines(route, decimals).map(indent),
      timelockLine(await timelockDuration(context)),
    ].join("\n"),
  );
  await executeTxWithErrorHandling(
    send,
    { skip: confirm.yes, message: confirm.message },
    (txSig) => `${provider} route added: ${txSig}`,
  );
}

/**
 * Refuses an update that leaves the route as it is, prints each field that changes and the
 * vault's timelock, then signs through the usual confirmation; the lines print with --yes too.
 */
async function sendRouteUpdate(
  context: CliContext,
  provider: string,
  base: RouteBase,
  route: BridgeRoute,
  decimals: number,
  send: () => Promise<string>,
  confirm: { yes: boolean; message: string },
) {
  const from = base.set === "live" ? "the live routes" : "the staged set";
  if (sameRoute(base.route, route)) {
    throw new Error(
      `The request changes nothing on ${routeName(provider, route)} in ${from}`,
    );
  }
  console.log(
    [
      `Updating ${routeName(provider, route)}, from ${from}:`,
      ...routeChanges(base.route, route, decimals).map(indent),
      "Limits on each chain after the update:",
      ...chainLines(route, decimals).map(indent),
      timelockLine(await timelockDuration(context)),
    ].join("\n"),
  );
  await executeTxWithErrorHandling(
    send,
    { skip: confirm.yes, message: confirm.message },
    (txSig) => `${provider} route updated: ${txSig}`,
  );
}

/**
 * For each provider whose staged commitment differs from the live one, the staged set against
 * the live routes: the routes it adds and removes and each field of a route it changes. A staged
 * list that holds no commitment where a live one exists lists every live route as removed. Empty
 * when no provider has a staged change.
 */
export async function stagedRouteChanges(
  context: CliContext,
): Promise<string[]> {
  const decimalsByMint = new Map<string, number>();
  const decimalsOf = async (mint: PublicKey) => {
    let decimals = decimalsByMint.get(mint.toBase58());
    if (decimals === undefined) {
      decimals = await mintDecimals(context, mint);
      decimalsByMint.set(mint.toBase58(), decimals);
    }
    return decimals;
  };
  const providers = [
    ["CCTP", context.glamClient.bridge.cctp],
    ["LayerZero OFT", context.glamClient.bridge.oft],
  ] as const;
  const lines: string[] = [];
  for (const [provider, routes] of providers) {
    const sets = await routes.fetchRouteSets();
    if (sets.pendingCleared) {
      lines.push(
        `Staged ${provider} routes, against the live routes:`,
        indent(
          `The staged list holds no ${provider} policy: applying it stops every ${provider} send`,
        ),
        ...(sets.live ?? []).map((route) =>
          indent(`[-] ${routeIdentity(route)}`),
        ),
      );
      continue;
    }
    if (sets.pendingHash === null) {
      continue;
    }
    lines.push(`Staged ${provider} routes, against the live routes:`);
    if (sets.pending === null) {
      lines.push(
        indent(
          "The staged commitment names a set the routes account does not hold",
        ),
      );
      continue;
    }
    const live = sets.live ?? [];
    const changes: string[] = [];
    for (const route of sets.pending) {
      const before = live.find((candidate) => sameIdentity(candidate, route));
      if (before && sameRoute(before, route)) {
        continue;
      }
      const decimals = await decimalsOf(route.sourceMint);
      changes.push(
        ...(before
          ? [
              `[~] ${routeIdentity(route)}`,
              ...routeChanges(before, route, decimals).map(indent),
            ]
          : [
              `[+] ${routeIdentity(route)}`,
              ...[...routeFields(route, decimals)].map(([field, value]) =>
                indent(`${field}: ${value}`),
              ),
              ...chainLines(route, decimals).map(indent),
            ]),
      );
    }
    for (const route of live) {
      if (!sets.pending.some((candidate) => sameIdentity(candidate, route))) {
        changes.push(`[-] ${routeIdentity(route)}`);
      }
    }
    lines.push(
      ...(changes.length > 0
        ? changes
        : ["The staged set holds the live routes unchanged"]
      ).map(indent),
    );
  }
  return lines;
}

/** What an allow or an update does under a timelock: only a change that can add risk waits. */
function routeEditDescription(provider: string, verb: RouteVerb) {
  return verb === "add"
    ? `Allow a ${provider} route. Amounts are in UI units of the source mint, whose decimals are read from the mint. A chain given its own limits (--chain-limits) uses them in place of the route's. Every field of the route, defaults included, prints before the transaction is signed. Under a timelock the route is staged for the window, a removed route put back included; to stop sends for a while, pause the provider instead of removing the route`
    : `Patch the ${provider} route with the same mint, recipient and provider. Every option is optional: one given replaces its field, an omitted one keeps the value of the route patched, the live one unless --base names a staged set's copy. Listed chains replace the route's list and a kept chain keeps limits of its own; --chain-limits sets a chain's own limits, which replace the route's for that chain, and --clear-chain-limits drops them. Amounts are in UI units of the source mint, whose decimals are read from the mint. Each field that changes prints before the transaction is signed. A change is judged per chain on the limits that apply to it. A change that tightens the live route (a lower maximum or cost bound, the route's or a chain's; a minimum moved either way; fewer chains; a narrower mode; a higher finality floor) applies to the live routes at once and replaces the route in a staged set when that set holds it; any other change, a maximum or cost bound raised even back toward its committed value included, is staged under a timelock as an edit of the staged set, which must hold the route (allow it otherwise). An edit that touches a staged set restarts the vault's whole timelock window`;
}

/** An option's help; on update-route it says that an omitted option keeps the route's value. */
function fieldHelp(help: string, verb: RouteVerb): string {
  return verb === "add" ? help : `${help} (kept when omitted)`;
}

/**
 * The route field options. allow-route gives each a default and requires --max-amount;
 * update-route gives none, so an omitted one keeps the patched route's value, and adds
 * --clear-chain-limits and --base.
 */
function routeOptions(command: Command, verb: RouteVerb) {
  const add = verb === "add";
  const kept = (help: string) => fieldHelp(help, verb);
  const maxAmount = kept(
    "Maximum source amount in UI units, for every chain without limits of its own",
  );
  (add
    ? command.requiredOption("--max-amount <amount>", maxAmount)
    : command.option("--max-amount <amount>", maxAmount)
  )
    .option(
      "--management-mode <mode>",
      kept("unmanaged | managed | either"),
      add ? "unmanaged" : undefined,
    )
    .option(
      "--min-amount <amount>",
      kept(
        "Minimum source amount in UI units, for every chain without limits of its own",
      ),
      add ? "0" : undefined,
    )
    .option(
      "--max-cost-bps <bps>",
      kept(
        "Largest cost of a transfer, in basis points of the amount (fee, slippage), for every chain without limits of its own; at most 1000, ten percent",
      ),
      (value: string) => parseCostBps(value, "max-cost-bps"),
      add ? 10 : undefined,
    )
    .option(
      "--chain-limits <chain>:<min>:<max>:<bps>",
      `A chain's own limits, which replace the route's for that chain: the minimum and maximum source amounts in UI units and the cost bound in basis points, at most 1000. Repeat for each chain that differs; the chain need not also be listed${add ? "" : ", and a chain not named keeps its own"}`,
      collectArrayValues,
      [],
    );
  if (!add) {
    command
      .option(
        "--clear-chain-limits <chain>",
        "Drop a chain's own limits, so the route's apply on it; repeat for each chain",
        collectArrayValues,
        [],
      )
      .addOption(
        new Option(
          "--base <set>",
          "The copy of the route to patch: live, or pending for a staged set's. Required when the two differ; pending patches a route only a staged set holds",
        ).choices(["live", "pending"]),
      );
  }
  return command;
}

/**
 * The shared route commands of one provider: view, remove, pause and resume, and close the
 * routes account.
 */
function installProviderRouteCommands(
  program: Command,
  provider: {
    name: string;
    routes: () => {
      fetchRouteSets(): Promise<RouteSets>;
      removeRoute(
        identity: Pick<
          BridgeRoute,
          "sourceMint" | "destinationRecipient" | "providerProgram"
        >,
        txOptions?: any,
      ): Promise<string>;
      pause(txOptions?: any): Promise<string>;
      unpause(txOptions?: any): Promise<string>;
      closeRoutes(txOptions?: any): Promise<string>;
    };
    defaultProvider?: PublicKey;
  },
  context: CliContext,
) {
  program
    .command("view-routes")
    .alias("view-policy")
    .description(
      `View the ${provider.name} routes: whether sends are paused, the live routes a send may use, the committed set when the live routes were tightened below it, and any staged set. A chain listed with limits of its own uses them in place of the route's`,
    )
    .action(async () => {
      printRouteSets(await provider.routes().fetchRouteSets());
    });

  program
    .command("remove-route")
    .description(
      `Remove a ${provider.name} route. Applies at once, timelock or not, and also removes the route from a staged set`,
    )
    .argument("<source-mint>", "Source token mint address or symbol")
    .argument("<destination-recipient>")
    .option(
      "--provider-program <pubkey>",
      "Provider program public key",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation", false)
    .action(
      async (
        sourceMintInput: string,
        destinationRecipient: string,
        { providerProgram, yes }: { providerProgram?: PublicKey; yes: boolean },
      ) => {
        const sourceMint = await resolveTokenPublicKey(
          context.glamClient,
          sourceMintInput,
        );
        const program = providerProgram ?? provider.defaultProvider;
        if (!program) {
          throw new Error("--provider-program is required");
        }
        await executeTxWithErrorHandling(
          () =>
            provider.routes().removeRoute(
              {
                sourceMint,
                destinationRecipient:
                  parseRecipientPublicKey(destinationRecipient),
                providerProgram: program,
              },
              context.txOptions,
            ),
          {
            skip: yes,
            message: `Confirm removing the ${provider.name} route to ${destinationRecipient}?`,
          },
          (txSig) => `${provider.name} route removed: ${txSig}`,
        );
      },
    );

  program
    .command("pause-routes")
    .description(
      `Stop ${provider.name} sends at once: the owner, or a delegate holding the bridge Pause permission. The routes and the vault's policy are untouched`,
    )
    .option("-y, --yes", "Skip confirmation", false)
    .action(async ({ yes }: { yes: boolean }) => {
      await executeTxWithErrorHandling(
        () => provider.routes().pause(context.txOptions),
        {
          skip: yes,
          message: `Confirm pausing ${provider.name} sends?`,
        },
        (txSig) => `${provider.name} sends paused: ${txSig}`,
      );
    });

  program
    .command("unpause-routes")
    .description(`Resume ${provider.name} sends at once: the owner only`)
    .option("-y, --yes", "Skip confirmation", false)
    .action(async ({ yes }: { yes: boolean }) => {
      await executeTxWithErrorHandling(
        () => provider.routes().unpause(context.txOptions),
        {
          skip: yes,
          message: `Confirm resuming ${provider.name} sends?`,
        },
        (txSig) => `${provider.name} sends resumed: ${txSig}`,
      );
    });

  program
    .command("close-routes")
    .description(
      `Close the ${provider.name} routes account and reclaim its rent. Refused while the vault's live or staged policy still names a ${provider.name} route set: clear the policy first (under a timelock the clear is itself staged: wait out the window and apply it) or emergency-remove the integration, and make sure no staged change still names the set; close the route accounts before closing the state.`,
    )
    .option("-y, --yes", "Skip confirmation", false)
    .action(async ({ yes }: { yes: boolean }) => {
      await executeTxWithErrorHandling(
        () => provider.routes().closeRoutes(context.txOptions),
        {
          skip: yes,
          message: `Confirm closing the ${provider.name} routes account?`,
        },
        (txSig) => `${provider.name} routes account closed: ${txSig}`,
      );
    });
}

function installCctpRouteCommands(program: Command, context: CliContext) {
  const tokenMessengerMinter = new PublicKey(
    "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
  );
  installProviderRouteCommands(
    program,
    {
      name: "CCTP",
      routes: () => context.glamClient.bridge.cctp,
      defaultProvider: tokenMessengerMinter,
    },
    context,
  );

  type CctpOptions = {
    sourceMint?: string;
    destinationCaller?: string;
    minFinality?: number;
  };

  const routeCommand = (verb: RouteVerb) =>
    routeOptions(
      program
        .command(verb === "add" ? "allow-route" : "update-route")
        .description(routeEditDescription("CCTP", verb))
        .argument(
          "<destination-recipient>",
          "Recipient address on the destination",
        )
        .argument(
          "[domains...]",
          verb === "add"
            ? "CCTP destination domains the route allows; a domain given --chain-limits need not be listed"
            : "CCTP destination domains, which replace the route's list; a domain given --chain-limits need not be listed",
        )
        .option(
          "--source-mint <mint>",
          verb === "add"
            ? "Source token mint address or symbol (default: the USDC a CCTP send uses on this cluster, mainnet USDC on mainnet and devnet USDC elsewhere)"
            : "Source token mint address or symbol (default: the mint of the one CCTP route to this recipient, live or staged; required when there are more)",
        )
        .option(
          "--destination-caller <address>",
          verb === "add"
            ? "The only address allowed to deliver the transfer, or anyone (default: anyone)"
            : fieldHelp(
                "The only address allowed to deliver the transfer, or anyone",
                verb,
              ),
        )
        .option(
          "--min-finality <threshold>",
          fieldHelp(
            "Finality floor: 1000 (confirmed, fast) or 2000 (finalized)",
            verb,
          ),
          parseMinFinality,
          verb === "add" ? 2000 : undefined,
        )
        .option("-y, --yes", "Skip confirmation", false),
      verb,
    );

  routeCommand("add").action(
    async (
      destinationRecipient: string,
      domains: string[],
      options: NewRouteOptions & CctpOptions & { minFinality: number },
    ) => {
      // The SDK's CCTP send builder takes the same cluster selection.
      const sourceMint =
        options.sourceMint !== undefined
          ? await resolveTokenPublicKey(context.glamClient, options.sourceMint)
          : context.glamClient.isMainnet
            ? USDC
            : USDC_DEVNET;
      const decimals = await mintDecimals(context, sourceMint);
      const route = buildRoute(
        {
          sourceMint,
          destinationRecipient: parseRecipientPublicKey(destinationRecipient),
          providerProgram: tokenMessengerMinter,
        },
        domains,
        {
          cctp: {
            // The default key lets anyone deliver. An empty value is read,
            // and refused, like any other: only an option left out means it.
            destinationCaller:
              options.destinationCaller !== undefined
                ? parseDestinationCaller(options.destinationCaller)
                : PublicKey.default,
            minFinalityThreshold: options.minFinality,
          },
        },
        options,
        decimals,
      );
      await sendNewRoute(
        context,
        "CCTP",
        route,
        decimals,
        () => context.glamClient.bridge.cctp.addRoute(route, context.txOptions),
        {
          yes: options.yes,
          message: `Confirm allowing CCTP transfers to ${destinationRecipient} on domains ${describeChains(route.destinationChains)}?`,
        },
      );
    },
  );

  routeCommand("update").action(
    async (
      destinationRecipient: string,
      domains: string[],
      options: RouteUpdateOptions & CctpOptions,
    ) => {
      const recipient = parseRecipientPublicKey(destinationRecipient);
      const sets = await context.glamClient.bridge.cctp.fetchRouteSets();
      const sourceMint =
        options.sourceMint !== undefined
          ? await resolveTokenPublicKey(context.glamClient, options.sourceMint)
          : soleRouteMint(sets, recipient, tokenMessengerMinter, "CCTP");
      const base = routeToPatch(
        sets,
        {
          sourceMint,
          destinationRecipient: recipient,
          providerProgram: tokenMessengerMinter,
        },
        options.base,
        "CCTP",
      );
      if (!("cctp" in base.route.controls)) {
        throw new Error(
          `${routeName("CCTP", base.route)} carries no CCTP controls`,
        );
      }
      const { destinationCaller, minFinalityThreshold } =
        base.route.controls.cctp;
      const decimals = await mintDecimals(context, sourceMint);
      const route = patchRoute(
        base.route,
        domains,
        {
          cctp: {
            destinationCaller:
              options.destinationCaller === undefined
                ? destinationCaller
                : parseDestinationCaller(options.destinationCaller),
            minFinalityThreshold: options.minFinality ?? minFinalityThreshold,
          },
        },
        options,
        decimals,
      );
      await sendRouteUpdate(
        context,
        "CCTP",
        base,
        route,
        decimals,
        () =>
          context.glamClient.bridge.cctp.updateRoute(route, context.txOptions),
        {
          yes: options.yes,
          message: `Confirm updating CCTP transfers to ${destinationRecipient} on domains ${describeChains(route.destinationChains)}?`,
        },
      );
    },
  );
}

type OftSendOptions = {
  nativeFeeLamports: BN;
  minAmount?: string;
  lzTokenFee?: BN;
  options?: string;
  composeMsg?: string;
  managed: boolean;
  lookupTable: PublicKey[];
  yes: boolean;
};

function installLayerzeroOftCommands(program: Command, context: CliContext) {
  installProviderRouteCommands(
    program,
    { name: "LayerZero OFT", routes: () => context.glamClient.bridge.oft },
    context,
  );

  const routeCommand = (verb: RouteVerb) => {
    const command = program
      .command(verb === "add" ? "allow-route" : "update-route")
      .description(routeEditDescription("LayerZero OFT", verb))
      .argument("<source-mint>", "Source token mint address or symbol")
      .argument("<destination-recipient>")
      .argument(
        "<provider-program>",
        "OFT program public key",
        validatePublicKey,
      )
      .argument(
        "[destination-chains...]",
        verb === "add"
          ? "LayerZero endpoint ids the route allows; an endpoint id given --chain-limits need not be listed"
          : "LayerZero endpoint ids, which replace the route's list; an endpoint id given --chain-limits need not be listed",
      );
    if (verb === "add") {
      command.requiredOption(
        "--oft-store <pubkey>",
        "The OFT store the route binds",
        validatePublicKey,
      );
    } else {
      command.option(
        "--oft-store <pubkey>",
        fieldHelp("The OFT store the route binds", verb),
        validatePublicKey,
      );
    }
    return routeOptions(
      command.option("-y, --yes", "Skip confirmation", false),
      verb,
    );
  };

  routeCommand("add").action(
    async (
      sourceMintInput: string,
      destinationRecipient: string,
      providerProgram: PublicKey,
      destinationChains: string[],
      options: NewRouteOptions & { oftStore: PublicKey },
    ) => {
      const sourceMint = await resolveTokenPublicKey(
        context.glamClient,
        sourceMintInput,
      );
      const decimals = await mintDecimals(context, sourceMint);
      const route = buildRoute(
        {
          sourceMint,
          destinationRecipient: parseRecipientPublicKey(destinationRecipient),
          providerProgram,
        },
        destinationChains,
        { layerzeroOft: { oftStore: options.oftStore } },
        options,
        decimals,
      );
      await sendNewRoute(
        context,
        "LayerZero OFT",
        route,
        decimals,
        () => context.glamClient.bridge.oft.addRoute(route, context.txOptions),
        {
          yes: options.yes,
          message: `Confirm allowing the LayerZero OFT route to ${destinationRecipient} on chains ${describeChains(route.destinationChains)}?`,
        },
      );
    },
  );

  routeCommand("update").action(
    async (
      sourceMintInput: string,
      destinationRecipient: string,
      providerProgram: PublicKey,
      destinationChains: string[],
      options: RouteUpdateOptions & { oftStore?: PublicKey },
    ) => {
      const sourceMint = await resolveTokenPublicKey(
        context.glamClient,
        sourceMintInput,
      );
      const base = routeToPatch(
        await context.glamClient.bridge.oft.fetchRouteSets(),
        {
          sourceMint,
          destinationRecipient: parseRecipientPublicKey(destinationRecipient),
          providerProgram,
        },
        options.base,
        "LayerZero OFT",
      );
      if (!("layerzeroOft" in base.route.controls)) {
        throw new Error(
          `${routeName("LayerZero OFT", base.route)} carries no OFT controls`,
        );
      }
      const decimals = await mintDecimals(context, sourceMint);
      const route = patchRoute(
        base.route,
        destinationChains,
        {
          layerzeroOft: {
            oftStore:
              options.oftStore ?? base.route.controls.layerzeroOft.oftStore,
          },
        },
        options,
        decimals,
      );
      await sendRouteUpdate(
        context,
        "LayerZero OFT",
        base,
        route,
        decimals,
        () =>
          context.glamClient.bridge.oft.updateRoute(route, context.txOptions),
        {
          yes: options.yes,
          message: `Confirm updating the LayerZero OFT route to ${destinationRecipient} on chains ${describeChains(route.destinationChains)}?`,
        },
      );
    },
  );

  program
    .command("derive-aux-account")
    .argument("<transfer-id>", "transfer id pubkey or 32-byte hex/base64")
    .argument("<source-mint>", "Source token mint address or symbol")
    .option(
      "--signer <pubkey>",
      "Optional signer override for the derived seed",
      validatePublicKey,
    )
    .description(
      "Derive the temporary auxiliary token account used during OFT sends",
    )
    .action(
      async (
        transferId: string,
        sourceMintInput: string,
        { signer }: { signer?: string },
      ) => {
        const parsedTransferId = parseTransferId(transferId);
        const sourceMint = await resolveTokenPublicKey(
          context.glamClient,
          sourceMintInput,
        );
        const auxiliary =
          await context.glamClient.bridge.deriveOftAuxiliaryTokenAccount(
            parsedTransferId,
            sourceMint,
            signer ? new PublicKey(signer) : undefined,
          );
        printJson({
          transferId: parsedTransferId,
          seed: auxiliary.seed,
          address: auxiliary.address,
          tokenProgram: auxiliary.tokenProgram,
        });
      },
    );

  program
    .command("derive-nonce")
    .argument(
      "<endpoint-program>",
      "Endpoint program public key",
      validatePublicKey,
    )
    .argument("<sender>", "Sender public key", validatePublicKey)
    .argument("<destination-chain>", "", parseDestinationChain)
    .argument("<destination-recipient>")
    .description("Derive the LayerZero nonce PDA for an OFT route")
    .action(
      async (
        endpointProgram: PublicKey,
        sender: PublicKey,
        destinationChain: number,
        destinationRecipient: string,
      ) => {
        const nonce = context.glamClient.bridge.getLayerzeroNoncePda(
          endpointProgram,
          sender,
          destinationChain,
          parseRecipientPublicKey(destinationRecipient),
        );
        console.log(nonce.toBase58());
      },
    );

  program
    .command("send-usdt")
    .argument("<amount>", "USDT amount in UI units")
    .argument("<destination-chain>", "", parseDestinationChain)
    .argument("<destination-recipient>")
    .requiredOption(
      "--native-fee-lamports <lamports>",
      "LayerZero native fee in lamports/base units",
      (value: string) =>
        parsePositiveBn(value, "native-fee-lamports", U64_MAX_BN),
    )
    .option(
      "--min-amount <amount>",
      "Minimum destination amount in UI units, refused under the live route's cost bound on this chain; by default the amount less that bound, or 99.5 % of the amount when no live route is readable",
    )
    .option(
      "--lz-token-fee <amount>",
      "Optional LayerZero token fee in base units",
      (value: string) => parsePositiveBn(value, "lz-token-fee", U64_MAX_BN),
    )
    .option(
      "--options <hex-or-base64>",
      "Optional raw LayerZero options payload override",
    )
    .option(
      "--compose-msg <hex-or-base64>",
      "Optional raw LayerZero compose message payload; pass 'none' to encode compose_msg as None",
    )
    .option(
      "--managed",
      "Keep the inflight transfer managed until reconcile",
      false,
    )
    .option(
      "--lookup-table <pubkey>",
      "Optional extra address lookup table; repeat or pass comma-/space-separated values",
      collectPublicKeys,
      [],
    )
    .option("-y, --yes", "Skip confirmation", false)
    .description(
      "Bridge USDT through the checked-in direct LayerZero USDT0 OFT route",
    )
    .action(
      async (
        amount: string,
        destinationChain: number,
        destinationRecipient: string,
        {
          nativeFeeLamports,
          minAmount,
          lzTokenFee,
          options,
          composeMsg,
          managed,
          lookupTable,
          yes,
        }: OftSendOptions,
      ) => {
        const transferId = Keypair.generate().publicKey;
        // Every input is read before the confirmation, which shows the amount.
        const sourceAmount = parsePositiveUiAmount(amount, 6, "amount");
        const givenMinAmount =
          minAmount !== undefined
            ? parsePositiveUiAmount(minAmount, 6, "min-amount")
            : undefined;
        // The program refuses a quote above the amount sent.
        if (givenMinAmount?.gt(sourceAmount)) {
          fail(
            `min-amount ${minAmount!.trim()} USDT is above the ${amount.trim()} USDT sent, and the program refuses a quote above the amount`,
          );
        }
        const destination = parseRecipientPublicKey(destinationRecipient);
        // The floor the send carries, resolved once and shown: without
        // --min-amount, the live route's cost bound on the chain, else the
        // route profile's default. A floor or amount the live route refuses
        // stops here, before the confirmation.
        const minAmountLd =
          await context.glamClient.bridge.oft.resolveMinAmountLd({
            sourceMint: USDT,
            sourceAmount,
            destinationChain,
            destinationRecipient: destination,
            minAmountLd: givenMinAmount,
          });
        const sendParams = {
          transferId,
          sourceMint: USDT,
          sourceAmount,
          destinationChain,
          destinationRecipient: destination,
          nativeFeeLamports,
          minAmountLd,
          lzTokenFee,
          options:
            options !== undefined
              ? parseHexOrBase64Bytes(options, "options")
              : undefined,
          composeMsg: parseOptionalHexOrBase64Bytes(composeMsg, "composeMsg"),
          managed,
        };

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.bridge.oft.send(sendParams, {
              ...context.txOptions,
              lookupTables:
                lookupTable.length > 0
                  ? lookupTable
                  : context.txOptions.lookupTables,
            }),
          {
            skip: yes,
            // The floor and both fees go out with the amount.
            message: `Confirm LayerZero OFT send of ${amount.trim()} USDT to ${destinationRecipient} on chain ${destinationChain}, receiving at least ${formatUiAmount(minAmountLd, 6)} USDT, native fee ${nativeFeeLamports.toString()} lamports${
              lzTokenFee !== undefined
                ? `, LayerZero token fee ${lzTokenFee.toString()} base units`
                : ""
            }?`,
          },
          (txSig) =>
            `LayerZero OFT transfer submitted: ${txSig}\nTransfer ID: ${transferId}`,
        );
      },
    );
}

export function installBridgeCommands(program: Command, context: CliContext) {
  program
    .command("registry")
    .description("View the bridge registry for the active vault")
    .action(async () => {
      const registryPda = context.glamClient.bridge.getRegistryPda();
      const registry = await context.glamClient.bridge.fetchRegistry();
      if (!registry) {
        console.log("Bridge registry not initialized.");
        return;
      }
      printJson({
        pubkey: registryPda,
        ...registry,
        transfers: registry.transfers.slice(
          0,
          toSortableNumber(registry.managedTransferCount),
        ),
      });
    });

  program
    .command("record")
    .argument("<transfer-id>", "transfer id pubkey", validatePublicKey)
    .description("View a single bridge transfer record")
    .action(async (transferId: PublicKey) => {
      const record =
        await context.glamClient.bridge.fetchTransferRecordNullable(transferId);

      if (!record) {
        console.error(
          `Bridge transfer record not found for transfer ${transferId}`,
        );
        process.exit(1);
      }

      printJson(record);
    });

  program
    .command("validate")
    .alias("validate-managed-transfer")
    .argument("<transfer-id>", "transfer id pubkey", validatePublicKey)
    .description("Validate a managed bridge transfer")
    .option("-y, --yes", "Skip confirmation", false)
    .action(async (transferId: PublicKey, { yes }: { yes: boolean }) => {
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.bridge.validateManagedTransfer(
            transferId,
            context.txOptions,
          ),
        {
          skip: yes,
          message: `Confirm validating transfer ${transferId}?`,
        },
        (txSig) => `Transfer validated: ${txSig}`,
      );
    });

  program
    .command("settle")
    .argument("<transfer-id>", "transfer id pubkey or 32-byte hex/base64")
    .description("Settle a managed bridge transfer")
    .option("-y, --yes", "Skip confirmation", false)
    .action(async (transferId: string, { yes }: { yes: boolean }) => {
      const parsedTransferId = parseTransferId(transferId);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.bridge.settleManagedTransfer(
            parsedTransferId,
            context.txOptions,
          ),
        {
          skip: yes,
          message: `Confirm settling transfer ${parsedTransferId}?`,
        },
        (txSig) => `Transfer settled: ${txSig}`,
      );
    });

  const oft = program.command("oft").description("LayerZero OFT");
  installLayerzeroOftCommands(oft, context);
  const cctp = program
    .command("cctp")
    .description("Circle CCTP through ext_bridge");
  installCctpRouteCommands(cctp, context);
}
