import { BN } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {
  EXPONENT_MARKET_TWO_DISCRIMINATOR,
  EXPONENT_CORE_PROGRAM_ID,
  EXPONENT_GENERIC_STANDARD_PROGRAM_ID,
  EXPONENT_MAX_ALLOWLIST,
  ExponentGenericSyState,
  ExponentMarketTwo,
  ExponentPolicy,
  ExponentVault,
  PkSet,
  type ExponentCpiAccounts,
  type ExponentCpiInterfaceContext,
  type TxOptions,
} from "@glamsystems/glam-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  type AccountMeta,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { type Command } from "commander";
import fs from "fs";

import {
  type CliContext,
  collectPublicKeys,
  executeTxWithErrorHandling,
  parseNonNegativeInteger,
  printPubkeyList,
  printTable,
  validatePublicKey,
} from "../utils";
import {
  editsStagedLine,
  readVaultTimelock,
  type VaultTimelock,
} from "../staging";
import { fail } from "../errors";
import { I64_MAX_BN } from "../parsing";

const EXPONENT_CORE_PROTOCOL = 0b1;
const U64_MAX = new BN("18446744073709551615");

type CliTxOptions = {
  yes?: boolean;
};

type RemainingAccountsOptions = {
  remainingAccounts?: string;
};

type TxLookupTableOptions = {
  txLookupTable?: PublicKey[];
};

type ExponentMarketAccountsOptions = RemainingAccountsOptions &
  TxLookupTableOptions & {
    market: PublicKey;
    tokenSyTrader?: PublicKey;
    tokenPtTrader?: PublicKey;
    tokenSyEscrow?: PublicKey;
    tokenPtEscrow?: PublicKey;
    addressLookupTable?: PublicKey;
    syProgram?: PublicKey;
    tokenFeeTreasurySy?: PublicKey;
    eventAuthority?: PublicKey;
    tokenProgram?: PublicKey;
  };

type ExponentMergeAccountsOptions = RemainingAccountsOptions &
  TxLookupTableOptions & {
    tokenSyMerger: PublicKey;
    vault: PublicKey;
    escrowSy: PublicKey;
    tokenYtMerger: PublicKey;
    tokenPtMerger: PublicKey;
    mintYt: PublicKey;
    mintPt: PublicKey;
    authority: PublicKey;
    vaultAddressLookupTable: PublicKey;
    vaultRobotYieldPosition: PublicKey;
    syProgram: PublicKey;
    eventAuthority?: PublicKey;
    tokenProgram?: PublicKey;
  };

type ExponentMarket = ExponentMarketTwo;
type CpiInterfaceContext = ExponentCpiInterfaceContext;
type ParsedCpiAccounts = ExponentCpiAccounts;

type DerivedWrapperRemainingAccounts = {
  remainingAccounts: AccountMeta[];
  splitIndex: number;
  preInstructions?: TransactionInstruction[];
};

function defaultPolicy(): ExponentPolicy {
  return new ExponentPolicy([], []);
}

async function fetchPolicy(
  context: CliContext,
): Promise<ExponentPolicy | null> {
  return await context.glamClient.fetchProtocolPolicy(
    context.glamClient.extExponentProgram.programId,
    EXPONENT_CORE_PROTOCOL,
    ExponentPolicy,
  );
}

function printPolicy(policy: ExponentPolicy) {
  printPubkeyList("Markets allowlist", policy.marketsAllowlist);
  printPubkeyList("Vaults allowlist", policy.vaultsAllowlist);
}

function uniquePubkeys(pubkeys: PublicKey[]): PublicKey[] {
  return Array.from(new PkSet(pubkeys));
}

function validatePolicy(policy: ExponentPolicy) {
  const lists: [string, PublicKey[]][] = [
    ["markets allowlist", policy.marketsAllowlist],
    ["vaults allowlist", policy.vaultsAllowlist],
  ];

  for (const [label, list] of lists) {
    if (list.length > EXPONENT_MAX_ALLOWLIST) {
      fail(
        `${label} cannot contain more than ${EXPONENT_MAX_ALLOWLIST} entries`,
      );
    }
    if (list.some((pubkey) => pubkey.equals(PublicKey.default))) {
      fail(`${label} cannot contain the default pubkey`);
    }
    if (uniquePubkeys(list).length !== list.length) {
      fail(`${label} cannot contain duplicate entries`);
    }
  }
}

/** The Exponent policy an edit replaces: the staged one under a timelock that holds one. */
async function exponentPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => fetchPolicy(context),
    () => context.glamClient.extExponentProgram.programId,
    EXPONENT_CORE_PROTOCOL,
    ExponentPolicy.decode,
  );
}

async function setPolicy(
  context: CliContext,
  policy: ExponentPolicy,
  options: CliTxOptions,
  message: string,
  success: string,
  timelock?: VaultTimelock,
) {
  validatePolicy(policy);
  const vaultTimelock = timelock ?? (await readVaultTimelock(context));
  await executeTxWithErrorHandling(
    () =>
      context.glamClient.exponent.setExponentPolicy(policy, context.txOptions),
    { skip: !!options.yes, message: vaultTimelock.confirm(message) },
    vaultTimelock.outcome(success),
  );
}

async function updatePolicy(
  context: CliContext,
  mutate: (policy: ExponentPolicy) => void,
  options: CliTxOptions,
  message: string,
  success: string,
) {
  const timelock = await readVaultTimelock(context);
  const base = await exponentPolicyToEdit(context, timelock);
  const policy = base.value ?? defaultPolicy();
  mutate(policy);
  await setPolicy(
    context,
    policy,
    options,
    [
      message,
      ...(base.stagedApart
        ? [editsStagedLine("the Exponent Core policy")]
        : []),
    ].join("\n"),
    success,
    timelock,
  );
}

function addUniqueEntry(list: PublicKey[], pubkey: PublicKey, label: string) {
  if (list.some((entry) => entry.equals(pubkey))) {
    fail(`${label} ${pubkey} is already in the allowlist`);
  }
  list.push(pubkey);
}

function removeEntry(list: PublicKey[], pubkey: PublicKey, label: string) {
  if (!list.some((entry) => entry.equals(pubkey))) {
    fail(`${label} ${pubkey} is not in the allowlist`);
  }
  return list.filter((entry) => !entry.equals(pubkey));
}

