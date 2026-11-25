import { BN } from "@coral-xyz/anchor";
import {
  HYPEREVM_NAV_ADAPTER_V2_EMITTER,
  RPI_PROTOCOL,
  RpiPolicy,
  type RpiPositionConfig,
  U8_MAX,
  U16_MAX,
  U32_MAX,
  evmAddressToBytes20,
  fetchMintAndTokenProgram,
  fromUiAmount,
  parseWormholeSignedVaa,
} from "@glamsystems/glam-sdk";
import { PublicKey } from "@solana/web3.js";
import { Command } from "commander";

import {
  type CliContext,
  clusterClock,
  executeTxWithErrorHandling,
  formatUiAmount,
  resolveTokenMint,
} from "../utils";
import { readVaultTimelock } from "../staging";
import { fail } from "../errors";
import {
  collectPublicKeys,
  I128_MAX_BN as I128_MAX,
  parseFixedBytes as parseFixedBytesBuffer,
  parseHexOrBase64Bytes,
  parsePositiveInteger,
  parseU64,
  parseUnsignedNumber,
} from "../parsing";

const I128_MIN = I128_MAX.addn(1).neg();

type SubmitOptions = {
  denom: string;
  mint?: string;
  timestamp?: string;
  externalShares?: string;
  yes: boolean;
};

type UpsertPositionOptions = {
  denom: string;
  mint?: string;
  freshnessSecs?: string;
  submitAllow: PublicKey[];
  validateAllow: PublicKey[];
  configureAllow: PublicKey[];
  tokenized?: boolean;
  disabled?: boolean;
  yes: boolean;
};

type UpsertWormholePositionOptions = {
  freshnessSecs?: string;
  submitAllow: PublicKey[];
  validateAllow: PublicKey[];
  configureAllow: PublicKey[];
  disabled?: boolean;
  yes: boolean;
};

type UpsertWormholeConfigOptions = {
  emitterChain: string;
  emitterAddress: string;
  payloadVersion: string;
  payloadType: string;
  maxAgeSeconds: string;
  yes: boolean;
};

type UpsertHyperliquidConfigOptions = {
  hyperliquidAccount: string;
  accountMarginSummaryPrecompile: string;
  spotBalancePrecompile: string;
  perpDexIndex: string;
  usdcSpotToken: string;
  yes: boolean;
};

type SubmitWormholeOptions = {
  maxSignaturesPerPost: string;
  guardianSet?: string;
  wormholeCoreBridgeProgram?: string;
  wormholeVerifyVaaShimProgram?: string;
  yes: boolean;
};

type RemovePositionOptions = {
  yes: boolean;
};

type ValidateOptions = {
  yes: boolean;
};

type ParsedPosition = {
  positionId: number[];
  positionLabel: string;
};

const HYPEREVM_WORMHOLE_CHAIN_ID = 47;
const HYPERLIQUID_NAV_PAYLOAD_VERSION = 2;
const HYPERLIQUID_NAV_PAYLOAD_TYPE = 2;
const ACCOUNT_MARGIN_SUMMARY_PRECOMPILE =
  "0x000000000000000000000000000000000000080F";
const SPOT_BALANCE_PRECOMPILE = "0x0000000000000000000000000000000000000801";
const usdDenomination = {
  denom: { usd: {} },
  mint: PublicKey.default,
} as const;

function parseFixedBytes(
  value: string,
  length: number,
  label: string,
): number[] {
  return Array.from(parseFixedBytesBuffer(value, label, length));
}

function parseBytes20(value: string, label: string): number[] {
  try {
    return evmAddressToBytes20(value);
  } catch {
    return parseFixedBytes(value, 20, label);
  }
}

function parseWormholeEmitterAddress(value: string): number[] {
  const bytes = parseHexOrBase64Bytes(value, "--emitter-address");
  if (bytes.length === 32) {
    return Array.from(bytes);
  }
  if (bytes.length === 20) {
    return [...new Array(12).fill(0), ...Array.from(bytes)];
  }

  throw new Error("--emitter-address must be either 20 or 32 bytes");
}

function validateHyperliquidSignedVaa(signedVaa: Buffer, positionId: number[]) {
  const parsed = parseWormholeSignedVaa(signedVaa);
  if (parsed.vaaBody.length < 51 + 38) {
    throw new Error("signed VAA body is too short for a GLAM Wormhole payload");
  }

  const payload = parsed.vaaBody.subarray(51);
  const magic = payload.subarray(0, 4).toString("ascii");
  if (magic !== "GLAM") {
    throw new Error(`Unexpected Wormhole payload magic: ${magic}`);
  }

  const version = payload.readUInt8(4);
  const payloadType = payload.readUInt8(5);
  if (
    version !== HYPERLIQUID_NAV_PAYLOAD_VERSION ||
    payloadType !== HYPERLIQUID_NAV_PAYLOAD_TYPE
  ) {
    throw new Error(
      `Unsupported GLAM Wormhole payload version/type: ${version}/${payloadType}`,
    );
  }

  const payloadPositionId = payload.subarray(6, 38);
  const expectedPositionId = Buffer.from(positionId);
  if (!payloadPositionId.equals(expectedPositionId)) {
    throw new Error(
      `VAA position id ${payloadPositionId.toString("hex")} does not match CLI position ${expectedPositionId.toString("hex")}`,
    );
  }
}

