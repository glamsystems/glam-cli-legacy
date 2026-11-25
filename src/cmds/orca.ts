import { BN } from "@coral-xyz/anchor";
import {
  ORCA_WHIRLPOOLS_PROGRAM_ID,
  ORCA_WHIRLPOOLS_PROTOCOL,
  WSOL,
  WhirlpoolsPolicy,
  fetchMintAndTokenProgram,
  type CollectOrcaRewardV2Accounts,
  type DecreaseOrcaLiquidityV2Params,
  type IncreaseOrcaLiquidityByTokenAmountsV2Params,
  type IncreaseOrcaLiquidityV2Params,
  type OrcaLiquidityV2Accounts,
  type OrcaPriceDeviationAccounts,
  type OrcaPositionAccounts,
  type OrcaRemainingAccountsInfo,
  type OrcaUpdateFeesAndRewardsAccounts,
  type OrcaV2RemainingAccounts,
  type OpenOrcaPositionWithTokenExtensionsAccounts,
  type OpenOrcaPositionWithTokenExtensionsParams,
  type RepositionOrcaLiquidityV2Accounts,
  type RepositionOrcaLiquidityV2Params,
  PkSet,
} from "@glamsystems/glam-sdk";
import { type AccountMeta, Keypair, PublicKey } from "@solana/web3.js";
import { type Command } from "commander";
import fs from "fs";

import {
  type CliContext,
  executeTxWithErrorHandling,
  printTable,
  resolveTokenPublicKey,
} from "../utils";
import {
  editsStagedLine,
  readVaultTimelock,
  vaultTimelockOf,
  type VaultTimelock,
} from "../staging";
import { fail } from "../errors";
import {
  collectPublicKeys,
  I128_MAX_BN,
  parseInteger,
  parsePositiveBn,
  parseU8,
  parseU64,
  validatePublicKey,
} from "../parsing";

const BPS_DENOMINATOR = 10_000;
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
const ORCA_MIN_TICK_INDEX = -443_636;
const ORCA_MAX_TICK_INDEX = 443_636;
const TICK_ARRAY_SIZE = 88;
const Q64 = 2n ** 64n;
const Q96 = 2n ** 96n;
const LOG_Q64 = Math.log(Number(Q64));
const LOG_ORCA_TICK_BASE = Math.log(1.0001);

const WHIRLPOOL_ACCOUNT_DISCM = Buffer.from([
  63, 149, 209, 12, 225, 128, 99, 9,
]);
const POSITION_ACCOUNT_DISCM = Buffer.from([
  170, 188, 143, 228, 122, 64, 247, 208,
]);
const WHIRLPOOL_MIN_LEN = 269 + 128 * 3;
const WHIRLPOOL_TICK_SPACING_OFFSET = 41;
const WHIRLPOOL_SQRT_PRICE_OFFSET = 65;
const WHIRLPOOL_TOKEN_MINT_A_OFFSET = 101;
const WHIRLPOOL_TOKEN_VAULT_A_OFFSET = 133;
const WHIRLPOOL_TOKEN_MINT_B_OFFSET = 181;
const WHIRLPOOL_TOKEN_VAULT_B_OFFSET = 213;
const WHIRLPOOL_REWARD_INFOS_OFFSET = 269;
const WHIRLPOOL_REWARD_INFO_SIZE = 128;
const WHIRLPOOL_REWARD_MINT_OFFSET = 0;
const WHIRLPOOL_REWARD_VAULT_OFFSET = 32;
// A Position account is 216 bytes: the 8-byte discriminator, then its fields.
const POSITION_MIN_LEN = 216;
const POSITION_FEE_OWED_A_OFFSET = 112;
const POSITION_FEE_OWED_B_OFFSET = 136;
// Each of the three reward infos: a u128 growth checkpoint, then a u64 owed.
const POSITION_REWARD_OWED_OFFSETS = [160, 184, 208];
const POSITION_WHIRLPOOL_OFFSET = 8;
const POSITION_MINT_OFFSET = 40;
const POSITION_LIQUIDITY_OFFSET = 72;
const POSITION_TICK_LOWER_INDEX_OFFSET = 88;
const POSITION_TICK_UPPER_INDEX_OFFSET = 92;

type WhirlpoolSnapshot = {
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  tickSpacing: number;
  sqrtPrice: bigint;
};

type PositionSnapshot = {
  whirlpool: PublicKey;
  positionMint: PublicKey;
  liquidity: bigint;
  tickLowerIndex: number;
  tickUpperIndex: number;
  feeOwedA: bigint;
  feeOwedB: bigint;
  rewardsOwed: bigint[];
};

type TxOptions = {
  yes?: boolean;
};

type ListedPosition = PositionSnapshot & {
  position: PublicKey;
};

type RemainingOptions = {
  remainingAccounts?: string;
  remainingAccountsInfo?: string;
};

type CommonTokenOptions = {
  tokenProgramA?: PublicKey;
  tokenProgramB?: PublicKey;
  memoProgram?: PublicKey;
};

type DerivedPositionOptions = RemainingOptions &
  CommonTokenOptions & {
    positionTokenAccount?: PublicKey;
    tokenOwnerAccountA?: PublicKey;
    tokenOwnerAccountB?: PublicKey;
    tickArrayLower?: PublicKey;
    tickArrayUpper?: PublicKey;
  };

function isSolDenominatedOracleSource(oracleSource: string): boolean {
  return oracleSource === "LstPoolState" || oracleSource === "MarinadeState";
}

function isUnsupportedPriceDeviationOracleSource(
  oracleSource: string,
): boolean {
  return oracleSource === "ChainlinkX" || oracleSource === "ChainlinkRWA";
}

function isKaminoReserveOracleSource(oracleSource: string): boolean {
  return oracleSource === "KaminoReserve";
}

function parseI32(label: string): (value: string) => number {
  return (value) => parseInteger(value, label, I32_MIN, I32_MAX);
}

function parsePercent(value: string, label: string): number {
  const trimmed = value.trim();
  const pctText = trimmed.endsWith("%") ? trimmed.slice(0, -1).trim() : trimmed;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(pctText)) {
    // commander takes a bare -5% for an option and refuses it.
    fail(
      `${label} must be a percentage such as -5, 10 or +10%; a value that starts with - and ends with % goes after "--", as in: open-position <whirlpool> -- -5% 10%`,
    );
  }

  const pct = Number(pctText);
  if (!Number.isFinite(pct)) {
    fail(`${label} must be a finite percentage`);
  }
  return pct;
}

function parseRangePct(value: string, label: string): number {
  const pct = parsePercent(value, label);
  if (pct <= -100) {
    fail(`${label} must be greater than -100%`);
  }
  return pct;
}

function parseLowerRangePct(value: string): number {
  return parseRangePct(value, "lower-range-pct");
}

function parseUpperRangePct(value: string): number {
  return parseRangePct(value, "upper-range-pct");
}

function parseReferencePrice(value: string): number {
  const trimmed = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    fail("ref-price must be a positive number");
  }

  const price = Number(trimmed);
  if (!Number.isFinite(price) || price <= 0) {
    fail("ref-price must be greater than zero");
  }
  return price;
}

function validateRangePctOrder(lowerRangePct: number, upperRangePct: number) {
  if (upperRangePct <= lowerRangePct) {
    fail("upper-range-pct must be greater than lower-range-pct");
  }
}

function parseMaxDeviationBps(value: string): number {
  return parseInteger(
    value,
    "max-deviation-bps",
    -BPS_DENOMINATOR,
    BPS_DENOMINATOR - 1,
  );
}