function parseU64(value: string, label: string, allowZero = false): BN {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    fail(`${label} must be a non-negative integer`);
  }

  const parsed = new BN(trimmed);
  if (parsed.gt(U64_MAX)) {
    fail(`${label} exceeds u64 max`);
  }
  if (!allowZero && parsed.isZero()) {
    fail(`${label} must be greater than zero`);
  }
  return parsed;
}

/**
 * The PT amount of a trade. The wrapper hands it to Exponent as an i64, and
 * the program refuses one that does not fit.
 */
function parseTradePtAmount(value: string): BN {
  const parsed = parseU64(value, "pt-amount-raw");
  if (parsed.gt(I64_MAX_BN)) {
    fail(
      `pt-amount-raw exceeds ${I64_MAX_BN.toString()}, the i64 maximum: Exponent takes a trade's PT amount as an i64`,
    );
  }
  return parsed;
}

function parseU8(value: string, label: string): number {
  const parsed = parseNonNegativeInteger(value, label);
  if (parsed > 0xff) {
    fail(`${label} must be at most 255`);
  }
  return parsed;
}

function parseMarket(pubkey: PublicKey, data: Buffer): ExponentMarket {
  if (
    data.length < ExponentMarketTwo.fixedDataLength ||
    !ExponentMarketTwo.hasDiscriminator(data)
  ) {
    fail(`Invalid Exponent MarketTwo account: ${pubkey}`);
  }

  try {
    return ExponentMarketTwo.decode(pubkey, data);
  } catch (error) {
    fail(
      `Invalid Exponent MarketTwo account ${pubkey}: ${(error as Error).message}`,
    );
  }
}

function parseVault(pubkey: PublicKey, data: Buffer): ExponentVault {
  if (
    data.length < ExponentVault.fixedDataLength ||
    !ExponentVault.hasDiscriminator(data)
  ) {
    fail(`Invalid Exponent Vault account: ${pubkey}`);
  }

  try {
    return ExponentVault.decode(pubkey, data);
  } catch (error) {
    fail(
      `Invalid Exponent Vault account ${pubkey}: ${(error as Error).message}`,
    );
  }
}

function parseGenericSyState(
  pubkey: PublicKey,
  data: Buffer,
): ExponentGenericSyState {
  if (data.length < ExponentGenericSyState.fixedDataLength) {
    fail(`Invalid Exponent generic SY state account: ${pubkey}`);
  }

  try {
    return ExponentGenericSyState.decode(pubkey, data);
  } catch (error) {
    fail(
      `Invalid Exponent generic SY state account ${pubkey}: ${(error as Error).message}`,
    );
  }
}

async function fetchMarket(
  context: CliContext,
  marketPubkey: PublicKey,
): Promise<{ market: ExponentMarket }> {
  const account =
    await context.glamClient.connection.getAccountInfo(marketPubkey);
  if (!account) {
    fail(`Exponent market account not found: ${marketPubkey}`);
  }
  if (!account.owner.equals(EXPONENT_CORE_PROGRAM_ID)) {
    fail(
      `Exponent market ${marketPubkey} is owned by ${account.owner}, expected ${EXPONENT_CORE_PROGRAM_ID}`,
    );
  }
  return { market: parseMarket(marketPubkey, account.data) };
}

async function fetchVault(
  context: CliContext,
  vaultPubkey: PublicKey,
): Promise<{ vault: ExponentVault }> {
  const account =
    await context.glamClient.connection.getAccountInfo(vaultPubkey);
  if (!account) {
    fail(`Exponent vault account not found: ${vaultPubkey}`);
  }
  if (!account.owner.equals(EXPONENT_CORE_PROGRAM_ID)) {
    fail(
      `Exponent vault ${vaultPubkey} is owned by ${account.owner}, expected ${EXPONENT_CORE_PROGRAM_ID}`,
    );
  }
  return { vault: parseVault(vaultPubkey, account.data) };
}

function formatMarketDate(expirationTs: string): string {
  const timestamp = Number(expirationTs);
  if (!Number.isSafeInteger(timestamp) || timestamp === 0) {
    return expirationTs;
  }
  return new Date(timestamp * 1000).toISOString();
}

function marketToJson(market: ExponentMarket) {
  return {
    pubkey: market.pubkey.toBase58(),
    addressLookupTable: market.addressLookupTable.toBase58(),
    mintPt: market.mintPt.toBase58(),
    mintSy: market.mintSy.toBase58(),
    vault: market.vault.toBase58(),
    mintLp: market.mintLp.toBase58(),
    tokenLpEscrow: market.tokenLpEscrow.toBase58(),
    tokenPtEscrow: market.tokenPtEscrow.toBase58(),
    tokenSyEscrow: market.tokenSyEscrow.toBase58(),
    tokenFeeTreasurySy: market.tokenFeeTreasurySy.toBase58(),
    feeTreasurySyBps: market.feeTreasurySyBps,
    selfAddress: market.selfAddress.toBase58(),
    signerBump: market.signerBump,
    statusFlags: market.statusFlags,
    syProgram: market.syProgram.toBase58(),
    expirationTs: market.expirationTs,
    expiration: formatMarketDate(market.expirationTs),
    ptBalance: market.ptBalance,
    syBalance: market.syBalance,
    lnFeeRateRoot: market.lnFeeRateRoot,
    lastLnImpliedRate: market.lastLnImpliedRate,
    rateScalarRoot: market.rateScalarRoot,
  };
}

function isUnexpiredMarket(market: ExponentMarket, nowTs: bigint): boolean {
  try {
    return BigInt(market.expirationTs) > nowTs;
  } catch {
    return false;
  }
}

function printMarkets(markets: ExponentMarket[]) {
  printTable(
    [
      "Market",
      "Vault",
      "PT mint",
      "SY mint",
      "SY program",
      "PT balance",
      "SY balance",
      "Expiration",
      "Flags",
    ],
    markets.map((market) => [
      market.pubkey.toBase58(),
      market.vault.toBase58(),
      market.mintPt.toBase58(),
      market.mintSy.toBase58(),
      market.syProgram.toBase58(),
      market.ptBalance,
      market.syBalance,
      formatMarketDate(market.expirationTs),
      market.statusFlags.toString(),
    ]),
  );
}

function loadJson(raw: string, label: string): unknown {
  const jsonText = raw.startsWith("@")
    ? fs.readFileSync(raw.slice(1), "utf8")
    : raw;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    fail(`${label} must be valid JSON: ${(error as Error).message}`);
  }
}

/**
 * The accounts --remaining-accounts gives, read once, before the
 * confirmation: the transaction is built from what this returned. An empty
 * value, as an unset shell variable gives, is refused like other text that
 * is no JSON.
 */