function encodePositionIdString(value: string): number[] {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0) {
    throw new Error("position must not be empty");
  }
  if (bytes.length > 32) {
    throw new Error(
      "position must be a pubkey, exactly 32 decoded bytes, or a UTF-8 string up to 32 bytes",
    );
  }

  const encoded = Buffer.alloc(32);
  bytes.copy(encoded);
  return Array.from(encoded);
}

export function parsePositionId(value: string): number[] {
  const normalized = value.trim();

  try {
    return Array.from(new PublicKey(normalized).toBytes());
  } catch {
    try {
      const bytes = parseHexOrBase64Bytes(normalized, "position");
      if (bytes.length === 32) {
        return Array.from(bytes);
      }
    } catch {}

    return encodePositionIdString(normalized);
  }
}

function formatPositionLabel(value: string, positionId: number[]): string {
  const normalized = value.trim();

  try {
    new PublicKey(normalized);
    return formatPositionId(positionId);
  } catch {}

  try {
    const bytes = parseHexOrBase64Bytes(normalized, "position");
    if (bytes.length === 32) {
      return formatPositionId(positionId);
    }
  } catch {}

  return `${JSON.stringify(normalized)} (${formatPositionId(positionId)})`;
}

function parsePosition(value: string): ParsedPosition {
  const positionId = parsePositionId(value);
  return {
    positionId,
    positionLabel: formatPositionLabel(value, positionId),
  };
}

function formatPositionId(positionId: number[]): string {
  return new PublicKey(Uint8Array.from(positionId)).toBase58();
}

/**
 * A signed UI amount in base units: a negative one is a liability. It is an
 * i128 on the wire, where the encoder wraps a value just past that range to
 * the other sign.
 *
 * The amount is a plain decimal: digits with an optional sign and point, as
 * in 5, +5, -0.5, .5 and 5. Other notations, such as 1e3 or 0x10, are refused.
 */
function parseSignedUiAmount(
  value: string,
  decimals: number,
  label: string,
): BN {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  const [, sign, whole, digits = ""] = match ?? [];
  if (!match || (whole === "" && digits === "")) {
    fail(`${label} must be a decimal amount`);
  }
  // Zeros past the last decimal place add nothing to the amount.
  const fraction = digits.replace(/0+$/, "");
  if (fraction.length > decimals) {
    fail(`${label} has more than ${decimals} decimal places`);
  }

  // The digits are scaled without their sign, which fromUiAmount would apply
  // to the whole part alone.
  const scaled = fromUiAmount(`${whole || "0"}.${fraction}`, decimals);
  const amount = sign === "-" ? scaled.neg() : scaled;
  if (amount.gt(I128_MAX) || amount.lt(I128_MIN)) {
    fail(
      `${label} is outside the i128 range of ${I128_MIN.toString()} to ${I128_MAX.toString()} base units`,
    );
  }
  return amount;
}

async function resolveDenomination(
  context: CliContext,
  options: SubmitOptions,
): Promise<{
  decimals: number;
  label: string;
  denomination: {
    denom: { usd: Record<string, never> } | { mint: Record<string, never> };
    mint: PublicKey;
  };
}> {
  const denom = options.denom.toLowerCase();

  if (denom === "usd") {
    if (options.mint) {
      throw new Error("--mint is only valid with --denom mint");
    }

    return {
      decimals: 6,
      label: "USD",
      denomination: {
        denom: { usd: {} },
        mint: PublicKey.default,
      },
    };
  }

  if (denom !== "mint") {
    throw new Error(
      `Unsupported denomination: ${options.denom}. Use usd or mint.`,
    );
  }

  if (!options.mint) {
    throw new Error("--mint is required when --denom mint");
  }

  const token = await resolveTokenMint(context.glamClient, options.mint);
  const mint = new PublicKey(token.address);

  return {
    decimals: token.decimals,
    label: token.symbol,
    denomination: {
      denom: { mint: {} },
      mint,
    },
  };
}

/** The fields of a position configuration an upsert writes. */
type PositionUpsert = Pick<
  RpiPositionConfig,
  | "positionType"
  | "sourceType"
  | "denomination"
  | "enabled"
  | "freshnessOverrideSecs"
  | "submitAllowlist"
  | "validateAllowlist"
  | "configureAllowlist"
>;

const variantName = (value: object) => Object.keys(value)[0];

function allowlistText(list: PublicKey[]): string {
  // An empty per-position list leaves the role-based permission to decide.
  return list.length === 0
    ? "none, so the permission alone decides"
    : list.map((key) => key.toBase58()).join(", ");
}

function positionFields(config: PositionUpsert): [string, string][] {
  return [
    ["enabled", config.enabled ? "yes" : "no"],
    [
      "freshness override",
      config.freshnessOverrideSecs === 0
        ? "0, so the vault default applies"
        : `${config.freshnessOverrideSecs} seconds`,
    ],
    ["submit allowlist", allowlistText(config.submitAllowlist)],
    ["validate allowlist", allowlistText(config.validateAllowlist)],
    ["configure allowlist", allowlistText(config.configureAllowlist)],
  ];
}