function readKeypair(path: string): Keypair {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) {
      fail(`Keypair file ${path} must contain a JSON array`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch (error) {
    fail(`Failed to read keypair ${path}: ${(error as Error).message}`);
  }
}

function readPubkey(data: Buffer, offset: number, label: string): PublicKey {
  if (data.length < offset + 32) {
    fail(`${label} account data is too short`);
  }
  return new PublicKey(data.subarray(offset, offset + 32));
}

function readU128LE(data: Buffer, offset: number, label: string): bigint {
  if (data.length < offset + 16) {
    fail(`${label} account data is too short`);
  }

  let value = 0n;
  for (let i = 15; i >= 0; i--) {
    value = (value << 8n) + BigInt(data[offset + i]);
  }
  return value;
}

function assertDiscriminator(
  data: Buffer,
  discriminator: Buffer,
  label: string,
) {
  if (
    data.length < discriminator.length ||
    !data.subarray(0, 8).equals(discriminator)
  ) {
    fail(`Invalid ${label} account discriminator`);
  }
}

function hasDiscriminator(data: Buffer, discriminator: Buffer): boolean {
  return (
    data.length >= discriminator.length &&
    data.subarray(0, discriminator.length).equals(discriminator)
  );
}

function parsePositionSnapshot(data: Buffer): PositionSnapshot {
  assertDiscriminator(data, POSITION_ACCOUNT_DISCM, "Position");
  if (data.length < POSITION_MIN_LEN) {
    fail("Position account data is too short");
  }

  return {
    whirlpool: readPubkey(data, POSITION_WHIRLPOOL_OFFSET, "Position"),
    positionMint: readPubkey(data, POSITION_MINT_OFFSET, "Position"),
    liquidity: readU128LE(data, POSITION_LIQUIDITY_OFFSET, "Position"),
    tickLowerIndex: data.readInt32LE(POSITION_TICK_LOWER_INDEX_OFFSET),
    tickUpperIndex: data.readInt32LE(POSITION_TICK_UPPER_INDEX_OFFSET),
    feeOwedA: data.readBigUInt64LE(POSITION_FEE_OWED_A_OFFSET),
    feeOwedB: data.readBigUInt64LE(POSITION_FEE_OWED_B_OFFSET),
    rewardsOwed: POSITION_REWARD_OWED_OFFSETS.map((offset) =>
      data.readBigUInt64LE(offset),
    ),
  };
}

/**
 * ext_orca loads the vault's Whirlpools policy for these instructions and
 * refuses without one (PolicyNotSet). Every one but a decrease also requires
 * the pool and both its mints on the policy's allowlists.
 */
async function requireOrcaPolicy(
  context: CliContext,
  command: string,
  whirlpool: PublicKey,
  snapshot: WhirlpoolSnapshot,
  allowlists: boolean,
): Promise<void> {
  const policy = await fetchPolicy(context);
  if (!policy) {
    fail(
      `${command} requires an Orca Whirlpools policy, and the vault has none; set one with orca setup-pool ${whirlpool}`,
    );
  }
  if (!allowlists) {
    return;
  }
  if (!policy.whirlpoolsAllowlist.some((key) => key.equals(whirlpool))) {
    fail(
      `${command} requires the Whirlpool on the vault's Orca allowlist, and ${whirlpool} is not on it; add it with orca allowlist-whirlpool ${whirlpool}`,
    );
  }
  for (const mint of [snapshot.tokenMintA, snapshot.tokenMintB]) {
    if (!policy.tokenMintsAllowlist.some((key) => key.equals(mint))) {
      fail(
        `${command} requires both token mints of the Whirlpool on the vault's Orca token mint allowlist, and ${mint} is not on it; add it with orca allowlist-token ${mint}`,
      );
    }
  }
}

/** Liquidity above zero takes some of at least one token at any pool price. */
function requireATokenMax(command: string, maxA: BN, maxB: BN, labels: string) {
  if (maxA.isZero() && maxB.isZero()) {
    fail(
      `${command} adds liquidity, which takes some of at least one token at any pool price, so ${labels} cannot both be 0`,
    );
  }
}

async function fetchOwnedAccountData(
  context: CliContext,
  pubkey: PublicKey,
  minLen: number,
  discriminator: Buffer,
  label: string,
): Promise<Buffer> {
  const account = await context.glamClient.connection.getAccountInfo(pubkey);
  if (!account) {
    fail(`${label} account not found: ${pubkey}`);
  }
  if (!account.owner.equals(ORCA_WHIRLPOOLS_PROGRAM_ID)) {
    fail(
      `${label} account ${pubkey} is owned by ${account.owner}, expected ${ORCA_WHIRLPOOLS_PROGRAM_ID}`,
    );
  }
  if (account.data.length < minLen) {
    fail(`${label} account ${pubkey} data is too short`);
  }
  assertDiscriminator(account.data, discriminator, label);
  return account.data;
}

async function fetchWhirlpoolSnapshot(
  context: CliContext,
  whirlpool: PublicKey,
): Promise<WhirlpoolSnapshot> {
  const data = await fetchOwnedAccountData(
    context,
    whirlpool,
    WHIRLPOOL_MIN_LEN,
    WHIRLPOOL_ACCOUNT_DISCM,
    "Whirlpool",
  );

  return {
    tokenMintA: readPubkey(data, WHIRLPOOL_TOKEN_MINT_A_OFFSET, "Whirlpool"),
    tokenMintB: readPubkey(data, WHIRLPOOL_TOKEN_MINT_B_OFFSET, "Whirlpool"),
    tokenVaultA: readPubkey(data, WHIRLPOOL_TOKEN_VAULT_A_OFFSET, "Whirlpool"),
    tokenVaultB: readPubkey(data, WHIRLPOOL_TOKEN_VAULT_B_OFFSET, "Whirlpool"),
    tickSpacing: data.readUInt16LE(WHIRLPOOL_TICK_SPACING_OFFSET),
    sqrtPrice: readU128LE(data, WHIRLPOOL_SQRT_PRICE_OFFSET, "Whirlpool"),
  };
}

async function fetchPositionSnapshot(
  context: CliContext,
  position: PublicKey,
): Promise<PositionSnapshot> {
  const data = await fetchOwnedAccountData(
    context,
    position,
    POSITION_MIN_LEN,
    POSITION_ACCOUNT_DISCM,
    "Position",
  );

  return parsePositionSnapshot(data);
}

async function listOpenPositions(
  context: CliContext,
): Promise<ListedPosition[]> {
  const state = await context.glamClient.fetchStateAccount();
  const externalPositions = state.externalPositions ?? [];
  const positions: ListedPosition[] = [];
  const chunkSize = 100;

  for (let i = 0; i < externalPositions.length; i += chunkSize) {
    const chunk = externalPositions.slice(i, i + chunkSize);
    const accounts =
      await context.glamClient.connection.getMultipleAccountsInfo(chunk);

    accounts.forEach((account, index) => {
      if (
        !account ||
        !account.owner.equals(ORCA_WHIRLPOOLS_PROGRAM_ID) ||
        !hasDiscriminator(account.data, POSITION_ACCOUNT_DISCM)
      ) {
        return;
      }

      const snapshot = parsePositionSnapshot(account.data);
      positions.push({
        position: chunk[index],
        ...snapshot,
      });
    });
  }

  return positions;
}

async function fetchRewardInfo(
  context: CliContext,
  whirlpool: PublicKey,
  rewardIndex: number,
): Promise<{ rewardMint: PublicKey; rewardVault: PublicKey }> {
  if (rewardIndex < 0 || rewardIndex > 2) {
    fail("reward-index must be in range [0, 2]");
  }

  const data = await fetchOwnedAccountData(
    context,
    whirlpool,
    WHIRLPOOL_MIN_LEN,
    WHIRLPOOL_ACCOUNT_DISCM,
    "Whirlpool",
  );
  const offset =
    WHIRLPOOL_REWARD_INFOS_OFFSET + WHIRLPOOL_REWARD_INFO_SIZE * rewardIndex;
  return {
    rewardMint: readPubkey(
      data,
      offset + WHIRLPOOL_REWARD_MINT_OFFSET,
      "Whirlpool reward",
    ),
    rewardVault: readPubkey(
      data,
      offset + WHIRLPOOL_REWARD_VAULT_OFFSET,
      "Whirlpool reward",
    ),
  };
}

function getTickArrayStartIndex(
  tickIndex: number,
  tickSpacing: number,
): number {
  const span = tickSpacing * TICK_ARRAY_SIZE;
  return Math.floor(tickIndex / span) * span;
}

function minInitializableTick(tickSpacing: number): number {
  return Math.ceil(ORCA_MIN_TICK_INDEX / tickSpacing) * tickSpacing;
}

function maxInitializableTick(tickSpacing: number): number {
  return Math.floor(ORCA_MAX_TICK_INDEX / tickSpacing) * tickSpacing;
}

function alignTickDown(tickIndex: number, tickSpacing: number): number {
  return Math.floor(tickIndex / tickSpacing) * tickSpacing;
}

function alignTickUp(tickIndex: number, tickSpacing: number): number {
  return Math.ceil(tickIndex / tickSpacing) * tickSpacing;
}

function currentTickFromSqrtPrice(sqrtPrice: bigint): number {
  if (sqrtPrice <= 0n) {
    fail("Whirlpool sqrt_price must be greater than zero");
  }

  const sqrtPriceNumber = Number(sqrtPrice);
  if (!Number.isFinite(sqrtPriceNumber)) {
    fail(`Whirlpool sqrt_price is too large: ${sqrtPrice.toString()}`);
  }

  return (2 * (Math.log(sqrtPriceNumber) - LOG_Q64)) / LOG_ORCA_TICK_BASE;
}

async function tickFromUiReferencePrice(
  context: CliContext,
  whirlpool: WhirlpoolSnapshot,
  refPrice: number,
): Promise<number> {
  const [{ mint: mintA }, { mint: mintB }] = await Promise.all([
    fetchMintAndTokenProgram(
      context.glamClient.connection,
      whirlpool.tokenMintA,
    ),
    fetchMintAndTokenProgram(
      context.glamClient.connection,
      whirlpool.tokenMintB,
    ),
  ]);

  return (
    (Math.log(refPrice) + (mintB.decimals - mintA.decimals) * Math.log(10)) /
    LOG_ORCA_TICK_BASE
  );
}

function tickRangeFromPricePercentages(
  whirlpool: WhirlpoolSnapshot,
  lowerRangePct: number,
  upperRangePct: number,
  anchorTick = currentTickFromSqrtPrice(whirlpool.sqrtPrice),
): { tickLowerIndex: number; tickUpperIndex: number } {
  validateRangePctOrder(lowerRangePct, upperRangePct);

  const tickLowerTarget =
    anchorTick + Math.log1p(lowerRangePct / 100) / LOG_ORCA_TICK_BASE;
  const tickUpperTarget =
    anchorTick + Math.log1p(upperRangePct / 100) / LOG_ORCA_TICK_BASE;

  const minTick = minInitializableTick(whirlpool.tickSpacing);
  const maxTick = maxInitializableTick(whirlpool.tickSpacing);
  const tickLowerIndex = Math.max(
    minTick,
    alignTickDown(tickLowerTarget, whirlpool.tickSpacing),
  );
  const tickUpperIndex = Math.min(
    maxTick,
    alignTickUp(tickUpperTarget, whirlpool.tickSpacing),
  );

  if (tickLowerIndex >= tickUpperIndex) {
    fail(
      `Derived invalid tick range [${tickLowerIndex}, ${tickUpperIndex}); use a wider percentage range`,
    );
  }

  return { tickLowerIndex, tickUpperIndex };
}

function mulShift64(n0: bigint, n1: bigint): bigint {
  return (n0 * n1) / Q64;
}

function mulShift96(n0: bigint, n1: bigint): bigint {
  return (n0 * n1) / Q96;
}

function sqrtPriceFromTickIndex(tickIndex: number): bigint {
  if (tickIndex < ORCA_MIN_TICK_INDEX || tickIndex > ORCA_MAX_TICK_INDEX) {
    fail(
      `tick index must be in range [${ORCA_MIN_TICK_INDEX}, ${ORCA_MAX_TICK_INDEX}]`,
    );
  }

  return tickIndex >= 0
    ? sqrtPriceFromPositiveTick(tickIndex)
    : sqrtPriceFromNegativeTick(tickIndex);
}

function sqrtPriceFromPositiveTick(tick: number): bigint {
  let ratio =
    (tick & 1) !== 0
      ? 79232123823359799118286999567n
      : 79228162514264337593543950336n;

  if ((tick & 2) !== 0)
    ratio = mulShift96(ratio, 79236085330515764027303304731n);
  if ((tick & 4) !== 0)
    ratio = mulShift96(ratio, 79244008939048815603706035061n);
  if ((tick & 8) !== 0)
    ratio = mulShift96(ratio, 79259858533276714757314932305n);
  if ((tick & 16) !== 0)
    ratio = mulShift96(ratio, 79291567232598584799939703904n);
  if ((tick & 32) !== 0)
    ratio = mulShift96(ratio, 79355022692464371645785046466n);
  if ((tick & 64) !== 0)
    ratio = mulShift96(ratio, 79482085999252804386437311141n);
  if ((tick & 128) !== 0)
    ratio = mulShift96(ratio, 79736823300114093921829183326n);
  if ((tick & 256) !== 0)
    ratio = mulShift96(ratio, 80248749790819932309965073892n);
  if ((tick & 512) !== 0)
    ratio = mulShift96(ratio, 81282483887344747381513967011n);
  if ((tick & 1024) !== 0)
    ratio = mulShift96(ratio, 83390072131320151908154831281n);
  if ((tick & 2048) !== 0)
    ratio = mulShift96(ratio, 87770609709833776024991924138n);
  if ((tick & 4096) !== 0)
    ratio = mulShift96(ratio, 97234110755111693312479820773n);
  if ((tick & 8192) !== 0)
    ratio = mulShift96(ratio, 119332217159966728226237229890n);
  if ((tick & 16384) !== 0)
    ratio = mulShift96(ratio, 179736315981702064433883588727n);
  if ((tick & 32768) !== 0)
    ratio = mulShift96(ratio, 407748233172238350107850275304n);
  if ((tick & 65536) !== 0)
    ratio = mulShift96(ratio, 2098478828474011932436660412517n);
  if ((tick & 131072) !== 0)
    ratio = mulShift96(ratio, 55581415166113811149459800483533n);
  if ((tick & 262144) !== 0)
    ratio = mulShift96(ratio, 38992368544603139932233054999993551n);

  return ratio >> 32n;
}

function sqrtPriceFromNegativeTick(tick: number): bigint {
  const absTick = Math.abs(tick);
  let ratio =
    (absTick & 1) !== 0 ? 18445821805675392311n : 18446744073709551616n;

  if ((absTick & 2) !== 0) ratio = mulShift64(ratio, 18444899583751176498n);
  if ((absTick & 4) !== 0) ratio = mulShift64(ratio, 18443055278223354162n);
  if ((absTick & 8) !== 0) ratio = mulShift64(ratio, 18439367220385604838n);
  if ((absTick & 16) !== 0) ratio = mulShift64(ratio, 18431993317065449817n);
  if ((absTick & 32) !== 0) ratio = mulShift64(ratio, 18417254355718160513n);
  if ((absTick & 64) !== 0) ratio = mulShift64(ratio, 18387811781193591352n);
  if ((absTick & 128) !== 0) ratio = mulShift64(ratio, 18329067761203520168n);
  if ((absTick & 256) !== 0) ratio = mulShift64(ratio, 18212142134806087854n);
  if ((absTick & 512) !== 0) ratio = mulShift64(ratio, 17980523815641551639n);
  if ((absTick & 1024) !== 0) ratio = mulShift64(ratio, 17526086738831147013n);
  if ((absTick & 2048) !== 0) ratio = mulShift64(ratio, 16651378430235024244n);
  if ((absTick & 4096) !== 0) ratio = mulShift64(ratio, 15030750278693429944n);
  if ((absTick & 8192) !== 0) ratio = mulShift64(ratio, 12247334978882834399n);
  if ((absTick & 16384) !== 0) ratio = mulShift64(ratio, 8131365268884726200n);
  if ((absTick & 32768) !== 0) ratio = mulShift64(ratio, 3584323654723342297n);
  if ((absTick & 65536) !== 0) ratio = mulShift64(ratio, 696457651847595233n);
  if ((absTick & 131072) !== 0) ratio = mulShift64(ratio, 26294789957452057n);
  if ((absTick & 262144) !== 0) ratio = mulShift64(ratio, 37481735321082n);

  return ratio;
}

function deriveTickArray(
  context: CliContext,
  whirlpool: PublicKey,
  tickIndex: number,
  tickSpacing: number,
): PublicKey {
  return context.glamClient.orca.getTickArrayPda(
    whirlpool,
    getTickArrayStartIndex(tickIndex, tickSpacing),
  )[0];
}

async function tokenProgramsForWhirlpool(
  context: CliContext,
  whirlpool: WhirlpoolSnapshot,
  options: CommonTokenOptions,
): Promise<{ tokenProgramA: PublicKey; tokenProgramB: PublicKey }> {
  const tokenProgramA =
    options.tokenProgramA ??
    (
      await fetchMintAndTokenProgram(
        context.glamClient.connection,
        whirlpool.tokenMintA,
      )
    ).tokenProgram;
  const tokenProgramB =
    options.tokenProgramB ??
    (
      await fetchMintAndTokenProgram(
        context.glamClient.connection,
        whirlpool.tokenMintB,
      )
    ).tokenProgram;

  return { tokenProgramA, tokenProgramB };
}

async function derivePriceDeviationAccounts(
  context: CliContext,
  whirlpool: WhirlpoolSnapshot,
): Promise<OrcaPriceDeviationAccounts | undefined> {
  const policy = await fetchPolicy(context);
  if (!policy) {
    return undefined;
  }

  const [tokenAMeta, tokenBMeta] = await Promise.all([
    context.glamClient.getAssetMeta(whirlpool.tokenMintA),
    context.glamClient.getAssetMeta(whirlpool.tokenMintB),
  ]);
  if (
    isUnsupportedPriceDeviationOracleSource(tokenAMeta.oracleSource) ||
    isUnsupportedPriceDeviationOracleSource(tokenBMeta.oracleSource)
  ) {
    fail(
      "Orca max-deviation-bps does not support ChainlinkX or ChainlinkRWA oracles",
    );
  }

  const tokenAIsSolDenom = isSolDenominatedOracleSource(
    tokenAMeta.oracleSource,
  );
  const tokenBIsSolDenom = isSolDenominatedOracleSource(
    tokenBMeta.oracleSource,
  );
  const needsSolUsdOracle = tokenAIsSolDenom !== tokenBIsSolDenom;
  const solMeta = needsSolUsdOracle
    ? await context.glamClient.getAssetMeta(WSOL)
    : undefined;
  const oracleMetas = [tokenAMeta, tokenBMeta];
  if (solMeta) {
    oracleMetas.push(solMeta);
  }
  const kaminoReserves = Array.from(
    new PkSet(
      oracleMetas
        .filter((assetMeta) =>
          isKaminoReserveOracleSource(assetMeta.oracleSource),
        )
        .map((assetMeta) => assetMeta.oracle),
    ),
  );

  return {
    tokenMintAOracle: tokenAMeta.oracle,
    tokenMintBOracle: tokenBMeta.oracle,
    solUsdOracle: solMeta?.oracle,
    kaminoReserves: kaminoReserves.length ? kaminoReserves : undefined,
  };
}

/**
 * What an instruction needs of the policy: the allowlists (an increase), the
 * policy alone (a decrease), or nothing (a fee collection, which sends no
 * price accounts and which ext_orca checks against no price).
 */
type LiquidityUse = {
  command: string;
  policy: "allowlists" | "policy" | "none";
};

async function deriveLiquidityAccounts(
  context: CliContext,
  position: PublicKey,
  options: DerivedPositionOptions,
  remaining: OrcaV2RemainingAccounts,
  use: LiquidityUse,
  knownPosition?: PositionSnapshot,
): Promise<OrcaLiquidityV2Accounts> {
  const positionSnapshot =
    knownPosition ?? (await fetchPositionSnapshot(context, position));
  const whirlpoolSnapshot = await fetchWhirlpoolSnapshot(
    context,
    positionSnapshot.whirlpool,
  );
  if (use.policy !== "none") {
    await requireOrcaPolicy(
      context,
      use.command,
      positionSnapshot.whirlpool,
      whirlpoolSnapshot,
      use.policy === "allowlists",
    );
  }
  const { tokenProgramA, tokenProgramB } = await tokenProgramsForWhirlpool(
    context,
    whirlpoolSnapshot,
    options,
  );

  return {
    ...remaining,
    whirlpool: positionSnapshot.whirlpool,
    position,
    positionMint: positionSnapshot.positionMint,
    positionTokenAccount: options.positionTokenAccount,
    tokenMintA: whirlpoolSnapshot.tokenMintA,
    tokenMintB: whirlpoolSnapshot.tokenMintB,
    tokenOwnerAccountA: options.tokenOwnerAccountA,
    tokenOwnerAccountB: options.tokenOwnerAccountB,
    tokenVaultA: whirlpoolSnapshot.tokenVaultA,
    tokenVaultB: whirlpoolSnapshot.tokenVaultB,
    priceDeviationAccounts:
      use.policy === "none"
        ? undefined
        : await derivePriceDeviationAccounts(context, whirlpoolSnapshot),
    tickArrayLower:
      options.tickArrayLower ??
      deriveTickArray(
        context,
        positionSnapshot.whirlpool,
        positionSnapshot.tickLowerIndex,
        whirlpoolSnapshot.tickSpacing,
      ),
    tickArrayUpper:
      options.tickArrayUpper ??
      deriveTickArray(
        context,
        positionSnapshot.whirlpool,
        positionSnapshot.tickUpperIndex,
        whirlpoolSnapshot.tickSpacing,
      ),
    tokenProgramA,
    tokenProgramB,
    memoProgram: options.memoProgram,
  };
}

async function deriveUpdateFeesAndRewardsAccounts(
  context: CliContext,
  position: PublicKey,
  options: Pick<DerivedPositionOptions, "tickArrayLower" | "tickArrayUpper">,
): Promise<OrcaUpdateFeesAndRewardsAccounts> {
  const positionSnapshot = await fetchPositionSnapshot(context, position);
  const whirlpoolSnapshot = await fetchWhirlpoolSnapshot(
    context,
    positionSnapshot.whirlpool,
  );

  return {
    whirlpool: positionSnapshot.whirlpool,
    position,
    tickArrayLower:
      options.tickArrayLower ??
      deriveTickArray(
        context,
        positionSnapshot.whirlpool,
        positionSnapshot.tickLowerIndex,
        whirlpoolSnapshot.tickSpacing,
      ),
    tickArrayUpper:
      options.tickArrayUpper ??
      deriveTickArray(
        context,
        positionSnapshot.whirlpool,
        positionSnapshot.tickUpperIndex,
        whirlpoolSnapshot.tickSpacing,
      ),
  };
}

function loadJson(raw: string, label: string): unknown {
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith("@")
    ? fs.readFileSync(trimmed.slice(1), "utf8")
    : trimmed;

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    fail(`${label} must be valid JSON: ${(error as Error).message}`);
  }
}