function parseRemainingAccounts(raw: string): AccountMeta[] {
  const parsed = loadJson(raw, "remaining-accounts");
  if (!Array.isArray(parsed)) {
    fail("remaining-accounts must be a JSON array");
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
      fail(`remaining-accounts[${index}] must be a pubkey string or object`);
    }

    const meta = entry as {
      pubkey?: string;
      publicKey?: string;
      isSigner?: boolean;
      isWritable?: boolean;
    };
    const pubkey = meta.pubkey ?? meta.publicKey;
    if (!pubkey) {
      fail(`remaining-accounts[${index}] is missing pubkey`);
    }
    // A string such as "false" is truthy and would mark the account. A flag
    // left out, or given as null, is false.
    for (const flag of ["isSigner", "isWritable"] as const) {
      const given: unknown = meta[flag];
      if (given !== undefined && given !== null && typeof given !== "boolean") {
        fail(`remaining-accounts[${index}].${flag} must be true or false`);
      }
    }

    return {
      pubkey: validatePublicKey(pubkey),
      isSigner: meta.isSigner ?? false,
      isWritable: meta.isWritable ?? false,
    };
  });
}

/**
 * A split index divides the remaining accounts between the wrapper's two
 * CPIs, and the program refuses one past the accounts it is given.
 */
function requireSplitWithinRemainingAccounts(
  flag: string,
  splitIndex: number,
  remainingAccounts: AccountMeta[] | undefined,
) {
  const given = remainingAccounts?.length ?? 0;
  if (splitIndex > given) {
    fail(
      remainingAccounts === undefined
        ? `${flag} ${splitIndex} applies only with --remaining-accounts: without it the wrapper is given no accounts to split`
        : `${flag} ${splitIndex} is past the ${given} accounts --remaining-accounts gives`,
    );
  }
}

function txOptionsWithLookupTables(
  context: CliContext,
  options: TxLookupTableOptions,
): TxOptions {
  return options.txLookupTable?.length
    ? { ...context.txOptions, lookupTables: options.txLookupTable }
    : context.txOptions;
}

function cpiAccountMetasFromContexts(
  lookupTable: AddressLookupTableAccount,
  cpiAccounts: CpiInterfaceContext[],
  label: string,
): AccountMeta[] {
  return cpiAccounts.map((account, index) => {
    const pubkey = lookupTable.state.addresses[account.altIndex];
    if (!pubkey) {
      fail(
        `Exponent CPI account ${label}[${index}] references missing ALT index ${account.altIndex}`,
      );
    }

    return {
      pubkey,
      // Exponent stores signer metadata for the downstream SY CPI. These
      // accounts are passed through our wrapper to Exponent Core; they must not
      // become transaction-level signers.
      isSigner: false,
      isWritable: account.isWritable,
    };
  });
}

function pubkeyForCpiContext(
  lookupTable: AddressLookupTableAccount,
  account: CpiInterfaceContext,
  label: string,
): PublicKey {
  const pubkey = lookupTable.state.addresses[account.altIndex];
  if (!pubkey) {
    fail(
      `Exponent CPI account ${label} references missing ALT index ${account.altIndex}`,
    );
  }
  return pubkey;
}

async function fetchExponentLookupTable(
  context: CliContext,
  pubkey: PublicKey,
  label: string,
): Promise<AddressLookupTableAccount> {
  const lookupTableAccountInfo =
    await context.glamClient.connection.getAccountInfo(pubkey);
  if (!lookupTableAccountInfo) {
    fail(`Exponent ${label} address lookup table not found: ${pubkey}`);
  }

  return new AddressLookupTableAccount({
    key: pubkey,
    state: AddressLookupTableAccount.deserialize(lookupTableAccountInfo.data),
  });
}

async function fetchMarketLookupTable(
  context: CliContext,
  market: ExponentMarket,
): Promise<AddressLookupTableAccount> {
  return fetchExponentLookupTable(context, market.addressLookupTable, "market");
}

async function fetchVaultLookupTable(
  context: CliContext,
  vault: ExponentVault,
): Promise<AddressLookupTableAccount> {
  return fetchExponentLookupTable(context, vault.addressLookupTable, "vault");
}

async function genericStandardMintSyAccountMetasForMarket(
  context: CliContext,
  market: ExponentMarket,
  lookupTable: AddressLookupTableAccount,
  cpiAccounts: ParsedCpiAccounts,
  tokenSyTrader: PublicKey,
  tokenProgram: PublicKey,
): Promise<DerivedWrapperRemainingAccounts> {
  // Automatic remaining-account synthesis is specific to the Generic Standard.
  // Non-generic standards still use market.syProgram for the wrapper CPI, but
  // their SY CPI accounts must be supplied by the caller.
  if (!market.syProgram.equals(EXPONENT_GENERIC_STANDARD_PROGRAM_ID)) {
    fail(
      `Automatic mint SY account derivation is only available for the Exponent Generic Standard (${EXPONENT_GENERIC_STANDARD_PROGRAM_ID}); market uses ${market.syProgram}. Pass --remaining-accounts and --mint-sy-rem-accounts-until explicitly.`,
    );
  }
  if (cpiAccounts.getSyState.length === 0) {
    fail("Exponent market is missing get_sy_state CPI account metadata");
  }

  const syState = pubkeyForCpiContext(
    lookupTable,
    cpiAccounts.getSyState[0],
    "getSyState[0]",
  );
  const syStateInfo =
    await context.glamClient.connection.getAccountInfo(syState);
  if (!syStateInfo || !syStateInfo.owner.equals(market.syProgram)) {
    fail(`Invalid Exponent generic SY state account: ${syState}`);
  }

  const syStateAccount = parseGenericSyState(syState, syStateInfo.data);
  const { yieldBearingMint, oracle } = syStateAccount;
  const vaultYieldBearingToken = context.glamClient.getVaultAta(
    yieldBearingMint,
    tokenProgram,
  );
  const syStateYieldBearingToken = getAssociatedTokenAddressSync(
    yieldBearingMint,
    syState,
    true,
    tokenProgram,
  );

  return {
    remainingAccounts: [
      {
        pubkey: context.glamClient.vaultPda,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: syState, isSigner: false, isWritable: true },
      { pubkey: market.mintSy, isSigner: false, isWritable: true },
      { pubkey: yieldBearingMint, isSigner: false, isWritable: false },
      { pubkey: vaultYieldBearingToken, isSigner: false, isWritable: true },
      { pubkey: syStateYieldBearingToken, isSigner: false, isWritable: true },
      { pubkey: tokenSyTrader, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: false },
    ],
    splitIndex: 10,
    preInstructions: [
      createAssociatedTokenAccountIdempotentInstruction(
        context.glamClient.signer,
        vaultYieldBearingToken,
        context.glamClient.vaultPda,
        yieldBearingMint,
        tokenProgram,
      ),
    ],
  };
}