// ObservationState::MAX_POSITIONS in ext_rpi.
const MAX_POSITIONS = 16;

const sameDenomination = (
  a: RpiPositionConfig["denomination"],
  b: RpiPositionConfig["denomination"],
) => variantName(a.denom) === variantName(b.denom) && a.mint.equals(b.mint);

function sameIdentity(
  stored: RpiPositionConfig,
  config: PositionUpsert,
): boolean {
  return (
    variantName(stored.positionType) === variantName(config.positionType) &&
    variantName(stored.sourceType) === variantName(config.sourceType) &&
    sameDenomination(stored.denomination, config.denomination)
  );
}

function denominationText(denomination: RpiPositionConfig["denomination"]) {
  return variantName(denomination.denom) === "usd"
    ? "USD"
    : denomination.mint.toBase58();
}

function describeIdentity(config: PositionUpsert): string {
  return `${variantName(config.positionType)}, ${variantName(config.sourceType)}, denominated in ${denominationText(config.denomination)}`;
}

/** A per-position allowlist admits every signer when empty, else its keys. */
function requireOnAllowlist(
  list: PublicKey[],
  signer: PublicKey,
  action: string,
  name: string,
) {
  if (list.length > 0 && !list.some((key) => key.equals(signer))) {
    fail(
      `${action} requires a signer on its ${name} allowlist, and the signer ${signer} is not on it`,
    );
  }
}

/** The stored configuration of a registered position, which the command needs. */
async function registeredPosition(
  context: CliContext,
  positionId: number[],
  positionLabel: string,
): Promise<{ policy: RpiPolicy; position: RpiPositionConfig }> {
  const policy = await context.glamClient.rpi.fetchPolicy();
  const position = policy?.position(positionId);
  if (!policy || !position) {
    fail(
      `Position ${positionLabel} is not registered in the vault's live RPI policy; rpi upsert-position or upsert-wormhole-position registers it`,
    );
  }
  return { policy, position };
}

/** ext_rpi takes a Wormhole config only for a valued, Wormhole-sourced USD position. */
function requireWormholePosition(
  position: RpiPositionConfig,
  signer: PublicKey,
  positionLabel: string,
) {
  if (
    variantName(position.sourceType) !== "wormhole" ||
    variantName(position.positionType) !== "valued" ||
    variantName(position.denomination.denom) !== "usd"
  ) {
    fail(
      `A Wormhole config requires a valued, Wormhole-sourced position denominated in USD; position ${positionLabel} is ${describeIdentity(position)}`,
    );
  }
  requireOnAllowlist(
    position.configureAllowlist,
    signer,
    `Configuring position ${positionLabel}`,
    "configure",
  );
}

/** What submit_observation refuses, read before the confirmation. */
async function requireSubmittable(
  context: CliContext,
  positionId: number[],
  positionLabel: string,
  denomination: RpiPositionConfig["denomination"],
  timestamp: BN,
  externalShares: BN,
  now: BN,
) {
  const { policy, position } = await registeredPosition(
    context,
    positionId,
    positionLabel,
  );
  if (!position.enabled) {
    fail(
      `An observation requires an enabled position, and position ${positionLabel} is disabled`,
    );
  }
  const source = variantName(position.sourceType);
  if (source !== "trusted") {
    fail(
      `rpi submit sends a trusted observation, and position ${positionLabel} takes ${source} ones${source === "wormhole" ? ": use rpi submit-wormhole" : ""}`,
    );
  }
  requireOnAllowlist(
    position.submitAllowlist,
    context.glamClient.signer,
    `Submitting to position ${positionLabel}`,
    "submit",
  );
  if (!sameDenomination(position.denomination, denomination)) {
    const stored = denominationText(position.denomination);
    fail(
      `An observation takes its position's denomination: position ${positionLabel} is denominated in ${stored}, so pass ${stored === "USD" ? "--denom usd" : `--denom mint --mint ${stored}`}`,
    );
  }
  if (variantName(position.denomination.denom) === "mint") {
    const state = await context.glamClient.fetchStateAccount();
    const mint = position.denomination.mint;
    if (
      !mint.equals(state.baseAssetMint) &&
      !state.assets.some((asset: PublicKey) => asset.equals(mint))
    ) {
      fail(
        `An observation in a mint requires the vault's base asset or a mint on its asset allowlist, and ${mint} is neither`,
      );
    }
  }
  if (
    variantName(position.positionType) === "tokenized" &&
    externalShares.isZero()
  ) {
    fail(
      `A tokenized position's observation requires --external-shares above 0`,
    );
  }
  const freshness =
    position.freshnessOverrideSecs > 0
      ? position.freshnessOverrideSecs
      : policy.defaultFreshnessSecs;
  // ext_rpi compares with the cluster's clock when the submit runs, which is
  // no earlier than `now`, read from that clock before the confirmation.
  if (timestamp.gt(now)) {
    fail(
      `An observation cannot be from the future: --timestamp ${timestamp} is after the cluster's clock (${now})`,
    );
  }
  const age = now.sub(timestamp);
  // bn.js holds a plain number to 26 bits, and a window is a u32.
  if (age.gt(new BN(freshness))) {
    fail(
      `An observation must be within the position's freshness window of ${freshness} seconds, and --timestamp ${timestamp} is ${age} seconds old on the cluster's clock`,
    );
  }
}