function parseRemainingAccounts(raw: string): AccountMeta[] {
  const parsed = loadJson(raw, "remaining_accounts");
  if (!Array.isArray(parsed)) {
    fail("remaining_accounts must be a JSON array");
  }

  return parsed.map((entry, index) => {
    if (typeof entry === "string") {
      return {
        pubkey: validatePublicKey(entry),
        isSigner: false,
        isWritable: false,
      };
    }
    if (!entry || typeof entry !== "object") {
      fail(`remaining_accounts[${index}] must be a pubkey string or object`);
    }

    const meta = entry as {
      pubkey?: string;
      publicKey?: string;
      isSigner?: boolean;
      isWritable?: boolean;
    };
    const pubkey = meta.pubkey ?? meta.publicKey;
    if (!pubkey) {
      fail(`remaining_accounts[${index}] missing pubkey`);
    }
    // A string such as "false" is truthy and would mark the account. A flag
    // left out, or given as null, is false.
    for (const flag of ["isSigner", "isWritable"] as const) {
      const given: unknown = meta[flag];
      if (given !== undefined && given !== null && typeof given !== "boolean") {
        fail(`remaining_accounts[${index}].${flag} must be true or false`);
      }
    }

    return {
      pubkey: validatePublicKey(pubkey),
      isSigner: meta.isSigner ?? false,
      isWritable: meta.isWritable ?? false,
    };
  });
}