async function genericStandardRedeemSyAccountMetasForMarket(
  context: CliContext,
  market: ExponentMarket,
  lookupTable: AddressLookupTableAccount,
  cpiAccounts: ParsedCpiAccounts,
  tokenSyTrader: PublicKey,
  tokenProgram: PublicKey,
): Promise<DerivedWrapperRemainingAccounts> {
  return genericStandardRedeemSyAccountMetas(
    context,
    market.syProgram,
    market.mintSy,
    lookupTable,
    cpiAccounts.getSyState,
    tokenSyTrader,
    tokenProgram,
    "Exponent market",
    "Pass --remaining-accounts and --redeem-sy-rem-accounts-until explicitly.",
  );
}

async function genericStandardRedeemSyAccountMetas(
  context: CliContext,
  syProgram: PublicKey,
  mintSy: PublicKey,
  lookupTable: AddressLookupTableAccount,
  getSyStateCpiAccounts: CpiInterfaceContext[],
  tokenSyTrader: PublicKey,
  tokenProgram: PublicKey,
  label: string,
  manualAccountsHint: string,
): Promise<DerivedWrapperRemainingAccounts> {
  if (!syProgram.equals(EXPONENT_GENERIC_STANDARD_PROGRAM_ID)) {
    fail(
      `Automatic redeem SY account derivation is only available for the Exponent Generic Standard (${EXPONENT_GENERIC_STANDARD_PROGRAM_ID}); ${label} uses ${syProgram}. ${manualAccountsHint}`,
    );
  }
  if (getSyStateCpiAccounts.length === 0) {
    fail(`${label} is missing get_sy_state CPI account metadata`);
  }

  const syState = pubkeyForCpiContext(
    lookupTable,
    getSyStateCpiAccounts[0],
    "getSyState[0]",
  );
  const syStateInfo =
    await context.glamClient.connection.getAccountInfo(syState);
  if (!syStateInfo || !syStateInfo.owner.equals(syProgram)) {
    fail(`Invalid Exponent generic SY state account: ${syState}`);
  }

  const syStateAccount = parseGenericSyState(syState, syStateInfo.data);
  const { yieldBearingMint, oracle } = syStateAccount;
  const vaultYieldBearingToken = context.glamClient.getVaultAta(
    yieldBearingMint,
    tokenProgram,
  );
  const syStateYieldBearingToken = getAssociatedTokenAddressSync(
    yieldBearingMint,
    syState,
    true,
    tokenProgram,
  );

  return {
    remainingAccounts: [
      {
        pubkey: context.glamClient.vaultPda,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: syState, isSigner: false, isWritable: true },
      { pubkey: vaultYieldBearingToken, isSigner: false, isWritable: true },
      { pubkey: syStateYieldBearingToken, isSigner: false, isWritable: true },
      { pubkey: tokenSyTrader, isSigner: false, isWritable: true },
      { pubkey: mintSy, isSigner: false, isWritable: true },
      { pubkey: yieldBearingMint, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: false },
    ],
    splitIndex: 10,
    preInstructions: [
      createAssociatedTokenAccountIdempotentInstruction(
        context.glamClient.signer,
        vaultYieldBearingToken,
        context.glamClient.vaultPda,
        yieldBearingMint,
        tokenProgram,
      ),
    ],
  };
}

async function wrapperCpiAccountMetasForMarket(
  context: CliContext,
  market: ExponentMarket,
  kind: "depositSy" | "withdrawSy",
  tokenSyTrader: PublicKey,
  tokenProgram: PublicKey,
): Promise<DerivedWrapperRemainingAccounts> {
  const lookupTable = await fetchMarketLookupTable(context, market);
  const cpiAccounts = market.cpiAccounts;
  if (!cpiAccounts) {
    fail("Exponent market is missing CPI account metadata");
  }
  const syAccountsResult =
    kind === "depositSy"
      ? await genericStandardMintSyAccountMetasForMarket(
          context,
          market,
          lookupTable,
          cpiAccounts,
          tokenSyTrader,
          tokenProgram,
        )
      : await genericStandardRedeemSyAccountMetasForMarket(
          context,
          market,
          lookupTable,
          cpiAccounts,
          tokenSyTrader,
          tokenProgram,
        );
  const syAccounts = syAccountsResult.remainingAccounts;
  const splitIndex = syAccounts.length;
  const getSyStateAccounts = cpiAccountMetasFromContexts(
    lookupTable,
    cpiAccounts.getSyState,
    "getSyState",
  );
  const transferSyAccounts = cpiAccountMetasFromContexts(
    lookupTable,
    cpiAccounts[kind],
    kind,
  );

  return {
    remainingAccounts: [
      ...syAccounts,
      ...getSyStateAccounts,
      ...transferSyAccounts,
    ],
    splitIndex,
    preInstructions: syAccountsResult.preInstructions,
  };
}

/**
 * The accounts and options of a trade. `remainingAccounts` are the ones
 * --remaining-accounts gave, already read; without them they are derived.
 */