/**
 * The confirmation of an upsert. ext_rpi replaces the enabled flag, the
 * freshness override and the three allowlists of a stored position with the
 * ones sent, so an option left out sends its default in place of the stored
 * value. It also writes the vault's observation state when the instruction
 * lands, whatever the timelock does with the policy.
 */
async function upsertMessage(
  context: CliContext,
  positionId: number[],
  positionLabel: string,
  config: PositionUpsert,
  denominationLabel: string,
): Promise<{
  message: string;
  outcome: (txSig: string) => string;
}> {
  const [timelock, live] = await Promise.all([
    readVaultTimelock(context),
    context.glamClient.rpi.fetchPolicy(),
  ]);
  const stored = live?.position(positionId);
  const identity = `${variantName(config.positionType)}, ${variantName(config.sourceType)}, denominated in ${denominationLabel}`;
  const signer = context.glamClient.signer;
  if (stored) {
    // The type, the source and the denomination of a position never change.
    if (!sameIdentity(stored, config)) {
      fail(
        `An upsert keeps a position's type, source and denomination: position ${positionLabel} is ${describeIdentity(stored)}, and this sends ${identity}`,
      );
    }
    requireOnAllowlist(
      stored.configureAllowlist,
      signer,
      `Configuring position ${positionLabel}`,
      "configure",
    );
  } else {
    // ext_rpi refuses a new position whose configure allowlist leaves out its
    // creator, and a seventeenth position in the observation state.
    requireOnAllowlist(
      config.configureAllowlist,
      signer,
      `Creating position ${positionLabel}`,
      "configure",
    );
    const state = await context.glamClient.rpi.fetchObservationState();
    if ((state?.positionsLen ?? 0) >= MAX_POSITIONS) {
      fail(
        `The vault's RPI observation state holds ${MAX_POSITIONS} positions, the most it can, so position ${positionLabel} cannot be added; rpi remove-position frees one`,
      );
    }
  }
  const fields = positionFields(config);
  const before = stored ? positionFields(stored) : undefined;
  const lines = [
    `Confirm ${stored ? "updating" : "creating"} RPI position ${positionLabel} (${identity})?`,
    ...fields.map(([label, value], index) => {
      const previous = before?.[index][1];
      return previous !== undefined && previous !== value
        ? `  ${label}: ${previous} -> ${value}`
        : `  ${label}: ${value}`;
    }),
  ];
  if (stored) {
    lines.push(
      "An upsert replaces each field above: an option left out sends its default, not the stored value.",
    );
  }
  if (!config.enabled) {
    lines.push(
      "Disabling clears every observation the position holds, when this lands.",
    );
  }
  if (timelock.active) {
    if (!stored) {
      lines.push(
        "The position joins the vault's observation state when this lands; its configuration waits for the timelock with the policy.",
      );
    }
    const staged = await timelock.policy(
      async () => live,
      () => context.glamClient.extRpiProgram.programId,
      RPI_PROTOCOL,
      RpiPolicy.decode,
    );
    if (staged.stagedApart) {
      lines.push(
        "A change of the RPI policy is already staged: ext_rpi builds this upsert from the live policy, so applying it replaces the staged change.",
      );
    }
  }
  return {
    message: timelock.confirm(lines.join("\n")),
    outcome: timelock.outcome(`RPI position ${positionLabel} upserted`),
  };
}

/** A signed amount of an observation in UI units of its denomination. */
function formatSignedAmount(amount: BN, decimals: number): string {
  return `${amount.isNeg() ? "-" : ""}${formatUiAmount(amount.abs(), decimals)}`;
}

/** StoredI128: an i128 as its 16 little-endian bytes. */
function storedI128(value: { bytes: number[] }): BN {
  return new BN(Buffer.from(value.bytes), "le").fromTwos(128);
}