const REMAINING_ACCOUNTS_TYPES = new Set([
  "transferHookA",
  "transferHookB",
  "transferHookReward",
  "transferHookInput",
  "transferHookIntermediate",
  "transferHookOutput",
  "supplementalTickArrays",
  "supplementalTickArraysOne",
  "supplementalTickArraysTwo",
  "transferHookDepositA",
  "transferHookDepositB",
  "transferHookWithdrawalA",
  "transferHookWithdrawalB",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The encoder floors a fractional length, takes a string for its number and
// writes a slice whose accounts type sits under another key as nothing. It
// refuses an accounts type it does not know and a length past a u8, but only
// when the transaction is built, after the confirmation.
function parseRemainingAccountsInfo(
  raw: string,
): OrcaRemainingAccountsInfo | undefined {
  const label = "remaining_accounts_info";
  const parsed = loadJson(raw, label);
  // A JSON null sends no info, like the option left out.
  if (parsed === null) {
    return undefined;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.slices)) {
    fail(`${label} must be an object with a slices array`);
  }

  parsed.slices.forEach((slice: unknown, index: number) => {
    const type = isPlainObject(slice) ? slice.accountsType : undefined;
    const variants = isPlainObject(type) ? Object.keys(type) : [];
    if (variants.length !== 1 || !REMAINING_ACCOUNTS_TYPES.has(variants[0])) {
      fail(
        `${label} slices[${index}].accountsType must be an object with one of these keys: ${[...REMAINING_ACCOUNTS_TYPES].join(", ")}`,
      );
    }
    const length = (slice as Record<string, unknown>).length;
    if (
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > 255
    ) {
      fail(`${label} slices[${index}].length must be an integer from 0 to 255`);
    }
  });
  return parsed as OrcaRemainingAccountsInfo;
}

// The slice types each Whirlpool instruction takes. Its
// parse_remaining_accounts refuses any other (RemainingAccountsInvalidSlice)
// and a second non-empty slice of one type
// (RemainingAccountsDuplicatedAccountsType). Read from orca-so/whirlpools at
// cc683ec92acb.
const TRANSFER_HOOKS_A_B = ["transferHookA", "transferHookB"] as const;
const TRANSFER_HOOK_REWARD = ["transferHookReward"] as const;
const REPOSITION_TRANSFER_HOOKS = [
  "transferHookDepositA",
  "transferHookDepositB",
  "transferHookWithdrawalA",
  "transferHookWithdrawalB",
] as const;

function parseRemainingOptions(
  options: RemainingOptions,
  command: string,
  accepted: readonly string[],
): OrcaV2RemainingAccounts {
  // An option given with an empty value is read, and refused, like any other:
  // it is not the same as an option left out.
  const remainingAccounts =
    options.remainingAccounts !== undefined
      ? parseRemainingAccounts(options.remainingAccounts)
      : undefined;
  const remainingAccountsInfo =
    options.remainingAccountsInfo !== undefined
      ? parseRemainingAccountsInfo(options.remainingAccountsInfo)
      : undefined;
  const given = new Set<string>();
  (remainingAccountsInfo?.slices ?? []).forEach((slice, index) => {
    const [type] = Object.keys(slice.accountsType);
    if (!accepted.includes(type)) {
      fail(
        `remaining_accounts_info slices[${index}].accountsType ${type} is not one ${command} takes: ${accepted.join(", ")}`,
      );
    }
    if (slice.length > 0) {
      if (given.has(type)) {
        fail(
          `remaining_accounts_info slices[${index}] gives a second slice of ${type} accounts, which ${command} takes once`,
        );
      }
      given.add(type);
    }
  });
  // Whirlpool takes each slice's accounts off the remaining accounts in turn
  // and refuses the instruction when they run out.
  const claimed = (remainingAccountsInfo?.slices ?? []).reduce(
    (total, slice) => total + slice.length,
    0,
  );
  const supplied = remainingAccounts?.length ?? 0;
  if (claimed > supplied) {
    fail(
      `remaining_accounts_info slices take ${claimed} accounts and remaining_accounts gives ${supplied}`,
    );
  }
  return { remainingAccounts, remainingAccountsInfo };
}

function addRemainingOptions(command: Command): Command {
  return command
    .option(
      "--remaining-accounts <json>",
      "JSON AccountMeta[] or @file, used with Orca v2 remaining account slices",
    )
    .option(
      "--remaining-accounts-info <json>",
      'JSON RemainingAccountsInfo or @file, e.g. {"slices":[...]}',
    );
}

function addCommonTokenOptions(command: Command): Command {
  return command
    .option(
      "--token-program-a <pubkey>",
      "Token program for token A",
      validatePublicKey,
    )
    .option(
      "--token-program-b <pubkey>",
      "Token program for token B",
      validatePublicKey,
    )
    .option(
      "--memo-program <pubkey>",
      "SPL Memo program override",
      validatePublicKey,
    );
}

function addLiquidityAccountOptions(command: Command): Command {
  return addRemainingOptions(addCommonTokenOptions(command))
    .option(
      "--position-token-account <pubkey>",
      "Vault-owned position token account",
      validatePublicKey,
    )
    .option(
      "--token-owner-account-a <pubkey>",
      "Vault token A account",
      validatePublicKey,
    )
    .option(
      "--token-owner-account-b <pubkey>",
      "Vault token B account",
      validatePublicKey,
    )
    .option(
      "--tick-array-lower <pubkey>",
      "Lower tick array override",
      validatePublicKey,
    )
    .option(
      "--tick-array-upper <pubkey>",
      "Upper tick array override",
      validatePublicKey,
    );
}

function printPolicy(policy: WhirlpoolsPolicy) {
  console.log(`Max deviation BPS: ${policy.maxDeviationBps}`);
  console.log("Whirlpools allowlist:");
  policy.whirlpoolsAllowlist.forEach((pk, i) => console.log(`[${i}] ${pk}`));
  console.log("Token mint allowlist:");
  policy.tokenMintsAllowlist.forEach((pk, i) => console.log(`[${i}] ${pk}`));
}

async function fetchPolicy(
  context: CliContext,
): Promise<WhirlpoolsPolicy | null> {
  return await context.glamClient.orca.fetchPolicy();
}

function defaultWhirlpoolsPolicy(): WhirlpoolsPolicy {
  return new WhirlpoolsPolicy([], [], 0);
}

/** The Whirlpools policy an edit replaces: the staged one under a timelock that holds one. */
async function whirlpoolsPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => fetchPolicy(context),
    () => context.glamClient.extOrcaProgram.programId,
    ORCA_WHIRLPOOLS_PROTOCOL,
    WhirlpoolsPolicy.decode,
  );
}

async function setWhirlpoolsPolicy(
  context: CliContext,
  policy: WhirlpoolsPolicy,
  options: TxOptions,
  message: string,
  success: string,
  timelock?: VaultTimelock,
) {
  const vaultTimelock = timelock ?? (await readVaultTimelock(context));
  await executeTxWithErrorHandling(
    () => context.glamClient.orca.setPolicy(policy, context.txOptions),
    {
      skip: !!options.yes,
      message: vaultTimelock.confirm(message),
    },
    vaultTimelock.outcome(success),
  );
}

async function updatePolicy(
  context: CliContext,
  mutate: (policy: WhirlpoolsPolicy) => void,
  options: TxOptions,
  message: string,
  success: string,
) {
  const timelock = await readVaultTimelock(context);
  const base = await whirlpoolsPolicyToEdit(context, timelock);
  const created = base.value === null;
  const policy = base.value ?? defaultWhirlpoolsPolicy();
  mutate(policy);
  policy.whirlpoolsAllowlist = Array.from(
    new PkSet(policy.whirlpoolsAllowlist),
  );
  policy.tokenMintsAllowlist = Array.from(
    new PkSet(policy.tokenMintsAllowlist),
  );

  parseMaxDeviationBps(policy.maxDeviationBps.toString());

  await setWhirlpoolsPolicy(
    context,
    policy,
    options,
    [
      message,
      ...(created
        ? [
            `The vault has no Orca Whirlpools policy; this creates one with max deviation ${policy.maxDeviationBps} bps.`,
          ]
        : []),
      ...(base.stagedApart
        ? [editsStagedLine("the Orca Whirlpools policy")]
        : []),
    ].join("\n"),
    success,
    timelock,
  );
}