async function marketCallArgs(
  context: CliContext,
  options: ExponentMarketAccountsOptions,
  cpiAccountsKind: "depositSy" | "withdrawSy",
  remainingAccounts: AccountMeta[] | undefined,
) {
  const { market } = await fetchMarket(context, options.market);
  const tokenProgram = options.tokenProgram ?? TOKEN_PROGRAM_ID;
  const tokenSyTrader =
    options.tokenSyTrader ??
    context.glamClient.getVaultAta(market.mintSy, tokenProgram);
  const tokenPtTrader =
    options.tokenPtTrader ??
    context.glamClient.getVaultAta(market.mintPt, tokenProgram);
  const preInstructions = [...(context.txOptions.preInstructions ?? [])];

  if (!options.tokenSyTrader) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        context.glamClient.signer,
        tokenSyTrader,
        context.glamClient.vaultPda,
        market.mintSy,
        tokenProgram,
      ),
    );
  }

  if (!options.tokenPtTrader) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        context.glamClient.signer,
        tokenPtTrader,
        context.glamClient.vaultPda,
        market.mintPt,
        tokenProgram,
      ),
    );
  }

  const derivedRemainingAccounts =
    remainingAccounts === undefined
      ? await wrapperCpiAccountMetasForMarket(
          context,
          market,
          cpiAccountsKind,
          tokenSyTrader,
          tokenProgram,
        )
      : null;
  preInstructions.push(...(derivedRemainingAccounts?.preInstructions ?? []));

  return {
    accounts: {
      market: options.market,
      tokenSyTrader,
      tokenPtTrader,
      tokenSyEscrow: options.tokenSyEscrow ?? market.tokenSyEscrow,
      tokenPtEscrow: options.tokenPtEscrow ?? market.tokenPtEscrow,
      addressLookupTable:
        options.addressLookupTable ?? market.addressLookupTable,
      syProgram: options.syProgram ?? market.syProgram,
      tokenFeeTreasurySy:
        options.tokenFeeTreasurySy ?? market.tokenFeeTreasurySy,
      eventAuthority: options.eventAuthority,
      tokenProgram,
      remainingAccounts:
        derivedRemainingAccounts?.remainingAccounts ?? remainingAccounts!,
    },
    splitIndex: derivedRemainingAccounts?.splitIndex,
    txOptions: {
      ...txOptionsWithLookupTables(context, options),
      preInstructions,
    },
  };
}

async function redeemPtCallArgs(
  context: CliContext,
  options: TxLookupTableOptions & {
    market: PublicKey;
    eventAuthority?: PublicKey;
    tokenProgram?: PublicKey;
  },
) {
  const { market } = await fetchMarket(context, options.market);
  const { vault } = await fetchVault(context, market.vault);

  if (!vault.mintPt.equals(market.mintPt)) {
    fail(
      `Market PT mint ${market.mintPt} does not match vault PT mint ${vault.mintPt}`,
    );
  }
  if (!vault.mintSy.equals(market.mintSy)) {
    fail(
      `Market SY mint ${market.mintSy} does not match vault SY mint ${vault.mintSy}`,
    );
  }
  if (!vault.syProgram.equals(market.syProgram)) {
    fail(
      `Market SY program ${market.syProgram} does not match vault SY program ${vault.syProgram}`,
    );
  }

  const expiryTs = BigInt(vault.startTs) + BigInt(vault.duration);
  const nowTs = BigInt(Math.floor(Date.now() / 1000));
  if (nowTs <= expiryTs) {
    fail(
      `Exponent vault ${vault.pubkey} is not expired yet; expires at ${new Date(
        Number(expiryTs) * 1000,
      ).toISOString()}`,
    );
  }

  const tokenProgram = options.tokenProgram ?? TOKEN_PROGRAM_ID;
  const tokenSyMerger = context.glamClient.getVaultAta(
    vault.mintSy,
    tokenProgram,
  );
  const tokenYtMerger = context.glamClient.getVaultAta(
    vault.mintYt,
    tokenProgram,
  );
  const tokenPtMerger = context.glamClient.getVaultAta(
    vault.mintPt,
    tokenProgram,
  );
  const lookupTable = await fetchVaultLookupTable(context, vault);
  const cpiAccounts = vault.cpiAccounts;
  if (!cpiAccounts) {
    fail("Exponent vault is missing CPI account metadata");
  }
  const redeemSyAccounts = await genericStandardRedeemSyAccountMetas(
    context,
    vault.syProgram,
    vault.mintSy,
    lookupTable,
    cpiAccounts.getSyState,
    tokenSyMerger,
    tokenProgram,
    "Exponent vault",
    "Use the low-level merge command and pass --remaining-accounts with --redeem-sy-accounts-until explicitly.",
  );
  const getSyStateAccounts = cpiAccountMetasFromContexts(
    lookupTable,
    cpiAccounts.getSyState,
    "vault getSyState",
  );
  const withdrawSyAccounts = cpiAccountMetasFromContexts(
    lookupTable,
    cpiAccounts.withdrawSy,
    "vault withdrawSy",
  );
  const preInstructions = [
    ...(context.txOptions.preInstructions ?? []),
    createAssociatedTokenAccountIdempotentInstruction(
      context.glamClient.signer,
      tokenSyMerger,
      context.glamClient.vaultPda,
      vault.mintSy,
      tokenProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      context.glamClient.signer,
      tokenYtMerger,
      context.glamClient.vaultPda,
      vault.mintYt,
      tokenProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      context.glamClient.signer,
      tokenPtMerger,
      context.glamClient.vaultPda,
      vault.mintPt,
      tokenProgram,
    ),
    ...(redeemSyAccounts.preInstructions ?? []),
  ];
  const txOptions = txOptionsWithLookupTables(context, options);

  return {
    accounts: {
      tokenSyMerger,
      vault: vault.pubkey,
      escrowSy: vault.escrowSy,
      tokenYtMerger,
      tokenPtMerger,
      mintYt: vault.mintYt,
      mintPt: vault.mintPt,
      authority: vault.authority,
      vaultAddressLookupTable: vault.addressLookupTable,
      vaultRobotYieldPosition: vault.yieldPosition,
      syProgram: vault.syProgram,
      eventAuthority: options.eventAuthority,
      tokenProgram,
      remainingAccounts: [
        ...redeemSyAccounts.remainingAccounts,
        ...getSyStateAccounts,
        ...withdrawSyAccounts,
      ],
    },
    splitIndex: redeemSyAccounts.splitIndex,
    vault,
    txOptions: {
      ...txOptions,
      lookupTables: [
        ...(txOptions.lookupTables ?? []),
        lookupTable,
      ] as TxOptions["lookupTables"],
      preInstructions,
    },
  };
}

function addRemainingAndTxOptions(command: Command): Command {
  return command
    .option(
      "--remaining-accounts <json>",
      "JSON AccountMeta[] or @file passed after the fixed Exponent accounts",
    )
    .option(
      "--tx-lookup-table <pubkey>",
      "Transaction address lookup table; repeatable",
      collectPublicKeys,
    )
    .option("-y, --yes", "Skip confirmation prompt", false);
}