export function installRpiCommands(program: Command, context: CliContext) {
  program
    .command("upsert-position")
    .description(
      "Create or update a registered position and initialize vault observation state",
    )
    .argument(
      "<position>",
      "registered position pubkey, UTF-8 string id, or 32-byte encoded position id",
    )
    .option("--denom <denom>", "observation denomination: usd or mint", "usd")
    .option("--mint <token>", "mint address or symbol when --denom mint")
    .option(
      "--freshness-secs <u32>",
      "freshness override in seconds, defaults to 0",
      "0",
    )
    .option(
      "--submit-allow <pubkey>",
      "submit allowlist entry; repeat or pass comma-/space-separated values",
      collectPublicKeys,
      [],
    )
    .option(
      "--validate-allow <pubkey>",
      "validate allowlist entry; repeat or pass comma-/space-separated values",
      collectPublicKeys,
      [],
    )
    .option(
      "--configure-allow <pubkey>",
      "configure allowlist entry; repeat or pass comma-/space-separated values",
      collectPublicKeys,
      [],
    )
    .option("--tokenized", "create as tokenized instead of valued", false)
    .option("--disabled", "upsert with enabled=false", false)
    .option("-y, --yes", "Skip confirmation", false)
    .action(async (position: string, options: UpsertPositionOptions) => {
      const { positionId, positionLabel } = parsePosition(position);
      const { denomination, label } = await resolveDenomination(context, {
        denom: options.denom,
        mint: options.mint,
        yes: options.yes,
      });
      const freshnessOverrideSecs = parseUnsignedNumber(
        options.freshnessSecs ?? "0",
        "--freshness-secs",
        U32_MAX,
      );
      const config: PositionUpsert = {
        positionType: options.tokenized ? { tokenized: {} } : { valued: {} },
        sourceType: { trusted: {} },
        denomination,
        enabled: !options.disabled,
        freshnessOverrideSecs,
        submitAllowlist: options.submitAllow || [],
        validateAllowlist: options.validateAllow || [],
        configureAllowlist: options.configureAllow || [],
      };
      const { message, outcome } = await upsertMessage(
        context,
        positionId,
        positionLabel,
        config,
        label,
      );

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.rpi.upsertRegisteredPosition(
            { positionId, ...config },
            context.txOptions,
          ),
        { skip: options.yes, message },
        outcome,
      );
    });

  program
    .command("upsert-wormhole-position")
    .description(
      "Create or update a Wormhole-sourced USD valued registered position",
    )
    .argument(
      "<position>",
      "registered position pubkey, UTF-8 string id, or 32-byte encoded position id",
    )
    .option(
      "--freshness-secs <u32>",
      "freshness override in seconds, defaults to 0",
      "0",
    )
    .option(
      "--submit-allow <pubkey>",
      "submit allowlist entry; repeat or pass comma-/space-separated values",
      collectPublicKeys,
      [],
    )
    .option(
      "--validate-allow <pubkey>",
      "validate allowlist entry; repeat or pass comma-/space-separated values",
      collectPublicKeys,
      [],
    )
    .option(
      "--configure-allow <pubkey>",
      "configure allowlist entry; repeat or pass comma-/space-separated values",
      collectPublicKeys,
      [],
    )
    .option("--disabled", "upsert with enabled=false", false)
    .option("-y, --yes", "Skip confirmation", false)
    .action(
      async (position: string, options: UpsertWormholePositionOptions) => {
        const { positionId, positionLabel } = parsePosition(position);
        const freshnessOverrideSecs = parseUnsignedNumber(
          options.freshnessSecs ?? "0",
          "--freshness-secs",
          U32_MAX,
        );
        const config: PositionUpsert = {
          positionType: { valued: {} },
          sourceType: { wormhole: {} },
          denomination: usdDenomination,
          enabled: !options.disabled,
          freshnessOverrideSecs,
          submitAllowlist: options.submitAllow || [],
          validateAllowlist: options.validateAllow || [],
          configureAllowlist: options.configureAllow || [],
        };
        const { message, outcome } = await upsertMessage(
          context,
          positionId,
          positionLabel,
          config,
          "USD",
        );

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.rpi.upsertRegisteredPosition(
              { positionId, ...config },
              context.txOptions,
            ),
          { skip: options.yes, message },
          outcome,
        );
      },
    );

  program
    .command("upsert-wormhole-config")
    .description("Create or update the generic Wormhole observation config")
    .argument(
      "<position>",
      "registered position pubkey, UTF-8 string id, or 32-byte encoded position id",
    )
    .option(
      "--emitter-chain <u16>",
      "Wormhole emitter chain id",
      String(HYPEREVM_WORMHOLE_CHAIN_ID),
    )
    .option(
      "--emitter-address <bytes>",
      "Wormhole emitter address as 32 bytes, or EVM adapter address as 20 bytes",
      HYPEREVM_NAV_ADAPTER_V2_EMITTER,
    )
    .option(
      "--payload-version <u8>",
      "Wormhole payload version",
      String(HYPERLIQUID_NAV_PAYLOAD_VERSION),
    )
    .option(
      "--payload-type <u8>",
      "Wormhole payload type",
      String(HYPERLIQUID_NAV_PAYLOAD_TYPE),
    )
    .option("--max-age-seconds <u32>", "observation freshness window", "90")
    .option("-y, --yes", "Skip confirmation", false)
    .action(async (position: string, options: UpsertWormholeConfigOptions) => {
      const { positionId, positionLabel } = parsePosition(position);
      const emitterChain = parseUnsignedNumber(
        options.emitterChain,
        "--emitter-chain",
        U16_MAX,
      );
      const payloadVersion = parseUnsignedNumber(
        options.payloadVersion,
        "--payload-version",
        U8_MAX,
      );
      const payloadType = parseUnsignedNumber(
        options.payloadType,
        "--payload-type",
        U8_MAX,
      );
      const maxAgeSeconds = parseUnsignedNumber(
        options.maxAgeSeconds,
        "--max-age-seconds",
        U32_MAX,
      );
      // Read with the other inputs: it was parsed after the confirmation.
      const emitterAddress = parseWormholeEmitterAddress(
        options.emitterAddress,
      );
      // ext_rpi takes the Hyperliquid NAV payload alone, version 2 and type 2
      // from HyperEVM's chain 47, and a max age above 0.
      if (
        payloadVersion !== HYPERLIQUID_NAV_PAYLOAD_VERSION ||
        payloadType !== HYPERLIQUID_NAV_PAYLOAD_TYPE
      ) {
        fail(
          `A Wormhole config takes the Hyperliquid NAV payload, version ${HYPERLIQUID_NAV_PAYLOAD_VERSION} and type ${HYPERLIQUID_NAV_PAYLOAD_TYPE}; --payload-version ${payloadVersion} and --payload-type ${payloadType} name another`,
        );
      }
      if (emitterChain !== HYPEREVM_WORMHOLE_CHAIN_ID) {
        fail(
          `The Hyperliquid NAV payload comes from Wormhole chain ${HYPEREVM_WORMHOLE_CHAIN_ID} (HyperEVM); --emitter-chain ${emitterChain} names another`,
        );
      }
      if (maxAgeSeconds === 0) {
        fail("--max-age-seconds must be greater than 0");
      }
      const { position: stored } = await registeredPosition(
        context,
        positionId,
        positionLabel,
      );
      requireWormholePosition(stored, context.glamClient.signer, positionLabel);
      // A change of emitter or payload restarts the replay sequence.
      const current =
        await context.glamClient.rpi.fetchWormholeObservationConfig(positionId);
      const scopeChanged =
        current !== null &&
        (current.emitterChain !== emitterChain ||
          !Buffer.from(current.emitterAddress).equals(
            Buffer.from(emitterAddress),
          ) ||
          current.payloadVersion !== payloadVersion ||
          current.payloadType !== payloadType);

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.rpi.upsertRegisteredPositionWormholeConfig(
            {
              positionId,
              emitterChain,
              emitterAddress,
              payloadVersion,
              payloadType,
              maxAgeSeconds,
            },
            context.txOptions,
          ),
        {
          skip: options.yes,
          message: [
            `Confirm ${current ? "updating" : "creating"} the Wormhole config for ${positionLabel}?`,
            `  emitter: chain ${emitterChain}, address 0x${Buffer.from(emitterAddress).toString("hex")}`,
            `  payload: version ${payloadVersion}, type ${payloadType}`,
            `  max age: ${maxAgeSeconds} seconds`,
            ...(scopeChanged
              ? [
                  "The emitter or the payload changes, so ext_rpi restarts the replay sequence: the next VAA may carry any sequence.",
                ]
              : []),
          ].join("\n"),
        },
        (txSig) => `Wormhole config upserted: ${txSig}`,
      );
    });

  program
    .command("remove-position")
    .description("Remove a registered position from RPI")
    .argument(
      "<position>",
      "registered position pubkey, UTF-8 string id, or 32-byte encoded position id",
    )
    .option("-y, --yes", "Skip confirmation", false)
    .action(async (position: string, options: RemovePositionOptions) => {
      const { positionId, positionLabel } = parsePosition(position);

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.rpi.removeRegisteredPosition(
            positionId,
            context.txOptions,
          ),
        {
          skip: options.yes,
          message: `Confirm removing RPI position ${positionLabel}?`,
        },
        (txSig) => `RPI position removed: ${txSig}`,
      );
    });

  program
    .command("upsert-hyperliquid-config")
    .description("Create or update the Hyperliquid Wormhole payload config")
    .argument(
      "<position>",
      "registered position pubkey, UTF-8 string id, or 32-byte encoded position id",
    )
    .requiredOption(
      "--hyperliquid-account <address>",
      "Hyperliquid account as a 20-byte EVM address",
    )
    .option(
      "--account-margin-summary-precompile <address>",
      "HyperEVM account margin summary precompile",
      ACCOUNT_MARGIN_SUMMARY_PRECOMPILE,
    )
    .option(
      "--spot-balance-precompile <address>",
      "HyperEVM spot balance precompile",
      SPOT_BALANCE_PRECOMPILE,
    )
    .option("--perp-dex-index <u32>", "Hyperliquid perp DEX index", "0")
    .option("--usdc-spot-token <u64>", "Hyperliquid USDC spot token", "0")
    .option("-y, --yes", "Skip confirmation", false)
    .action(
      async (position: string, options: UpsertHyperliquidConfigOptions) => {
        const { positionId, positionLabel } = parsePosition(position);
        const perpDexIndex = parseUnsignedNumber(
          options.perpDexIndex,
          "--perp-dex-index",
          U32_MAX,
        );
        const usdcSpotToken = parseU64(
          options.usdcSpotToken,
          "--usdc-spot-token",
        );
        // Read with the other inputs: they were parsed after the confirmation.
        const addresses = (
          [
            ["--hyperliquid-account", options.hyperliquidAccount],
            [
              "--account-margin-summary-precompile",
              options.accountMarginSummaryPrecompile,
            ],
            ["--spot-balance-precompile", options.spotBalancePrecompile],
          ] as const
        ).map(([label, value]) => {
          const bytes = parseBytes20(value, label);
          // ext_rpi refuses the zero address for each of the three.
          if (bytes.every((byte) => byte === 0)) {
            fail(`${label} must not be the zero address`);
          }
          return bytes;
        });
        const [
          hyperliquidAccount,
          accountMarginSummaryPrecompile,
          spotBalancePrecompile,
        ] = addresses;
        const { position: stored } = await registeredPosition(
          context,
          positionId,
          positionLabel,
        );
        requireWormholePosition(
          stored,
          context.glamClient.signer,
          positionLabel,
        );
        const hex = (bytes: number[]) =>
          `0x${Buffer.from(bytes).toString("hex")}`;

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.rpi.upsertRegisteredPositionWormholeHyperliquidConfig(
              {
                positionId,
                hyperliquidAccount,
                accountMarginSummaryPrecompile,
                spotBalancePrecompile,
                perpDexIndex,
                usdcSpotToken,
              },
              context.txOptions,
            ),
          {
            skip: options.yes,
            message: [
              `Confirm upserting the Hyperliquid Wormhole config for ${positionLabel}?`,
              `  Hyperliquid account: ${hex(hyperliquidAccount)} (the position takes the NAV attested for this account)`,
              `  account margin summary precompile: ${hex(accountMarginSummaryPrecompile)}`,
              `  spot balance precompile: ${hex(spotBalancePrecompile)}`,
              `  perp DEX index: ${perpDexIndex}, USDC spot token: ${usdcSpotToken.toString()}`,
            ].join("\n"),
          },
          (txSig) => `Hyperliquid Wormhole config upserted: ${txSig}`,
        );
      },
    );

  program
    .command("submit")
    .description("Submit an observation for a registered position")
    .argument(
      "<position>",
      "registered position pubkey, UTF-8 string id, or 32-byte encoded position id",
    )
    .argument(
      "<amount>",
      "signed UI amount in the specified observation denomination",
    )
    .option("--denom <denom>", "observation denomination: usd or mint", "usd")
    .option("--mint <token>", "mint address or symbol when --denom mint")
    .option(
      "--timestamp <unix-seconds>",
      "observation unix timestamp, defaults to now",
    )
    .option(
      "--external-shares <raw-u64>",
      "external shares for tokenized positions, defaults to 0",
      "0",
    )
    .option("-y, --yes", "Skip confirmation", false)
    .action(
      async (position: string, amount: string, options: SubmitOptions) => {
        const { positionId, positionLabel } = parsePosition(position);
        const { denomination, decimals, label } = await resolveDenomination(
          context,
          options,
        );
        // Unix seconds, so never negative. The field is an i64, where the
        // encoder wraps a value from 2^63 to a negative one.
        const timestampOption =
          options.timestamp !== undefined
            ? new BN(parseUnsignedNumber(options.timestamp, "--timestamp"))
            : undefined;
        const externalShares = parseU64(
          options.externalShares ?? "0",
          "--external-shares",
        );
        const amountBn = parseSignedUiAmount(amount, decimals, "amount");
        // ext_rpi reads the cluster's clock, which a host clock runs apart from.
        const { unixTimestamp: now } = await clusterClock(
          context,
          "an observation's timestamp",
        );
        const observationTimestamp = timestampOption ?? now;
        await requireSubmittable(
          context,
          positionId,
          positionLabel,
          denomination,
          observationTimestamp,
          externalShares,
          now,
        );

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.rpi.submitObservation(
              {
                positionId,
                amount: amountBn,
                denomination,
                observationTimestamp,
                externalShares,
              },
              context.txOptions,
            ),
          {
            skip: options.yes,
            // The timestamp is the one sent: without the option it is the
            // time the command read its inputs, not the time of the answer.
            message: `Confirm submitting observation for ${positionLabel}: ${amount.trim()} ${label} at timestamp ${observationTimestamp.toString()}${
              options.timestamp !== undefined ? "" : " (now)"
            }${
              externalShares.isZero()
                ? ""
                : ` with ${externalShares.toString()} external shares`
            }?`,
          },
          (txSig) => `Observation submitted: ${txSig}`,
        );
      },
    );

  program
    .command("submit-wormhole")
    .description("Submit a Wormhole Guardian-verified registered observation")
    .argument(
      "<position>",
      "registered position pubkey, UTF-8 string id, or 32-byte encoded position id",
    )
    .argument("<signed-vaa>", "signed VAA as hex or base64")
    .option(
      "--max-signatures-per-post <count>",
      "maximum Guardian signatures per post-signatures transaction",
      "13",
    )
    .option(
      "--guardian-set <pubkey>",
      "override GuardianSet account; normally derived from the VAA",
    )
    .option(
      "--wormhole-core-bridge-program <pubkey>",
      "override Wormhole Core Bridge program for GuardianSet PDA derivation",
    )
    .option(
      "--wormhole-verify-vaa-shim-program <pubkey>",
      "override Wormhole Verification Shim program",
    )
    .option("-y, --yes", "Skip confirmation", false)
    .action(
      async (
        position: string,
        signedVaa: string,
        options: SubmitWormholeOptions,
      ) => {
        const { positionId, positionLabel } = parsePosition(position);
        // The SDK reads 0 as unset and uses its default.
        const maxSignaturesPerPost = parsePositiveInteger(
          options.maxSignaturesPerPost ?? "13",
          "--max-signatures-per-post",
        );
        const signedVaaBytes = parseHexOrBase64Bytes(signedVaa, "signed-vaa");
        validateHyperliquidSignedVaa(signedVaaBytes, positionId);
        // The overrides were parsed after the confirmation.
        const overrides = (
          [
            ["--guardian-set", options.guardianSet],
            [
              "--wormhole-core-bridge-program",
              options.wormholeCoreBridgeProgram,
            ],
            [
              "--wormhole-verify-vaa-shim-program",
              options.wormholeVerifyVaaShimProgram,
            ],
          ] as const
        ).map(([label, value]) => {
          if (value === undefined) {
            return undefined;
          }
          try {
            return new PublicKey(value.trim());
          } catch {
            fail(`${label} ${value} is not a public key`);
          }
        });
        const [
          guardianSet,
          wormholeCoreBridgeProgram,
          wormholeVerifyVaaShimProgram,
        ] = overrides;
        const signatures =
          parseWormholeSignedVaa(signedVaaBytes).signatures.length;
        const posts = Math.ceil(signatures / maxSignaturesPerPost);
        const overrideLines = (
          [
            ["Guardian set", guardianSet],
            ["Wormhole Core Bridge program", wormholeCoreBridgeProgram],
            [
              "Wormhole verification shim program",
              wormholeVerifyVaaShimProgram,
            ],
          ] as const
        ).flatMap(([name, key]) =>
          key ? [`  ${name} override: ${key.toBase58()}`] : [],
        );

        await executeTxWithErrorHandling(
          async () => {
            const result =
              await context.glamClient.rpi.submitObservationWormhole(
                {
                  positionId,
                  signedVaa: signedVaaBytes,
                  guardianSet,
                  wormholeCoreBridgeProgram,
                  wormholeVerifyVaaShimProgram,
                  maxSignaturesPerPost,
                },
                context.txOptions,
              );

            return [
              `Guardian signatures account: ${result.guardianSignatures.toBase58()} (closed in submit tx)`,
              ...result.postSignatureTxs.map(
                (txSig, index) => `Post signatures tx ${index + 1}: ${txSig}`,
              ),
              `Wormhole observation submitted: ${result.submitTx}`,
            ].join("\n");
          },
          {
            skip: options.yes,
            message: [
              `Confirm submitting Wormhole observation for ${positionLabel}?`,
              `  ${signatures} Guardian signatures, posted in ${posts} transaction${posts === 1 ? "" : "s"} before the submit`,
              ...overrideLines,
            ].join("\n"),
          },
          (message) => message,
        );
      },
    );

  program
    .command("validate")
    .description("Validate a pending observation for a registered position")
    .argument(
      "<position>",
      "registered position pubkey, UTF-8 string id, or 32-byte encoded position id",
    )
    .option("-y, --yes", "Skip confirmation", false)
    .action(async (position: string, options: ValidateOptions) => {
      const { positionId, positionLabel } = parsePosition(position);
      // validate_observation promotes whatever observation is pending, and a
      // later submit replaces a pending one: confirm the one that is there.
      const id = Buffer.from(positionId);
      const readEntry = async () => {
        const state = await context.glamClient.rpi.fetchObservationState();
        return state?.positions
          .slice(0, state.positionsLen)
          .find((candidate: { positionId: number[] }) =>
            Buffer.from(candidate.positionId).equals(id),
          );
      };
      const entry = await readEntry();
      if (!entry) {
        fail(
          `Position ${positionLabel} is not in the vault's RPI observation state; register it with rpi upsert-position`,
        );
      }
      if (!entry.hasPending) {
        fail(
          `Validation requires a pending observation, and position ${positionLabel} has none`,
        );
      }
      const pending = entry.pendingObservation;
      const usd = variantName(pending.denomination.denom) === "usd";
      const decimals = usd
        ? 6
        : (
            await fetchMintAndTokenProgram(
              context.glamClient.connection,
              pending.denomination.mint,
            )
          ).mint.decimals;
      const timestamp = new BN(pending.observationTimestamp.toString());
      const shares = new BN(pending.externalShares.toString());
      // The instruction names only the position, so the observation shown is
      // read again before the send, and one replaced meanwhile is refused.
      const reviewed = JSON.stringify(pending);

      await executeTxWithErrorHandling(
        async () => {
          const now = await readEntry();
          if (
            !now?.hasPending ||
            JSON.stringify(now.pendingObservation) !== reviewed
          ) {
            fail(
              `The pending observation for ${positionLabel} changed after it was read for this confirmation, and nothing was sent. Run validate again to review the one there now`,
            );
          }
          return await context.glamClient.rpi.validateObservation(
            positionId,
            context.txOptions,
          );
        },
        {
          skip: options.yes,
          message: [
            `Confirm validating the pending observation for ${positionLabel}?`,
            `  amount: ${formatSignedAmount(storedI128(pending.amount), decimals)} ${usd ? "USD" : pending.denomination.mint.toBase58()}`,
            `  observed at: ${new Date(timestamp.toNumber() * 1000).toISOString()} (unix ${timestamp.toString()})`,
            ...(shares.isZero()
              ? []
              : [`  external shares: ${shares.toString()}`]),
            `  submitted by: ${pending.submittedBy.toBase58()}`,
            "Validation moves this amount into the vault's valuation.",
            "This is the observation as read before this prompt. It is read again before the send, and a changed one is refused; one submitted after that read and before the validation lands is not caught.",
          ].join("\n"),
        },
        (txSig) => `Observation validated: ${txSig}`,
      );
    });
}