export function installOrcaCommands(orca: Command, context: CliContext) {
  orca.configureHelp({
    subcommandTerm: (cmd) => {
      const alias = cmd.alias();
      return `${cmd.name()}${alias ? `|${alias}` : ""}`;
    },
  });

  orca
    .command("view-policy")
    .description("View Orca Whirlpools policy")
    .action(async () => {
      const policy = await fetchPolicy(context);
      if (!policy) {
        console.log("No Orca Whirlpools policy found");
        process.exit(1);
      }
      printPolicy(policy);
    });

  orca
    .command("set-policy")
    .option(
      "--whirlpools <pubkeys>",
      "Comma- or space-separated Whirlpool allowlist",
      collectPublicKeys,
    )
    .option(
      "--token-mints <pubkeys>",
      "Comma- or space-separated token mint allowlist",
      collectPublicKeys,
    )
    .option(
      "--max-deviation-bps <bps>",
      "Signed pool/oracle price deviation in basis points; negative requires a premium, 0 requires at least oracle",
      parseMaxDeviationBps,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Replace the full Orca Whirlpools policy")
    .action(
      async (
        options: TxOptions & {
          whirlpools?: PublicKey[];
          tokenMints?: PublicKey[];
          maxDeviationBps?: number;
        },
      ) => {
        const whirlpools = options.whirlpools ?? [];
        const tokenMints = options.tokenMints ?? [];

        for (const whirlpool of whirlpools) {
          const { tokenMintA, tokenMintB } = await fetchWhirlpoolSnapshot(
            context,
            whirlpool,
          );
          tokenMints.push(tokenMintA, tokenMintB);
        }

        const policy = new WhirlpoolsPolicy(
          whirlpools,
          Array.from(new PkSet(tokenMints)),
          options.maxDeviationBps ?? 0,
        );
        const timelock = await readVaultTimelock(context);
        await executeTxWithErrorHandling(
          () => context.glamClient.orca.setPolicy(policy, context.txOptions),
          {
            skip: !!options.yes,
            // The whole policy is written, a max deviation left out as 0.
            message: timelock.confirm(
              [
                "Replace the Orca Whirlpools policy?",
                `  Whirlpools: ${policy.whirlpoolsAllowlist.join(", ") || "none"}`,
                `  token mints: ${policy.tokenMintsAllowlist.join(", ") || "none"}`,
                `  max deviation: ${policy.maxDeviationBps} bps`,
              ].join("\n"),
            ),
          },
          timelock.outcome("Orca Whirlpools policy set"),
        );
      },
    );

  orca
    .command("reset-policy")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Reset Orca Whirlpools policy to default")
    .action(async (options: TxOptions) => {
      await setWhirlpoolsPolicy(
        context,
        defaultWhirlpoolsPolicy(),
        options,
        "Reset Orca Whirlpools policy to default?",
        `Orca Whirlpools policy reset`,
      );
    });

  orca
    .command("set-max-deviation-bps")
    .argument(
      "<bps>",
      "Signed pool/oracle price deviation; negative requires a premium, 0 requires at least oracle",
      parseMaxDeviationBps,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Update Orca Whirlpools pool/oracle price deviation policy")
    .action(async (maxDeviationBps: number, options: TxOptions) => {
      await updatePolicy(
        context,
        (policy) => {
          policy.maxDeviationBps = maxDeviationBps;
        },
        options,
        `Set Orca max deviation to ${maxDeviationBps} bps?`,
        `Updated Orca max deviation policy`,
      );
    });

  orca
    .command("setup-pool")
    .argument("<whirlpool>", "Whirlpool account", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Allowlist a Whirlpool, allowlist its token mints, and add both mints to vault assets",
    )
    .action(async (whirlpool: PublicKey, options: TxOptions) => {
      const snapshot = await fetchWhirlpoolSnapshot(context, whirlpool);
      const state = await context.glamClient.fetchStateAccount();
      const timelock = vaultTimelockOf(state);
      const base = timelock.list("assets", state.assets);
      const assets = new PkSet([
        ...base.value,
        snapshot.tokenMintA,
        snapshot.tokenMintB,
      ]);

      if (assets.size !== base.value.length) {
        await executeTxWithErrorHandling(
          () =>
            context.glamClient.state.update(
              { assets: Array.from(assets) },
              context.txOptions,
            ),
          {
            skip: !!options.yes,
            message: timelock.confirm(
              [
                `Add Whirlpool mints ${snapshot.tokenMintA}, ${snapshot.tokenMintB} to vault assets?`,
                ...(base.stagedApart
                  ? [editsStagedLine("the vault allowlist")]
                  : []),
              ].join("\n"),
            ),
          },
          timelock.outcome("Vault assets updated for Orca pool"),
        );
      }

      await updatePolicy(
        context,
        (policy) => {
          policy.whirlpoolsAllowlist.push(whirlpool);
          policy.tokenMintsAllowlist.push(
            snapshot.tokenMintA,
            snapshot.tokenMintB,
          );
        },
        options,
        `Allowlist Orca pool ${whirlpool} and its token mints ${snapshot.tokenMintA}, ${snapshot.tokenMintB} in policy?`,
        `Orca pool policy updated`,
      );
    });

  orca
    .command("allowlist-whirlpool")
    .argument("<whirlpool>", "Whirlpool account", validatePublicKey)
    .option(
      "--no-token-mints",
      "Do not also allowlist the Whirlpool token mints",
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a Whirlpool and its token mints to the policy allowlist")
    .action(
      async (
        whirlpool: PublicKey,
        options: TxOptions & { tokenMints?: boolean },
      ) => {
        const snapshot =
          options.tokenMints === false
            ? null
            : await fetchWhirlpoolSnapshot(context, whirlpool);
        await updatePolicy(
          context,
          (policy) => {
            policy.whirlpoolsAllowlist.push(whirlpool);
            if (snapshot) {
              policy.tokenMintsAllowlist.push(
                snapshot.tokenMintA,
                snapshot.tokenMintB,
              );
            }
          },
          options,
          snapshot
            ? `Allowlist Whirlpool ${whirlpool} and its token mints ${snapshot.tokenMintA}, ${snapshot.tokenMintB}?`
            : `Allowlist Whirlpool ${whirlpool}, without its token mints?`,
          `Allowlisted Whirlpool ${whirlpool}`,
        );
      },
    );

  orca
    .command("remove-whirlpool")
    .argument("<whirlpool>", "Whirlpool account", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a Whirlpool from the policy allowlist")
    .action(async (whirlpool: PublicKey, options: TxOptions) => {
      await updatePolicy(
        context,
        (policy) => {
          policy.whirlpoolsAllowlist = policy.whirlpoolsAllowlist.filter(
            (pk) => !pk.equals(whirlpool),
          );
        },
        options,
        `Remove Whirlpool ${whirlpool} from allowlist?`,
        `Removed Whirlpool ${whirlpool}`,
      );
    });

  orca
    .command("allowlist-token")
    .alias("allowlist-mint")
    .argument("<token>", "Token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a token mint to the policy allowlist")
    .action(async (tokenInput: string, options: TxOptions) => {
      const mint = await resolveTokenPublicKey(context.glamClient, tokenInput);
      await updatePolicy(
        context,
        (policy) => policy.tokenMintsAllowlist.push(mint),
        options,
        `Allowlist token mint ${mint}?`,
        `Allowlisted token mint ${mint}`,
      );
    });

  orca
    .command("remove-token")
    .alias("remove-mint")
    .argument("<token>", "Token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a token mint from the policy allowlist")
    .action(async (tokenInput: string, options: TxOptions) => {
      const mint = await resolveTokenPublicKey(context.glamClient, tokenInput);
      await updatePolicy(
        context,
        (policy) => {
          policy.tokenMintsAllowlist = policy.tokenMintsAllowlist.filter(
            (pk) => !pk.equals(mint),
          );
        },
        options,
        `Remove token mint ${mint} from allowlist?`,
        `Removed token mint ${mint}`,
      );
    });

  orca
    .command("list-positions")
    .alias("positions")
    .option("-j, --json", "Output in JSON format", false)
    .description("List open Orca positions held by the GLAM vault")
    .action(async (options: { json?: boolean }) => {
      const positions = await listOpenPositions(context);
      const rows = positions.map((position) => ({
        position: position.position.toBase58(),
        whirlpool: position.whirlpool.toBase58(),
        liquidity: position.liquidity.toString(),
        tickLowerIndex: position.tickLowerIndex,
        tickUpperIndex: position.tickUpperIndex,
      }));

      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log("No open Orca positions found for the configured vault");
        return;
      }

      printTable(
        ["Position", "Whirlpool", "Liquidity", "Tick Lower", "Tick Upper"],
        rows.map((row) => [
          row.position,
          row.whirlpool,
          row.liquidity,
          row.tickLowerIndex.toString(),
          row.tickUpperIndex.toString(),
        ]),
      );
    });

  orca
    .command("position-pda")
    .argument("<position-mint>", "Position mint", validatePublicKey)
    .description("Derive an Orca position PDA")
    .action((positionMint: PublicKey) => {
      const [position, bump] =
        context.glamClient.orca.getPositionPda(positionMint);
      console.log(JSON.stringify({ position, bump }, null, 2));
    });

  orca
    .command("tick-array-pda")
    .argument("<whirlpool>", "Whirlpool account", validatePublicKey)
    .argument(
      "<start-tick-index>",
      "Tick array start tick index",
      parseI32("start-tick-index"),
    )
    .description("Derive an Orca tick-array PDA")
    .action((whirlpool: PublicKey, startTickIndex: number) => {
      const [tickArray, bump] = context.glamClient.orca.getTickArrayPda(
        whirlpool,
        startTickIndex,
      );
      console.log(JSON.stringify({ tickArray, bump }, null, 2));
    });

  orca
    .command("open-position")
    .argument("<whirlpool>", "Whirlpool account", validatePublicKey)
    .argument(
      "<lower-range-pct>",
      "Lower price range percentage; must be less than upper-range-pct",
      parseLowerRangePct,
    )
    .argument(
      "<upper-range-pct>",
      "Upper price range percentage; must be greater than lower-range-pct",
      parseUpperRangePct,
    )
    .argument(
      "[ref-price]",
      "Optional reference UI price anchor, token B per token A; defaults to current pool price",
      parseReferencePrice,
    )
    .option(
      "--ref-price <price>",
      "Reference UI price anchor, token B per token A; defaults to current pool price",
      parseReferencePrice,
    )
    .option(
      "--position-mint <pubkey>",
      "Position mint; omit to auto-generate",
      validatePublicKey,
    )
    .option("--position <pubkey>", "Position PDA override", validatePublicKey)
    .option(
      "--position-token-account <pubkey>",
      "Vault-owned position token account",
      validatePublicKey,
    )
    .option(
      "--position-mint-keypair <path>",
      "Optional keypair file for the new position mint signer",
    )
    .option(
      "--metadata-update-auth <pubkey>",
      "Metadata update authority override",
      validatePublicKey,
    )
    .option(
      "--without-token-metadata-extension",
      "Do not create Token-2022 metadata extension",
      false,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Open an Orca Token-2022 position for the vault")
    .action(
      async (
        whirlpool: PublicKey,
        lowerRangePct: number,
        upperRangePct: number,
        refPriceArg: number | undefined,
        options: TxOptions & {
          refPrice?: number;
          positionMint?: PublicKey;
          position?: PublicKey;
          positionTokenAccount?: PublicKey;
          positionMintKeypair?: string;
          metadataUpdateAuth?: PublicKey;
          withoutTokenMetadataExtension?: boolean;
        },
      ) => {
        validateRangePctOrder(lowerRangePct, upperRangePct);
        if (refPriceArg !== undefined && options.refPrice !== undefined) {
          fail("Use either positional ref-price or --ref-price, not both");
        }
        const refPrice = options.refPrice ?? refPriceArg;

        const whirlpoolSnapshot = await fetchWhirlpoolSnapshot(
          context,
          whirlpool,
        );
        await requireOrcaPolicy(
          context,
          "open-position",
          whirlpool,
          whirlpoolSnapshot,
          true,
        );
        const anchorTick =
          refPrice === undefined
            ? undefined
            : await tickFromUiReferencePrice(
                context,
                whirlpoolSnapshot,
                refPrice,
              );
        const { tickLowerIndex, tickUpperIndex } =
          tickRangeFromPricePercentages(
            whirlpoolSnapshot,
            lowerRangePct,
            upperRangePct,
            anchorTick,
          );
        const params: OpenOrcaPositionWithTokenExtensionsParams = {
          tickLowerIndex,
          tickUpperIndex,
          withTokenMetadataExtension: !options.withoutTokenMetadataExtension,
        };
        const providedPositionMintKeypair = options.positionMintKeypair
          ? readKeypair(options.positionMintKeypair)
          : undefined;
        if (options.positionMint && !providedPositionMintKeypair) {
          fail(
            "Provide --position-mint-keypair for --position-mint, or omit --position-mint to auto-generate",
          );
        }
        const positionMintKeypair =
          providedPositionMintKeypair ?? Keypair.generate();
        const positionMint =
          options.positionMint ?? positionMintKeypair.publicKey;
        const accounts: OpenOrcaPositionWithTokenExtensionsAccounts = {
          whirlpool,
          positionMint,
          position: options.position,
          positionTokenAccount: options.positionTokenAccount,
          metadataUpdateAuth: options.metadataUpdateAuth,
        };
        if (
          providedPositionMintKeypair &&
          !positionMintKeypair.publicKey.equals(positionMint)
        ) {
          fail(
            `Position mint keypair pubkey ${positionMintKeypair.publicKey} does not match ${positionMint}`,
          );
        }
        const position =
          options.position ??
          context.glamClient.orca.getPositionPda(positionMint)[0];

        await executeTxWithErrorHandling(
          async () => {
            const tx =
              await context.glamClient.orca.txBuilder.openPositionWithTokenExtensionsTx(
                params,
                accounts,
                context.txOptions,
              );
            return await context.glamClient.sendAndConfirm(tx, [
              positionMintKeypair,
            ]);
          },
          {
            skip: !!options.yes,
            message: `Open Orca position for ${whirlpool} with ticks [${tickLowerIndex}, ${tickUpperIndex}) from ${lowerRangePct}%/${upperRangePct}% price range anchored at ${refPrice === undefined ? "current pool price" : `ref price ${refPrice}`}?`,
          },
          (txSig) =>
            `Opened Orca position ${position} with mint ${positionMint} and ticks [${tickLowerIndex}, ${tickUpperIndex}): ${txSig}`,
        );
      },
    );

  orca
    .command("initialize-tick-array")
    .argument("<whirlpool>", "Whirlpool account", validatePublicKey)
    .argument(
      "<start-tick-index>",
      "Tick array start tick index",
      parseI32("start-tick-index"),
    )
    .option(
      "--tick-array <pubkey>",
      "Tick array PDA override",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Initialize an Orca tick array through the vault")
    .action(
      async (
        whirlpool: PublicKey,
        startTickIndex: number,
        options: TxOptions & { tickArray?: PublicKey },
      ) => {
        const snapshot = await fetchWhirlpoolSnapshot(context, whirlpool);
        // Whirlpool takes a start that is a multiple of the ticks one array
        // spans and whose array holds a tick in bounds (InvalidStartTick).
        const span = TICK_ARRAY_SIZE * snapshot.tickSpacing;
        if (
          startTickIndex % span !== 0 ||
          startTickIndex > ORCA_MAX_TICK_INDEX ||
          startTickIndex + span <= ORCA_MIN_TICK_INDEX
        ) {
          const nearest = Math.floor(startTickIndex / span) * span;
          fail(
            `start-tick-index must be a multiple of ${span} (${TICK_ARRAY_SIZE} ticks of spacing ${snapshot.tickSpacing}) whose array holds a tick in [${ORCA_MIN_TICK_INDEX}, ${ORCA_MAX_TICK_INDEX}]; the nearest start at or below ${startTickIndex} is ${nearest}`,
          );
        }
        await requireOrcaPolicy(
          context,
          "initialize-tick-array",
          whirlpool,
          snapshot,
          true,
        );
        await executeTxWithErrorHandling(
          () =>
            context.glamClient.orca.initializeTickArray(
              { startTickIndex },
              { whirlpool, tickArray: options.tickArray },
              context.txOptions,
            ),
          {
            skip: !!options.yes,
            message: `Initialize tick array ${startTickIndex} for ${whirlpool}, covering ticks [${startTickIndex}, ${startTickIndex + span})?`,
          },
          (txSig) => `Initialized Orca tick array: ${txSig}`,
        );
      },
    );

  addLiquidityAccountOptions(
    orca
      .command("increase-liquidity-v2")
      .argument("<position>", "Orca position account", validatePublicKey)
      .argument("<liquidity-amount>", "Liquidity amount")
      .argument("<token-max-a>", "Max token A amount")
      .argument("<token-max-b>", "Max token B amount")
      .option("-y, --yes", "Skip confirmation prompt", false)
      .description("Increase liquidity in an Orca position"),
  ).action(
    async (
      position: PublicKey,
      liquidityAmount: string,
      tokenMaxA: string,
      tokenMaxB: string,
      options: TxOptions & DerivedPositionOptions,
    ) => {
      const remaining = parseRemainingOptions(
        options,
        "increase-liquidity-v2",
        TRANSFER_HOOKS_A_B,
      );
      const maxA = parseU64(tokenMaxA, "token-max-a");
      const maxB = parseU64(tokenMaxB, "token-max-b");
      requireATokenMax(
        "increase-liquidity-v2",
        maxA,
        maxB,
        "token-max-a and token-max-b",
      );
      const params: IncreaseOrcaLiquidityV2Params = {
        // Whirlpool refuses a liquidity amount of 0, and one past the i128
        // it converts the amount to (LiquidityTooHigh).
        liquidityAmount: parsePositiveBn(
          liquidityAmount,
          "liquidity-amount",
          I128_MAX_BN,
        ),
        tokenMaxA: maxA,
        tokenMaxB: maxB,
        ...remaining,
      };
      // The position is read before the confirmation, like any other input.
      const accounts = await deriveLiquidityAccounts(
        context,
        position,
        options,
        remaining,
        { command: "increase-liquidity-v2", policy: "allowlists" },
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.orca.increaseLiquidityV2(
            params,
            accounts,
            context.txOptions,
          ),
        {
          skip: !!options.yes,
          message: `Increase Orca liquidity for position ${position} by ${params.liquidityAmount}, paying at most ${params.tokenMaxA} of token A and ${params.tokenMaxB} of token B (raw amounts)?`,
        },
        (txSig) => `Increased Orca liquidity: ${txSig}`,
      );
    },
  );

  addLiquidityAccountOptions(
    orca
      .command("increase-liquidity-by-token-amounts-v2")
      .argument("<position>", "Orca position account", validatePublicKey)
      .argument("<token-max-a>", "Max token A amount")
      .argument("<token-max-b>", "Max token B amount")
      .option("-y, --yes", "Skip confirmation prompt", false)
      .description("Increase Orca liquidity by token amounts"),
  ).action(
    async (
      position: PublicKey,
      tokenMaxA: string,
      tokenMaxB: string,
      options: TxOptions & DerivedPositionOptions,
    ) => {
      const maxA = parseU64(tokenMaxA, "token-max-a");
      const maxB = parseU64(tokenMaxB, "token-max-b");
      requireATokenMax(
        "increase-liquidity-by-token-amounts-v2",
        maxA,
        maxB,
        "token-max-a and token-max-b",
      );
      const remaining = parseRemainingOptions(
        options,
        "increase-liquidity-by-token-amounts-v2",
        TRANSFER_HOOKS_A_B,
      );
      const positionSnapshot = await fetchPositionSnapshot(context, position);
      const minSqrtPrice = sqrtPriceFromTickIndex(
        positionSnapshot.tickLowerIndex,
      );
      const maxSqrtPrice = sqrtPriceFromTickIndex(
        positionSnapshot.tickUpperIndex,
      );
      // The position's range is sent as the price band, and Whirlpool refuses
      // the increase while the pool's price is outside it
      // (PriceSlippageOutOfBounds).
      const pool = await fetchWhirlpoolSnapshot(
        context,
        positionSnapshot.whirlpool,
      );
      if (pool.sqrtPrice < minSqrtPrice || pool.sqrtPrice > maxSqrtPrice) {
        fail(
          `increase-liquidity-by-token-amounts-v2 sends the position's range [${positionSnapshot.tickLowerIndex}, ${positionSnapshot.tickUpperIndex}) as its price band, and the pool's price, at tick ${Math.floor(currentTickFromSqrtPrice(pool.sqrtPrice))}, is outside it; use increase-liquidity-v2 for a position out of range`,
        );
      }
      const params: IncreaseOrcaLiquidityByTokenAmountsV2Params = {
        method: {
          byTokenAmounts: {
            tokenMaxA: maxA,
            tokenMaxB: maxB,
            minSqrtPrice: new BN(minSqrtPrice.toString()),
            maxSqrtPrice: new BN(maxSqrtPrice.toString()),
          },
        },
        ...remaining,
      };
      const accounts = await deriveLiquidityAccounts(
        context,
        position,
        options,
        remaining,
        {
          command: "increase-liquidity-by-token-amounts-v2",
          policy: "allowlists",
        },
        positionSnapshot,
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.orca.increaseLiquidityByTokenAmountsV2(
            params,
            accounts,
            context.txOptions,
          ),
        {
          skip: !!options.yes,
          message: `Increase Orca liquidity by token amounts for position ${position} using ticks [${positionSnapshot.tickLowerIndex}, ${positionSnapshot.tickUpperIndex}), paying at most ${maxA} of token A and ${maxB} of token B (raw amounts), only while the pool's price stays within those ticks?`,
        },
        (txSig) => `Increased Orca liquidity by token amounts: ${txSig}`,
      );
    },
  );

  addLiquidityAccountOptions(
    orca
      .command("decrease-liquidity-v2")
      .argument("<position>", "Orca position account", validatePublicKey)
      .argument("<liquidity-amount>", "Liquidity amount")
      .argument("<token-min-a>", "Minimum token A amount")
      .argument("<token-min-b>", "Minimum token B amount")
      .option("-y, --yes", "Skip confirmation prompt", false)
      .description("Decrease liquidity in an Orca position"),
  ).action(
    async (
      position: PublicKey,
      liquidityAmount: string,
      tokenMinA: string,
      tokenMinB: string,
      options: TxOptions & DerivedPositionOptions,
    ) => {
      const remaining = parseRemainingOptions(
        options,
        "decrease-liquidity-v2",
        TRANSFER_HOOKS_A_B,
      );
      const params: DecreaseOrcaLiquidityV2Params = {
        // Whirlpool refuses a liquidity amount of 0, and one past the i128
        // it converts the amount to (LiquidityTooHigh).
        liquidityAmount: parsePositiveBn(
          liquidityAmount,
          "liquidity-amount",
          I128_MAX_BN,
        ),
        tokenMinA: parseU64(tokenMinA, "token-min-a"),
        tokenMinB: parseU64(tokenMinB, "token-min-b"),
        ...remaining,
      };
      const positionSnapshot = await fetchPositionSnapshot(context, position);
      // A position cannot give up more liquidity than it holds.
      if (
        BigInt(params.liquidityAmount.toString()) > positionSnapshot.liquidity
      ) {
        fail(
          `decrease-liquidity-v2 takes at most the position's liquidity, ${positionSnapshot.liquidity}, and liquidity-amount is ${params.liquidityAmount}`,
        );
      }
      const accounts = await deriveLiquidityAccounts(
        context,
        position,
        options,
        remaining,
        { command: "decrease-liquidity-v2", policy: "policy" },
        positionSnapshot,
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.orca.decreaseLiquidityV2(
            params,
            accounts,
            context.txOptions,
          ),
        {
          skip: !!options.yes,
          message: `Decrease Orca liquidity for position ${position} by ${params.liquidityAmount}, receiving at least ${params.tokenMinA} of token A and ${params.tokenMinB} of token B (raw amounts)?`,
        },
        (txSig) => `Decreased Orca liquidity: ${txSig}`,
      );
    },
  );

  addRemainingOptions(
    addCommonTokenOptions(
      orca
        .command("reposition-liquidity-v2")
        .argument("<position>", "Orca position account", validatePublicKey)
        .argument(
          "<new-tick-lower-index>",
          "New lower tick index",
          parseI32("new-tick-lower-index"),
        )
        .argument(
          "<new-tick-upper-index>",
          "New upper tick index",
          parseI32("new-tick-upper-index"),
        )
        .argument("<new-liquidity-amount>", "New liquidity amount")
        .argument("<existing-range-token-min-a>", "Existing range min token A")
        .argument("<existing-range-token-min-b>", "Existing range min token B")
        .argument("<new-range-token-max-a>", "New range max token A")
        .argument("<new-range-token-max-b>", "New range max token B")
        .option(
          "--position-token-account <pubkey>",
          "Vault-owned position token account",
          validatePublicKey,
        )
        .option(
          "--token-owner-account-a <pubkey>",
          "Vault token A account",
          validatePublicKey,
        )
        .option(
          "--token-owner-account-b <pubkey>",
          "Vault token B account",
          validatePublicKey,
        )
        .option(
          "--existing-tick-array-lower <pubkey>",
          "Existing lower tick array override",
          validatePublicKey,
        )
        .option(
          "--existing-tick-array-upper <pubkey>",
          "Existing upper tick array override",
          validatePublicKey,
        )
        .option(
          "--new-tick-array-lower <pubkey>",
          "New lower tick array override",
          validatePublicKey,
        )
        .option(
          "--new-tick-array-upper <pubkey>",
          "New upper tick array override",
          validatePublicKey,
        )
        .option("-y, --yes", "Skip confirmation prompt", false)
        .description("Reposition an Orca liquidity position"),
    ),
  ).action(
    async (
      position: PublicKey,
      newTickLowerIndex: number,
      newTickUpperIndex: number,
      newLiquidityAmount: string,
      existingRangeTokenMinA: string,
      existingRangeTokenMinB: string,
      newRangeTokenMaxA: string,
      newRangeTokenMaxB: string,
      options: TxOptions &
        RemainingOptions &
        CommonTokenOptions & {
          positionTokenAccount?: PublicKey;
          tokenOwnerAccountA?: PublicKey;
          tokenOwnerAccountB?: PublicKey;
          existingTickArrayLower?: PublicKey;
          existingTickArrayUpper?: PublicKey;
          newTickArrayLower?: PublicKey;
          newTickArrayUpper?: PublicKey;
        },
    ) => {
      if (newTickLowerIndex >= newTickUpperIndex) {
        fail("new-tick-lower-index must be less than new-tick-upper-index");
      }
      // Whirlpool's interface names what it refuses here: a liquidity amount
      // of 0 or past the i128 it converts the amount to, a tick out of
      // bounds, out of order or off the pool's tick spacing, and the range
      // the position already has.
      const byLiquidity = {
        newLiquidityAmount: parsePositiveBn(
          newLiquidityAmount,
          "new-liquidity-amount",
          I128_MAX_BN,
        ),
        existingRangeTokenMinA: parseU64(
          existingRangeTokenMinA,
          "existing-range-token-min-a",
        ),
        existingRangeTokenMinB: parseU64(
          existingRangeTokenMinB,
          "existing-range-token-min-b",
        ),
        newRangeTokenMaxA: parseU64(newRangeTokenMaxA, "new-range-token-max-a"),
        newRangeTokenMaxB: parseU64(newRangeTokenMaxB, "new-range-token-max-b"),
      };
      const remaining = parseRemainingOptions(
        options,
        "reposition-liquidity-v2",
        REPOSITION_TRANSFER_HOOKS,
      );

      requireATokenMax(
        "reposition-liquidity-v2",
        byLiquidity.newRangeTokenMaxA,
        byLiquidity.newRangeTokenMaxB,
        "new-range-token-max-a and new-range-token-max-b",
      );
      const positionSnapshot = await fetchPositionSnapshot(context, position);
      // An empty position returns no tokens from its range.
      if (
        positionSnapshot.liquidity === 0n &&
        !(
          byLiquidity.existingRangeTokenMinA.isZero() &&
          byLiquidity.existingRangeTokenMinB.isZero()
        )
      ) {
        fail(
          `Position ${position} holds no liquidity, so its existing range returns no tokens: existing-range-token-min-a and existing-range-token-min-b must be 0`,
        );
      }
      const whirlpoolSnapshot = await fetchWhirlpoolSnapshot(
        context,
        positionSnapshot.whirlpool,
      );
      await requireOrcaPolicy(
        context,
        "reposition-liquidity-v2",
        positionSnapshot.whirlpool,
        whirlpoolSnapshot,
        true,
      );
      if (
        newTickLowerIndex === positionSnapshot.tickLowerIndex &&
        newTickUpperIndex === positionSnapshot.tickUpperIndex
      ) {
        fail(
          `the new tick range [${newTickLowerIndex}, ${newTickUpperIndex}) is the position's current range`,
        );
      }
      // A position's ticks are ticks the pool can initialize, as open-position
      // derives them: multiples of its tick spacing inside the tick range.
      const { tickSpacing } = whirlpoolSnapshot;
      const lowest = minInitializableTick(tickSpacing);
      const highest = maxInitializableTick(tickSpacing);
      for (const [label, tick] of [
        ["new-tick-lower-index", newTickLowerIndex],
        ["new-tick-upper-index", newTickUpperIndex],
      ] as const) {
        if (tick < lowest || tick > highest || tick % tickSpacing !== 0) {
          fail(
            `${label} must be a multiple of the pool's tick spacing ${tickSpacing} in [${lowest}, ${highest}]`,
          );
        }
      }
      const { tokenProgramA, tokenProgramB } = await tokenProgramsForWhirlpool(
        context,
        whirlpoolSnapshot,
        options,
      );
      const params: RepositionOrcaLiquidityV2Params = {
        newTickLowerIndex,
        newTickUpperIndex,
        method: { byLiquidity },
        ...remaining,
      };
      const accounts: RepositionOrcaLiquidityV2Accounts = {
        ...remaining,
        whirlpool: positionSnapshot.whirlpool,
        position,
        positionMint: positionSnapshot.positionMint,
        positionTokenAccount: options.positionTokenAccount,
        tokenMintA: whirlpoolSnapshot.tokenMintA,
        tokenMintB: whirlpoolSnapshot.tokenMintB,
        tokenOwnerAccountA: options.tokenOwnerAccountA,
        tokenOwnerAccountB: options.tokenOwnerAccountB,
        tokenVaultA: whirlpoolSnapshot.tokenVaultA,
        tokenVaultB: whirlpoolSnapshot.tokenVaultB,
        priceDeviationAccounts: await derivePriceDeviationAccounts(
          context,
          whirlpoolSnapshot,
        ),
        existingTickArrayLower:
          options.existingTickArrayLower ??
          deriveTickArray(
            context,
            positionSnapshot.whirlpool,
            positionSnapshot.tickLowerIndex,
            whirlpoolSnapshot.tickSpacing,
          ),
        existingTickArrayUpper:
          options.existingTickArrayUpper ??
          deriveTickArray(
            context,
            positionSnapshot.whirlpool,
            positionSnapshot.tickUpperIndex,
            whirlpoolSnapshot.tickSpacing,
          ),
        newTickArrayLower:
          options.newTickArrayLower ??
          deriveTickArray(
            context,
            positionSnapshot.whirlpool,
            newTickLowerIndex,
            whirlpoolSnapshot.tickSpacing,
          ),
        newTickArrayUpper:
          options.newTickArrayUpper ??
          deriveTickArray(
            context,
            positionSnapshot.whirlpool,
            newTickUpperIndex,
            whirlpoolSnapshot.tickSpacing,
          ),
        tokenProgramA,
        tokenProgramB,
        memoProgram: options.memoProgram,
      };

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.orca.repositionLiquidityV2(
            params,
            accounts,
            context.txOptions,
          ),
        {
          skip: !!options.yes,
          message: `Reposition Orca liquidity for position ${position} from ticks [${positionSnapshot.tickLowerIndex}, ${positionSnapshot.tickUpperIndex}), which hold ${positionSnapshot.liquidity} of liquidity, to ticks [${newTickLowerIndex}, ${newTickUpperIndex}) with liquidity ${byLiquidity.newLiquidityAmount}: at least ${byLiquidity.existingRangeTokenMinA} of token A and ${byLiquidity.existingRangeTokenMinB} of token B out of the existing range, at most ${byLiquidity.newRangeTokenMaxA} of token A and ${byLiquidity.newRangeTokenMaxB} of token B into the new one (raw amounts)?`,
        },
        (txSig) => `Repositioned Orca liquidity: ${txSig}`,
      );
    },
  );

  orca
    .command("update-fees-and-rewards")
    .argument("<position>", "Position account", validatePublicKey)
    .option(
      "--tick-array-lower <pubkey>",
      "Lower tick array override",
      validatePublicKey,
    )
    .option(
      "--tick-array-upper <pubkey>",
      "Upper tick array override",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Update fees and rewards on an Orca position")
    .action(
      async (
        position: PublicKey,
        options: TxOptions & {
          tickArrayLower?: PublicKey;
          tickArrayUpper?: PublicKey;
        },
      ) => {
        const accounts = await deriveUpdateFeesAndRewardsAccounts(
          context,
          position,
          options,
        );
        await executeTxWithErrorHandling(
          () =>
            context.glamClient.orca.updateFeesAndRewards(
              accounts,
              context.txOptions,
            ),
          {
            skip: !!options.yes,
            message: `Update Orca fees and rewards for position ${position}?`,
          },
          (txSig) => `Updated Orca fees and rewards: ${txSig}`,
        );
      },
    );

  addRemainingOptions(
    addCommonTokenOptions(
      orca
        .command("collect-fees-v2")
        .argument("<position>", "Orca position account", validatePublicKey)
        .option(
          "--position-token-account <pubkey>",
          "Vault-owned position token account",
          validatePublicKey,
        )
        .option(
          "--token-owner-account-a <pubkey>",
          "Vault token A account",
          validatePublicKey,
        )
        .option(
          "--token-owner-account-b <pubkey>",
          "Vault token B account",
          validatePublicKey,
        )
        .option("-y, --yes", "Skip confirmation prompt", false)
        .description("Collect fees from an Orca position"),
    ),
  ).action(
    async (
      position: PublicKey,
      options: TxOptions & DerivedPositionOptions,
    ) => {
      // The position and the JSON options are read before the confirmation.
      const accounts = await deriveLiquidityAccounts(
        context,
        position,
        options,
        parseRemainingOptions(options, "collect-fees-v2", TRANSFER_HOOKS_A_B),
        { command: "collect-fees-v2", policy: "none" },
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.orca.collectFeesV2(accounts, context.txOptions),
        {
          skip: !!options.yes,
          message: `Collect Orca fees for position ${position}?`,
        },
        (txSig) => `Collected Orca fees: ${txSig}`,
      );
    },
  );

  addRemainingOptions(
    orca
      .command("collect-reward-v2")
      .argument("<position>", "Orca position account", validatePublicKey)
      .argument("<reward-index>", "Reward index", parseU8)
      .option(
        "--position-token-account <pubkey>",
        "Vault-owned position token account",
        validatePublicKey,
      )
      .option(
        "--reward-owner-account <pubkey>",
        "Vault reward token account",
        validatePublicKey,
      )
      .option(
        "--reward-token-program <pubkey>",
        "Reward token program",
        validatePublicKey,
      )
      .option(
        "--memo-program <pubkey>",
        "SPL Memo program override",
        validatePublicKey,
      )
      .option("-y, --yes", "Skip confirmation prompt", false)
      .description("Collect a reward from an Orca position"),
  ).action(
    async (
      position: PublicKey,
      rewardIndex: number,
      options: TxOptions &
        RemainingOptions & {
          positionTokenAccount?: PublicKey;
          rewardOwnerAccount?: PublicKey;
          rewardTokenProgram?: PublicKey;
          memoProgram?: PublicKey;
        },
    ) => {
      const positionSnapshot = await fetchPositionSnapshot(context, position);
      const { rewardMint, rewardVault } = await fetchRewardInfo(
        context,
        positionSnapshot.whirlpool,
        rewardIndex,
      );
      if (rewardMint.equals(PublicKey.default)) {
        fail(`Whirlpool reward ${rewardIndex} is not initialized`);
      }
      const rewardTokenProgram =
        options.rewardTokenProgram ??
        (
          await fetchMintAndTokenProgram(
            context.glamClient.connection,
            rewardMint,
          )
        ).tokenProgram;
      const accounts: CollectOrcaRewardV2Accounts = {
        ...parseRemainingOptions(
          options,
          "collect-reward-v2",
          TRANSFER_HOOK_REWARD,
        ),
        whirlpool: positionSnapshot.whirlpool,
        position,
        positionMint: positionSnapshot.positionMint,
        positionTokenAccount: options.positionTokenAccount,
        rewardMint,
        rewardVault,
        rewardOwnerAccount: options.rewardOwnerAccount,
        rewardTokenProgram,
        memoProgram: options.memoProgram,
      };
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.orca.collectRewardV2(
            rewardIndex,
            accounts,
            context.txOptions,
          ),
        {
          skip: !!options.yes,
          message: `Collect Orca reward ${rewardIndex} for position ${position}?`,
        },
        (txSig) => `Collected Orca reward: ${txSig}`,
      );
    },
  );

  orca
    .command("close-position")
    .argument("<position>", "Position account", validatePublicKey)
    .option(
      "--position-token-account <pubkey>",
      "Vault-owned position token account",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Close a zero-liquidity Orca position")
    .action(
      async (
        position: PublicKey,
        options: TxOptions & { positionTokenAccount?: PublicKey },
      ) => {
        const positionSnapshot = await fetchPositionSnapshot(context, position);
        // Whirlpool closes only an empty position: no liquidity, no fees
        // owed and no rewards owed (ClosePositionNotEmpty).
        const held = [
          ...(positionSnapshot.liquidity > 0n
            ? [
                `${positionSnapshot.liquidity} of liquidity (decrease-liquidity-v2)`,
              ]
            : []),
          ...(positionSnapshot.feeOwedA > 0n || positionSnapshot.feeOwedB > 0n
            ? [
                `fees owed of ${positionSnapshot.feeOwedA} of token A and ${positionSnapshot.feeOwedB} of token B (collect-fees-v2)`,
              ]
            : []),
          ...positionSnapshot.rewardsOwed.flatMap((owed, index) =>
            owed > 0n
              ? [`${owed} of reward ${index} owed (collect-reward-v2 ${index})`]
              : [],
          ),
        ];
        if (held.length > 0) {
          fail(
            `Whirlpool closes only an empty position, and ${position} holds ${held.join(", ")}`,
          );
        }
        const accounts: OrcaPositionAccounts = {
          whirlpool: positionSnapshot.whirlpool,
          position,
          positionMint: positionSnapshot.positionMint,
          positionTokenAccount: options.positionTokenAccount,
        };
        await executeTxWithErrorHandling(
          () =>
            context.glamClient.orca.closePositionWithTokenExtensions(
              accounts,
              context.txOptions,
            ),
          {
            skip: !!options.yes,
            message: `Close Orca position ${position}?`,
          },
          (txSig) => `Closed Orca position: ${txSig}`,
        );
      },
    );
}