function addMarketAccountOptions(command: Command): Command {
  return addRemainingAndTxOptions(command)
    .requiredOption("--market <pubkey>", "Exponent market", validatePublicKey)
    .option(
      "--token-sy-trader <pubkey>",
      "Vault-owned SY trader token account; defaults to the vault ATA for the market SY mint",
      validatePublicKey,
    )
    .option(
      "--token-pt-trader <pubkey>",
      "Vault-owned PT trader token account; defaults to the vault ATA for the market PT mint",
      validatePublicKey,
    )
    .option(
      "--token-sy-escrow <pubkey>",
      "Exponent market SY escrow token account; defaults to the market value",
      validatePublicKey,
    )
    .option(
      "--token-pt-escrow <pubkey>",
      "Exponent market PT escrow token account; defaults to the market value",
      validatePublicKey,
    )
    .option(
      "--address-lookup-table <pubkey>",
      "Exponent market address lookup table account; defaults to the market value",
      validatePublicKey,
    )
    .option(
      "--sy-program <pubkey>",
      "SY program account; defaults to the market value",
      validatePublicKey,
    )
    .option(
      "--token-fee-treasury-sy <pubkey>",
      "Exponent SY fee treasury token account; defaults to the market value",
      validatePublicKey,
    )
    .option(
      "--event-authority <pubkey>",
      "Exponent event authority override",
      validatePublicKey,
    )
    .option(
      "--token-program <pubkey>",
      "Token program override",
      validatePublicKey,
      TOKEN_PROGRAM_ID,
    );
}

function addMergeAccountOptions(command: Command): Command {
  return addRemainingAndTxOptions(command)
    .requiredOption(
      "--token-sy-merger <pubkey>",
      "Vault-owned SY merger token account",
      validatePublicKey,
    )
    .requiredOption("--vault <pubkey>", "Exponent vault", validatePublicKey)
    .requiredOption(
      "--escrow-sy <pubkey>",
      "Exponent vault SY escrow token account",
      validatePublicKey,
    )
    .requiredOption(
      "--token-yt-merger <pubkey>",
      "Vault-owned YT merger token account",
      validatePublicKey,
    )
    .requiredOption(
      "--token-pt-merger <pubkey>",
      "Vault-owned PT merger token account",
      validatePublicKey,
    )
    .requiredOption("--mint-yt <pubkey>", "YT mint", validatePublicKey)
    .requiredOption("--mint-pt <pubkey>", "PT mint", validatePublicKey)
    .requiredOption(
      "--authority <pubkey>",
      "Exponent vault authority",
      validatePublicKey,
    )
    .requiredOption(
      "--vault-address-lookup-table <pubkey>",
      "Exponent vault address lookup table account",
      validatePublicKey,
    )
    .requiredOption(
      "--vault-robot-yield-position <pubkey>",
      "Exponent vault robot yield position account",
      validatePublicKey,
    )
    .requiredOption(
      "--sy-program <pubkey>",
      "SY program account",
      validatePublicKey,
    )
    .option(
      "--event-authority <pubkey>",
      "Exponent event authority override",
      validatePublicKey,
    )
    .option(
      "--token-program <pubkey>",
      "Token program override",
      validatePublicKey,
      TOKEN_PROGRAM_ID,
    );
}

function mergeAccounts(
  options: ExponentMergeAccountsOptions,
  remainingAccounts: AccountMeta[],
) {
  return {
    tokenSyMerger: options.tokenSyMerger,
    vault: options.vault,
    escrowSy: options.escrowSy,
    tokenYtMerger: options.tokenYtMerger,
    tokenPtMerger: options.tokenPtMerger,
    mintYt: options.mintYt,
    mintPt: options.mintPt,
    authority: options.authority,
    vaultAddressLookupTable: options.vaultAddressLookupTable,
    vaultRobotYieldPosition: options.vaultRobotYieldPosition,
    syProgram: options.syProgram,
    eventAuthority: options.eventAuthority,
    tokenProgram: options.tokenProgram,
    remainingAccounts,
  };
}

export function installExponentCommands(
  exponent: Command,
  context: CliContext,
) {
  exponent
    .command("list-markets")
    .alias("markets")
    .option("--vault <pubkey>", "Filter by Exponent vault", validatePublicKey)
    .option("--pt-mint <pubkey>", "Filter by PT mint", validatePublicKey)
    .option("--sy-mint <pubkey>", "Filter by SY mint", validatePublicKey)
    .option("--sy-program <pubkey>", "Filter by SY program", validatePublicKey)
    .option("--all", "Show expired markets too", false)
    .option("--json", "Print full market data as JSON", false)
    .description("List Exponent Core markets")
    .action(
      async (options: {
        vault?: PublicKey;
        ptMint?: PublicKey;
        syMint?: PublicKey;
        syProgram?: PublicKey;
        all?: boolean;
        json?: boolean;
      }) => {
        const filters = [
          {
            memcmp: {
              offset: 0,
              bytes: bs58.encode(EXPONENT_MARKET_TWO_DISCRIMINATOR),
            },
          },
        ];

        const maybeAddFilter = (
          offset: number,
          pubkey: PublicKey | undefined,
        ) => {
          if (pubkey) {
            filters.push({
              memcmp: {
                offset,
                bytes: pubkey.toBase58(),
              },
            });
          }
        };

        maybeAddFilter(ExponentMarketTwo.offsetOf("vault"), options.vault);
        maybeAddFilter(ExponentMarketTwo.offsetOf("mintPt"), options.ptMint);
        maybeAddFilter(ExponentMarketTwo.offsetOf("mintSy"), options.syMint);
        maybeAddFilter(
          ExponentMarketTwo.offsetOf("syProgram"),
          options.syProgram,
        );

        const accounts = await context.glamClient.connection.getProgramAccounts(
          EXPONENT_CORE_PROGRAM_ID,
          {
            filters,
            dataSlice: { offset: 0, length: ExponentMarketTwo.fixedDataLength },
          },
        );
        const nowTs = BigInt(Math.floor(Date.now() / 1000));
        const markets = accounts
          .map(({ pubkey, account }) => parseMarket(pubkey, account.data))
          .filter((market) => options.all || isUnexpiredMarket(market, nowTs))
          .sort((a, b) =>
            a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()),
          );

        if (options.json) {
          console.log(JSON.stringify(markets.map(marketToJson), null, 2));
          return;
        }

        if (markets.length === 0) {
          console.log("No Exponent Core markets found");
          return;
        }

        printMarkets(markets);
      },
    );

  exponent
    .command("view-policy")
    .description("View Exponent Core policy")
    .action(async () => {
      const policy = await fetchPolicy(context);
      if (!policy) {
        console.log("No Exponent Core policy found");
        return;
      }
      printPolicy(policy);
    });

  exponent
    .command("set-policy")
    .option(
      "--market <pubkey>",
      "Exponent market allowlist entry; repeatable",
      collectPublicKeys,
    )
    .option(
      "--vault <pubkey>",
      "Exponent vault allowlist entry; repeatable",
      collectPublicKeys,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Replace the full Exponent Core policy")
    .action(
      async (
        options: CliTxOptions & {
          market?: PublicKey[];
          vault?: PublicKey[];
        },
      ) => {
        const policy = new ExponentPolicy(
          uniquePubkeys(options.market ?? []),
          uniquePubkeys(options.vault ?? []),
        );
        // The whole policy is written: an entry left out of the options is
        // removed, and an empty pair refuses every Exponent operation.
        const timelock = await readVaultTimelock(context);
        const replaced = (await exponentPolicyToEdit(context, timelock)).value;
        const listLine = (
          label: string,
          next: PublicKey[],
          previous: PublicKey[],
        ) => {
          const removed = previous.filter(
            (key) => !next.some((kept) => kept.equals(key)),
          );
          const kept = next.length > 0 ? next.join(", ") : "none";
          return `  ${label}: ${kept}${removed.length > 0 ? ` (removes ${removed.join(", ")})` : ""}`;
        };
        await setPolicy(
          context,
          policy,
          options,
          [
            "Replace the Exponent Core policy?",
            listLine(
              "markets",
              policy.marketsAllowlist,
              replaced?.marketsAllowlist ?? [],
            ),
            listLine(
              "vaults",
              policy.vaultsAllowlist,
              replaced?.vaultsAllowlist ?? [],
            ),
            ...(policy.marketsAllowlist.length === 0 &&
            policy.vaultsAllowlist.length === 0
              ? [
                  "With no market and no vault on it, the policy refuses every Exponent buy, sell, merge and redemption.",
                ]
              : []),
          ].join("\n"),
          `Exponent Core policy set`,
          timelock,
        );
      },
    );

  exponent
    .command("reset-policy")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Reset Exponent Core policy to default deny-all")
    .action(async (options: CliTxOptions) => {
      await setPolicy(
        context,
        defaultPolicy(),
        options,
        "Reset Exponent Core policy to default?",
        `Exponent Core policy reset`,
      );
    });

  exponent
    .command("allowlist-market")
    .argument("<pubkey>", "Exponent market", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add an Exponent market to the policy allowlist")
    .action(async (pubkey: PublicKey, options: CliTxOptions) => {
      await updatePolicy(
        context,
        (policy) => addUniqueEntry(policy.marketsAllowlist, pubkey, "Market"),
        options,
        `Add Exponent market ${pubkey} to allowlist?`,
        `Exponent market added to allowlist`,
      );
    });

  exponent
    .command("remove-market")
    .argument("<pubkey>", "Exponent market", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove an Exponent market from the policy allowlist")
    .action(async (pubkey: PublicKey, options: CliTxOptions) => {
      await updatePolicy(
        context,
        (policy) => {
          policy.marketsAllowlist = removeEntry(
            policy.marketsAllowlist,
            pubkey,
            "Market",
          );
        },
        options,
        `Remove Exponent market ${pubkey} from allowlist?`,
        `Exponent market removed from allowlist`,
      );
    });

  exponent
    .command("allowlist-vault")
    .argument("<pubkey>", "Exponent vault", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add an Exponent vault to the policy allowlist")
    .action(async (pubkey: PublicKey, options: CliTxOptions) => {
      await updatePolicy(
        context,
        (policy) => addUniqueEntry(policy.vaultsAllowlist, pubkey, "Vault"),
        options,
        `Add Exponent vault ${pubkey} to allowlist?`,
        `Exponent vault added to allowlist`,
      );
    });

  exponent
    .command("remove-vault")
    .argument("<pubkey>", "Exponent vault", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove an Exponent vault from the policy allowlist")
    .action(async (pubkey: PublicKey, options: CliTxOptions) => {
      await updatePolicy(
        context,
        (policy) => {
          policy.vaultsAllowlist = removeEntry(
            policy.vaultsAllowlist,
            pubkey,
            "Vault",
          );
        },
        options,
        `Remove Exponent vault ${pubkey} from allowlist?`,
        `Exponent vault removed from allowlist`,
      );
    });

  addMarketAccountOptions(
    exponent
      .command("buy-pt")
      .argument("<pt-amount-raw>", "Raw PT amount in base units")
      .argument(
        "<max-base-amount-raw>",
        "Raw base amount in base units. All of it is converted to SY before the trade, which spends at most that SY",
      )
      .option(
        "--mint-sy-rem-accounts-until <index>",
        "remaining_accounts split index between mint SY and trade PT CPIs",
        (value: string) => parseU8(value, "mint-sy-rem-accounts-until"),
        0,
      ),
  )
    .description("Buy Exponent PT through the GLAM wrapper")
    .action(
      async (
        ptAmountRaw: string,
        maxBaseAmountRaw: string,
        options: ExponentMarketAccountsOptions &
          CliTxOptions & { mintSyRemAccountsUntil: number },
        command: Command,
      ) => {
        // Without --remaining-accounts the accounts are derived, and their
        // split with them: an index given alone would change nothing.
        if (
          options.remainingAccounts === undefined &&
          command.getOptionValueSource("mintSyRemAccountsUntil") === "cli"
        ) {
          fail(
            "--mint-sy-rem-accounts-until applies only with --remaining-accounts",
          );
        }
        // The accounts are read once, here, and the transaction is built
        // from them: a file read again after the confirmation could hold
        // others. A split given with them is held to their count.
        const remainingAccounts =
          options.remainingAccounts === undefined
            ? undefined
            : parseRemainingAccounts(options.remainingAccounts);
        if (remainingAccounts !== undefined) {
          requireSplitWithinRemainingAccounts(
            "--mint-sy-rem-accounts-until",
            options.mintSyRemAccountsUntil,
            remainingAccounts,
          );
        }
        // Both amounts are read before the confirmation, which shows them.
        const ptAmount = parseTradePtAmount(ptAmountRaw);
        const maxBaseAmount = parseU64(maxBaseAmountRaw, "max-base-amount-raw");
        await executeTxWithErrorHandling(
          async () => {
            const { accounts, splitIndex, txOptions } = await marketCallArgs(
              context,
              options,
              "depositSy",
              remainingAccounts,
            );
            return context.glamClient.exponent.wrapperBuyPt(
              {
                ptAmount,
                maxBaseAmount,
                mintSyRemAccountsUntil:
                  remainingAccounts === undefined
                    ? splitIndex!
                    : options.mintSyRemAccountsUntil,
              },
              accounts,
              txOptions,
            );
          },
          {
            skip: !!options.yes,
            // The wrapper mints SY from the whole base amount, then trades: the
            // amount caps what the PT costs, and none of it stays as base.
            message: `Buy ${ptAmount.toString()} raw PT from Exponent market ${options.market}, converting all of ${maxBaseAmount.toString()} raw base into SY first? The trade spends at most that SY, and the SY it does not spend stays in the vault's SY token account.`,
          },
          (txSig) => `Bought Exponent PT: ${txSig}`,
        );
      },
    );

  addMarketAccountOptions(
    exponent
      .command("sell-pt")
      .argument("<pt-amount-raw>", "Raw PT amount in base units")
      .argument("<min-base-amount-raw>", "Raw min base amount in base units")
      .option(
        "--redeem-sy-rem-accounts-until <index>",
        "remaining_accounts split index between trade PT and redeem SY CPIs",
        (value: string) => parseU8(value, "redeem-sy-rem-accounts-until"),
        0,
      ),
  )
    .description("Sell Exponent PT through the GLAM wrapper")
    .action(
      async (
        ptAmountRaw: string,
        minBaseAmountRaw: string,
        options: ExponentMarketAccountsOptions &
          CliTxOptions & { redeemSyRemAccountsUntil: number },
        command: Command,
      ) => {
        // As in buy-pt: the split is derived with the accounts.
        if (
          options.remainingAccounts === undefined &&
          command.getOptionValueSource("redeemSyRemAccountsUntil") === "cli"
        ) {
          fail(
            "--redeem-sy-rem-accounts-until applies only with --remaining-accounts",
          );
        }
        const remainingAccounts =
          options.remainingAccounts === undefined
            ? undefined
            : parseRemainingAccounts(options.remainingAccounts);
        if (remainingAccounts !== undefined) {
          requireSplitWithinRemainingAccounts(
            "--redeem-sy-rem-accounts-until",
            options.redeemSyRemAccountsUntil,
            remainingAccounts,
          );
        }
        // Both amounts are read before the confirmation, which shows them.
        const amountPt = parseTradePtAmount(ptAmountRaw);
        const minBaseAmount = parseU64(
          minBaseAmountRaw,
          "min-base-amount-raw",
          true,
        );
        await executeTxWithErrorHandling(
          async () => {
            const { accounts, splitIndex, txOptions } = await marketCallArgs(
              context,
              options,
              "withdrawSy",
              remainingAccounts,
            );
            return context.glamClient.exponent.wrapperSellPt(
              {
                amountPt,
                minBaseAmount,
                redeemSyRemAccountsUntil:
                  remainingAccounts === undefined
                    ? splitIndex!
                    : options.redeemSyRemAccountsUntil,
              },
              accounts,
              txOptions,
            );
          },
          {
            skip: !!options.yes,
            message: `Sell ${amountPt.toString()} raw PT into Exponent market ${options.market} for at least ${minBaseAmount.toString()} raw base?`,
          },
          (txSig) => `Sold Exponent PT: ${txSig}`,
        );
      },
    );

  exponent
    .command("redeem-pt")
    .argument("<pt-amount-raw>", "Raw expired PT amount in base units")
    .requiredOption("--market <pubkey>", "Exponent market", validatePublicKey)
    .option(
      "--event-authority <pubkey>",
      "Exponent event authority override",
      validatePublicKey,
    )
    .option(
      "--token-program <pubkey>",
      "Token program override",
      validatePublicKey,
      TOKEN_PROGRAM_ID,
    )
    .option(
      "--tx-lookup-table <pubkey>",
      "Transaction address lookup table; repeatable",
      collectPublicKeys,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Redeem expired Exponent PT through the GLAM wrapper")
    .action(
      async (
        ptAmountRaw: string,
        options: TxLookupTableOptions &
          CliTxOptions & {
            market: PublicKey;
            eventAuthority?: PublicKey;
            tokenProgram: PublicKey;
          },
      ) => {
        // The amount is read before the confirmation, which shows it.
        const amountPy = parseU64(ptAmountRaw, "pt-amount-raw");
        await executeTxWithErrorHandling(
          async () => {
            const { accounts, splitIndex, txOptions } = await redeemPtCallArgs(
              context,
              options,
            );
            return context.glamClient.exponent.wrapperMerge(
              {
                amountPy,
                redeemSyAccountsUntil: splitIndex,
              },
              accounts,
              txOptions,
            );
          },
          {
            skip: !!options.yes,
            message: `Redeem ${amountPy.toString()} raw expired PT from Exponent market ${options.market}?`,
          },
          (txSig) => `Redeemed expired Exponent PT: ${txSig}`,
        );
      },
    );

  addMergeAccountOptions(
    exponent
      .command("merge")
      .argument("<py-amount-raw>", "Raw PY amount in base units")
      .option(
        "--redeem-sy-accounts-until <index>",
        "remaining_accounts split index between redeem SY and merge CPIs",
        (value: string) => parseU8(value, "redeem-sy-accounts-until"),
        0,
      ),
  )
    .description("Merge Exponent PT/YT through the GLAM wrapper")
    .action(
      async (
        pyAmountRaw: string,
        options: ExponentMergeAccountsOptions &
          CliTxOptions & { redeemSyAccountsUntil: number },
      ) => {
        // Read once, as in buy-pt. Without --remaining-accounts the wrapper
        // is given none, and only a split of 0 fits.
        const remainingAccounts =
          options.remainingAccounts === undefined
            ? undefined
            : parseRemainingAccounts(options.remainingAccounts);
        requireSplitWithinRemainingAccounts(
          "--redeem-sy-accounts-until",
          options.redeemSyAccountsUntil,
          remainingAccounts,
        );
        // The amount is read before the confirmation, which shows it.
        const amountPy = parseU64(pyAmountRaw, "py-amount-raw");
        await executeTxWithErrorHandling(
          () =>
            context.glamClient.exponent.wrapperMerge(
              {
                amountPy,
                redeemSyAccountsUntil: options.redeemSyAccountsUntil,
              },
              mergeAccounts(options, remainingAccounts ?? []),
              txOptionsWithLookupTables(context, options),
            ),
          {
            skip: !!options.yes,
            message: `Merge ${amountPy.toString()} raw Exponent PT/YT in vault ${options.vault}?`,
          },
          (txSig) => `Merged Exponent PT/YT: ${txSig}`,
        );
      },
    );
}
