import { BN } from "@coral-xyz/anchor";
import {
  LoopscaleLoan,
  type LoopscaleLoanDuration,
  LoopscaleBorrowMarketPolicy,
  LoopscaleBorrowPolicy,
  LoopscaleLendingMarketPolicy,
  LoopscaleLendingPolicy,
  LoopscaleSellLedgerPolicy,
  LoopscaleStrategy,
  LOOPSCALE_BORROW_PROTOCOL,
  type LoopscaleMarketInformation,
  type LoopscaleMultiCollateralTermsUpdateParams,
  STRATEGY_DURATION_COUNT,
  U8_MAX,
  U32_MAX,
  U64_MAX_BN,
  PkSet,
  Tuple5,
} from "@glamsystems/glam-sdk";
import { PublicKey } from "@solana/web3.js";
import { type Command } from "commander";

import {
  type CliContext,
  executeTxWithErrorHandling,
  printTable,
  printPubkeyList,
  resolveTokenMint,
  resolveTokenPublicKey,
} from "../utils";
import {
  editsStagedLine,
  readVaultTimelock,
  type VaultTimelock,
} from "../staging";
import { fail } from "../errors";
import {
  parseBps,
  parseArrayInput,
  parseDurationIndexes,
  parseNonNegativeU64,
  parsePositiveUiAmount,
  parseU8,
  parseUnsignedNumber,
  requireSafeIntegerAmount,
  validatePublicKey,
} from "../parsing";

// Loopscale's duration types, by their number.
const LOOPSCALE_DURATION_UNITS = ["day", "week", "month", "minute", "year"];

function formatLoopscaleDuration(term: LoopscaleLoanDuration): string {
  const unit = LOOPSCALE_DURATION_UNITS[term.durationType];
  return unit === undefined
    ? `duration ${term.duration} of type ${term.durationType}`
    : `${term.duration} ${unit}${term.duration === 1 ? "" : "s"}`;
}

// The term of each Loopscale duration index, as the --durations help gives it.
const DURATION_TERMS = ["1 day", "1 week", "1 month", "3 months", "1 year"];

function durationsText(indexes: number[]): string {
  return indexes.length === 0
    ? "none, which denies every duration"
    : indexes
        .map(
          (index) => `${DURATION_TERMS[index] ?? `index ${index}`} (${index})`,
        )
        .join(", ");
}

/** A list a policy stores, and what the program makes of an empty one. */
export function keysText(keys: PublicKey[], emptyDenies: string): string {
  return keys.length === 0
    ? `none, which denies ${emptyDenies}`
    : keys.map((key) => key.toBase58()).join(", ");
}

function limitText(value: BN | number, unit: string, zeroDenies: string) {
  const zero = typeof value === "number" ? value === 0 : value.isZero();
  return `${value.toString()} ${unit}${zero ? `, which denies ${zeroDenies}` : ""}`;
}

type PolicyField = [label: string, value: string];

/** Each limit a lending market policy stores, as ext_loopscale reads it. */
export function lendingMarketFields(
  policy: LoopscaleLendingMarketPolicy,
): PolicyField[] {
  return [
    [
      "max deposit per instruction",
      limitText(
        policy.maxDepositAmount,
        "base units",
        "every deposit in this market",
      ),
    ],
    [
      "max exposure per strategy",
      limitText(
        policy.maxTotalDepositAmount,
        "base units",
        "all lending in this market",
      ),
    ],
    ["min loan APY", `${policy.minLoanApyCbps} cBPS`],
    [
      "max borrower LTV",
      limitText(policy.maxLtvBps, "bps", "every borrower LTV"),
    ],
    ["durations", durationsText(policy.durationIndexesAllowlist)],
    [
      "collateral assets",
      keysText(policy.collateralAssetAllowlist, "every collateral asset"),
    ],
  ];
}

/** Each limit a borrow market policy stores, as ext_loopscale reads it. */
export function borrowMarketFields(
  policy: LoopscaleBorrowMarketPolicy,
): PolicyField[] {
  return [
    [
      "max borrow per instruction",
      limitText(
        policy.maxBorrowAmount,
        "base units",
        "every borrow in this market",
      ),
    ],
    [
      "max outstanding principal per loan",
      limitText(
        policy.maxTotalBorrowAmount,
        "base units",
        "all borrowing in this market",
      ),
    ],
    [
      "max expected liquidation LTV",
      limitText(policy.maxLtvBps, "bps", "every expected liquidation LTV"),
    ],
    ["durations", durationsText(policy.durationIndexesAllowlist)],
  ];
}

/** The limits a market policy writes, each against the stored one an update replaces. */
export function marketFieldLines(
  next: PolicyField[],
  previous?: PolicyField[],
): string[] {
  return next.map(([label, value], index) => {
    const before = previous?.[index]?.[1];
    return before !== undefined && before !== value
      ? `  ${label}: ${before} -> ${value}`
      : `  ${label}: ${value}`;
  });
}

/**
 * The collateral terms a strategy command sends, one line each: the
 * market's asset at the collateral index, the term and the APY.
 */
export function collateralTermLines(
  marketInfo: LoopscaleMarketInformation,
  terms: LoopscaleMultiCollateralTermsUpdateParams[],
): string[] {
  return terms.flatMap(({ apy, indices }) =>
    indices.map(
      ({ collateralIndex, durationIndex }) =>
        `collateral term: ${marketInfo.assetData[collateralIndex]?.assetIdentifier ?? "unknown asset"} (index ${collateralIndex}) for ${DURATION_TERMS[durationIndex] ?? `duration ${durationIndex}`} at ${apy.toString()} cBPS`,
    ),
  );
}

// ext_loopscale governs a market with no market policy by the allowlists alone.
export const MARKET_LIMITS_CLEARED =
  "  per-market limits: none. Limits stored for any market are removed, and those markets fall back to the allowlists above.";

function formatPolicyDecodeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function fetchRawLoopscalePolicyData(
  context: CliContext,
  protocolBitflag: number,
): Promise<Buffer | null> {
  const stateAccount =
    await context.glamClient.loopscaleBorrow.base.fetchStateAccount();
  const integrationPolicy = stateAccount.integrationAcls?.find((acl) =>
    acl.integrationProgram.equals(context.glamClient.loopscaleBorrow.programId),
  );
  return (
    integrationPolicy?.protocolPolicies?.find(
      (policy: { protocolBitflag: number; data: Buffer }) =>
        policy.protocolBitflag === protocolBitflag,
    )?.data ?? null
  );
}

function readU32(buffer: Buffer, offset: number, label: string): number {
  if (offset + 4 > buffer.length) {
    throw new Error(`${label} length is truncated`);
  }
  return buffer.readUInt32LE(offset);
}

function requireBytes(
  buffer: Buffer,
  offset: number,
  bytes: number,
  label: string,
): void {
  if (bytes < 0 || offset + bytes > buffer.length) {
    throw new Error(`${label} exceeds policy data length`);
  }
}

function readPubkeyVec(
  buffer: Buffer,
  offset: number,
  label: string,
): { values: PublicKey[]; offset: number } {
  const length = readU32(buffer, offset, label);
  offset += 4;
  requireBytes(buffer, offset, length * 32, label);
  const values: PublicKey[] = [];
  for (let i = 0; i < length; i++) {
    values.push(new PublicKey(buffer.subarray(offset, offset + 32)));
    offset += 32;
  }
  return { values, offset };
}

function readU8Vec(
  buffer: Buffer,
  offset: number,
  label: string,
): { values: number[]; offset: number } {
  const length = readU32(buffer, offset, label);
  offset += 4;
  requireBytes(buffer, offset, length, label);
  const values = Array.from(buffer.subarray(offset, offset + length));
  return { values, offset: offset + length };
}

function decodeBorrowPolicyForView(buffer: Buffer): LoopscaleBorrowPolicy {
  let offset = 0;
  const collateral = readPubkeyVec(buffer, offset, "collateral allowlist");
  offset = collateral.offset;
  const principal = readPubkeyVec(buffer, offset, "principal allowlist");
  offset = principal.offset;
  const marketCount = readU32(buffer, offset, "borrow market policies");
  offset += 4;
  const marketPolicies: LoopscaleBorrowMarketPolicy[] = [];
  for (let i = 0; i < marketCount; i++) {
    requireBytes(buffer, offset, 54, `borrow market policy ${i}`);
    const market = new PublicKey(buffer.subarray(offset, offset + 32));
    offset += 32;
    const maxBorrowAmount = new BN(buffer.subarray(offset, offset + 8), "le");
    offset += 8;
    const maxTotalBorrowAmount = new BN(
      buffer.subarray(offset, offset + 8),
      "le",
    );
    offset += 8;
    const maxLtvBps = buffer.readUInt16LE(offset);
    offset += 2;
    const durations = readU8Vec(
      buffer,
      offset,
      `borrow market policy ${i} durations`,
    );
    offset = durations.offset;
    marketPolicies.push(
      new LoopscaleBorrowMarketPolicy(
        market,
        maxBorrowAmount,
        maxTotalBorrowAmount,
        maxLtvBps,
        durations.values,
      ),
    );
  }
  if (offset !== buffer.length) {
    throw new Error("borrow policy has trailing bytes");
  }
  return new LoopscaleBorrowPolicy(
    collateral.values,
    principal.values,
    marketPolicies,
  );
}

export function decodeLendingPolicyForView(
  buffer: Buffer,
): LoopscaleLendingPolicy {
  let offset = 0;
  const principal = readPubkeyVec(
    buffer,
    offset,
    "lending principal allowlist",
  );
  offset = principal.offset;
  const collateral = readPubkeyVec(
    buffer,
    offset,
    "lending collateral allowlist",
  );
  offset = collateral.offset;
  const marketCount = readU32(buffer, offset, "lending market policies");
  offset += 4;
  const marketPolicies: LoopscaleLendingMarketPolicy[] = [];
  for (let i = 0; i < marketCount; i++) {
    requireBytes(buffer, offset, 56, `lending market policy ${i}`);
    const market = new PublicKey(buffer.subarray(offset, offset + 32));
    offset += 32;
    const maxDepositAmount = new BN(buffer.subarray(offset, offset + 8), "le");
    offset += 8;
    const maxTotalDepositAmount = new BN(
      buffer.subarray(offset, offset + 8),
      "le",
    );
    offset += 8;
    const minLoanApyCbps = buffer.readUInt32LE(offset);
    offset += 4;
    const maxLtvBps = buffer.readUInt16LE(offset);
    offset += 2;
    const durations = readU8Vec(
      buffer,
      offset,
      `lending market policy ${i} durations`,
    );
    offset = durations.offset;
    const collateralAssets = readPubkeyVec(
      buffer,
      offset,
      `lending market policy ${i} collateral assets`,
    );
    offset = collateralAssets.offset;
    marketPolicies.push(
      new LoopscaleLendingMarketPolicy(
        market,
        maxDepositAmount,
        maxTotalDepositAmount,
        minLoanApyCbps,
        maxLtvBps,
        durations.values,
        collateralAssets.values,
      ),
    );
  }
  requireBytes(buffer, offset, 4, "sell-ledger policy");
  const sellLedgerPolicy = new LoopscaleSellLedgerPolicy(
    buffer.readUInt16LE(offset),
    buffer.readUInt16LE(offset + 2),
  );
  offset += 4;
  if (offset !== buffer.length) {
    throw new Error("lending policy has trailing bytes");
  }
  return new LoopscaleLendingPolicy(
    principal.values,
    collateral.values,
    marketPolicies,
    sellLedgerPolicy,
  );
}

export async function fetchPolicyForView<T>(
  label: string,
  fetchRawPolicyData: () => Promise<Buffer | null>,
  decodePolicy: (buffer: Buffer) => T,
): Promise<{ policy: T | null; error: string | null }> {
  try {
    const data = await fetchRawPolicyData();
    if (!data || data.length === 0) {
      return { policy: null, error: null };
    }
    return { policy: decodePolicy(data), error: null };
  } catch (error) {
    return {
      policy: null,
      error: `${label} policy could not be decoded: ${formatPolicyDecodeError(error)}`,
    };
  }
}

/** Resolve an optional comma- or space-separated list of token mints/symbols into deduped pubkeys. */
export async function resolveOptionalTokenList(
  context: CliContext,
  raw: string | undefined,
): Promise<PublicKey[]> {
  const parts = parseArrayInput(raw);
  const seen = new Set<string>();
  const result: PublicKey[] = [];
  for (const part of parts) {
    const mint = await resolveTokenPublicKey(context.glamClient, part);
    if (!seen.has(mint.toBase58())) {
      seen.add(mint.toBase58());
      result.push(mint);
    }
  }
  return result;
}

/** Resolve a comma- or space-separated list of token mints/symbols into deduped pubkeys. */
export async function resolveCollateralAssetList(
  context: CliContext,
  raw: string,
): Promise<PublicKey[]> {
  const parts = parseArrayInput(raw);
  if (parts.length === 0) {
    fail("collateral-assets must contain at least one mint or symbol");
  }
  const seen = new Set<string>();
  const result: PublicKey[] = [];
  for (const part of parts) {
    const mint = await resolveTokenPublicKey(context.glamClient, part);
    if (!seen.has(mint.toBase58())) {
      seen.add(mint.toBase58());
      result.push(mint);
    }
  }
  return result;
}

function tuple5IsZero(values: Tuple5): boolean {
  return values.every((value) => value === 0);
}

function listCollateralMints(loan: LoopscaleLoan): string {
  const mints = loan.activeCollateral
    .map((c) => c.assetMint.toBase58())
    .filter((m, i, arr) => arr.indexOf(m) === i);
  if (mints.length === 0) return "-";
  if (mints.length <= 3) return mints.join(", ");
  return `${mints.slice(0, 3).join(", ")} +${mints.length - 3} more`;
}

function listPrincipalMints(loan: LoopscaleLoan): string {
  const mints = loan.ledgers
    .map((l) => l.principalMint.toBase58())
    .filter((m, i, arr) => arr.indexOf(m) === i);
  if (mints.length === 0) return "-";
  if (mints.length <= 3) return mints.join(", ");
  return `${mints.slice(0, 3).join(", ")} +${mints.length - 3} more`;
}

function summarizeActivePrincipal(loan: LoopscaleLoan): string {
  return loan.ledgers
    .filter((ledger) => ledger.status !== 0)
    .map(
      (ledger) =>
        `${ledger.principalMint}:${ledger.principalDue}/${ledger.principalRepaid}`,
    )
    .join("; ");
}

export function listStrategyCollateralTerms(
  strategy: LoopscaleStrategy,
): string {
  const terms: string[] = [];
  for (
    let collateralIndex = 0;
    collateralIndex < strategy.collateralMap.length;
    collateralIndex++
  ) {
    const durations = strategy.collateralMap[collateralIndex] ?? [];
    for (
      let durationIndex = 0;
      durationIndex < durations.length;
      durationIndex++
    ) {
      const apy = durations[durationIndex];
      if (!apy.eq(U64_MAX_BN)) {
        terms.push(`c${collateralIndex}:d${durationIndex}=${apy.toString()}`);
      }
    }
  }
  if (terms.length === 0) return "-";
  if (terms.length <= 4) return terms.join(", ");
  return `${terms.slice(0, 4).join(", ")} +${terms.length - 4} more`;
}

export function strategyTermRows(
  strategy: LoopscaleStrategy,
  marketInfo?: LoopscaleMarketInformation,
): string[][] {
  const rows: string[][] = [];
  for (
    let collateralIndex = 0;
    collateralIndex < strategy.collateralMap.length;
    collateralIndex++
  ) {
    const durations = strategy.collateralMap[collateralIndex] ?? [];
    const assetData = marketInfo?.assetData[collateralIndex];
    for (
      let durationIndex = 0;
      durationIndex < durations.length;
      durationIndex++
    ) {
      const apy = durations[durationIndex];
      if (apy.eq(U64_MAX_BN)) {
        continue;
      }
      rows.push([
        String(collateralIndex),
        String(durationIndex),
        apy.toString(),
        assetData?.assetIdentifier?.toBase58() ?? "-",
        assetData?.quoteMint?.toBase58() ?? "-",
        assetData?.ltv === undefined ? "-" : String(assetData.ltv),
        assetData?.liquidationThreshold === undefined
          ? "-"
          : String(assetData.liquidationThreshold),
      ]);
    }
  }
  return rows;
}

export async function parseCollateralTermUpdates(
  context: CliContext,
  marketInfo: LoopscaleMarketInformation,
  rawTerms: string[],
): Promise<LoopscaleMultiCollateralTermsUpdateParams[]> {
  const groups = new Map<string, LoopscaleMultiCollateralTermsUpdateParams>();

  for (const rawTerm of rawTerms) {
    const parts = rawTerm.split(":").map((part) => part.trim());
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      fail(
        "collateral-term must be <collateral-index|collateral-token>:<duration-index>:<apy-cbps>",
      );
    }

    const durationIndex = parseUnsignedNumber(
      parts[1],
      "duration-index",
      STRATEGY_DURATION_COUNT - 1,
    );
    const apy = parseUnsignedNumber(parts[2], "apy-cbps");

    let collateralIndex: number;
    if (/^\d+$/.test(parts[0])) {
      collateralIndex = parseUnsignedNumber(
        parts[0],
        "collateral-index",
        marketInfo.assetData.length - 1,
      );
    } else {
      const assetIdentifier = await resolveTokenPublicKey(
        context.glamClient,
        parts[0],
      );
      const resolvedIndex = marketInfo.findAssetIndex(assetIdentifier);
      if (resolvedIndex === null) {
        fail(
          `Collateral asset ${assetIdentifier} is not present in market ${marketInfo.getAddress()}`,
        );
      }
      collateralIndex = resolvedIndex;
    }

    const key = apy.toString();
    const group = groups.get(key) ?? { apy, indices: [] };
    group.indices.push({ collateralIndex, durationIndex });
    groups.set(key, group);
  }

  return [...groups.values()];
}

/** The Loopscale borrow policy an edit replaces: the staged one under a timelock that holds one. */
async function loopscaleBorrowPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => context.glamClient.loopscaleBorrow.fetchPolicy(),
    () => context.glamClient.loopscaleBorrow.programId,
    LOOPSCALE_BORROW_PROTOCOL,
    LoopscaleBorrowPolicy.decode,
  );
}

export function installLoopscaleBorrowCommands(
  loopscaleBorrow: Command,
  context: CliContext,
) {
  loopscaleBorrow
    .command("list-loans")
    .option("--json", "Print all loans as JSON", false)
    .description("List Loopscale loans associated with the current GLAM state")
    .action(async (options: { json?: boolean }) => {
      const loans =
        await context.glamClient.loopscaleBorrow.fetchRegisteredLoans();
      if (loans.length === 0) {
        console.log("No Loopscale loans found");
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(loans, null, 2));
        return;
      }

      printTable(
        [
          "Loan",
          "Borrower",
          "Status",
          "Nonce",
          "Start Time",
          "Active Ledgers",
          "Collateral Mints",
          "Principal Mints",
          "Active Ledgers Summary",
        ],
        loans.map((loan) => [
          loan.getAddress().toBase58(),
          loan.borrower.toBase58(),
          String(loan.status),
          loan.nonce.toString(),
          loan.startTime.toString(),
          `${loan.activeLedgers.length}/${loan.ledgers.length}`,
          listCollateralMints(loan),
          listPrincipalMints(loan),
          summarizeActivePrincipal(loan),
        ]),
      );
    });

  loopscaleBorrow
    .command("view-policy")
    .description("View Loopscale borrow policy")
    .action(async () => {
      const { policy, error } = await fetchPolicyForView(
        "Borrow",
        () => fetchRawLoopscalePolicyData(context, LOOPSCALE_BORROW_PROTOCOL),
        decodeBorrowPolicyForView,
      );

      if (!policy && !error) {
        console.log("No borrow policy found");
        process.exit(1);
      }

      console.log("Borrow policy");
      if (error) {
        console.log(`  ${error}`);
        console.log(
          "  Use `loopscale-borrow reset-policy` to replace the stale policy without decoding it.",
        );
      } else if (!policy) {
        console.log("  (not set)");
      } else {
        printPubkeyList(
          "Borrow collateral mints allowlist",
          policy.collateralAllowlist,
        );
        printPubkeyList(
          "Borrow principal mints allowlist",
          policy.principalAllowlist,
        );
        printTable(
          [
            "Market",
            "Max Borrow",
            "Max Total Borrow",
            "Max LTV (bps)",
            "Durations",
          ],
          policy.marketPolicies.map((p) => [
            p.market.toBase58(),
            p.maxBorrowAmount.toString(),
            p.maxTotalBorrowAmount.toString(),
            String(p.maxLtvBps),
            p.durationIndexesAllowlist.join(",") || "-",
          ]),
        );
      }
    });

  loopscaleBorrow
    .command("set-policy")
    .option(
      "--collateral-allowlist <list>",
      "Comma- or space-separated collateral token mint addresses or symbols",
      "",
    )
    .option(
      "--principal-allowlist <list>",
      "Comma- or space-separated principal token mint addresses or symbols",
      "",
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Replace the full Loopscale borrow policy without decoding the existing policy",
    )
    .action(async (options) => {
      const collateralAllowlist = await resolveOptionalTokenList(
        context,
        options.collateralAllowlist,
      );
      const principalAllowlist = await resolveOptionalTokenList(
        context,
        options.principalAllowlist,
      );
      const policy = new LoopscaleBorrowPolicy(
        collateralAllowlist,
        principalAllowlist,
        [],
      );

      const timelock = await readVaultTimelock(context);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleBorrow.setPolicy(
            policy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              "Confirm replacing Loopscale borrow policy",
              `  collateral allowlist: ${keysText(collateralAllowlist, "every collateral deposit")}`,
              `  principal allowlist: ${keysText(principalAllowlist, "every principal borrow")}`,
              MARKET_LIMITS_CLEARED,
            ].join("\n"),
          ),
        },
        timelock.outcome("Loopscale borrow policy replaced"),
      );
    });

  loopscaleBorrow
    .command("reset-policy")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Reset Loopscale borrow policy to an empty default without decoding the existing policy",
    )
    .action(async (options) => {
      const timelock = await readVaultTimelock(context);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleBorrow.setPolicy(
            new LoopscaleBorrowPolicy(),
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            "Confirm resetting Loopscale borrow policy",
          ),
        },
        timelock.outcome("Loopscale borrow policy reset"),
      );
    });

  loopscaleBorrow
    .command("allowlist-token")
    .argument("<token>", "Principal token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a principal token to the borrow allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleBorrowPolicyToEdit(context, timelock);
      const policy = base.value ?? new LoopscaleBorrowPolicy();
      if (policy.principalAllowlist.find((m) => m.equals(token))) {
        fail(
          `Principal token ${token} is already in the allowlist${base.stagedApart ? " as staged" : ""}`,
        );
      }

      policy.principalAllowlist.push(token);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleBorrow.setPolicy(
            policy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding principal token ${token}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale borrow policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Principal token ${token} added to allowlist`),
      );
    });

  loopscaleBorrow
    .command("remove-token")
    .argument("<token>", "Principal token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a principal token from the borrow allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleBorrowPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        fail(
          `No borrow policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
      }
      if (!policy.principalAllowlist.find((m) => m.equals(token))) {
        fail(
          `Principal token not in allowlist${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
      }

      policy.principalAllowlist = policy.principalAllowlist.filter(
        (m) => !m.equals(token),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleBorrow.setPolicy(
            policy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing principal token ${token}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale borrow policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Principal token ${token} removed from allowlist`),
      );
    });

  loopscaleBorrow
    .command("allowlist-collateral-token")
    .argument("<token>", "Collateral token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a collateral token to the allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleBorrowPolicyToEdit(context, timelock);
      const policy = base.value ?? new LoopscaleBorrowPolicy();
      if (policy.collateralAllowlist.find((m) => m.equals(token))) {
        fail(
          `Collateral token ${token} is already in the allowlist${base.stagedApart ? " as staged" : ""}`,
        );
      }

      policy.collateralAllowlist.push(token);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleBorrow.setPolicy(
            policy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding collateral token ${token}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale borrow policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Collateral token ${token} added to allowlist`),
      );
    });

  loopscaleBorrow
    .command("remove-collateral-token")
    .argument("<token>", "Collateral token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a collateral token from the allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleBorrowPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        fail(
          `No policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
      }
      if (!policy.collateralAllowlist.find((m) => m.equals(token))) {
        fail(
          `Collateral token not in allowlist${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
      }

      policy.collateralAllowlist = policy.collateralAllowlist.filter(
        (m) => !m.equals(token),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleBorrow.setPolicy(
            policy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing collateral token ${token}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale borrow policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Collateral token ${token} removed from allowlist`),
      );
    });

  loopscaleBorrow
    .command("allowlist-market")
    .argument(
      "<market>",
      "Loopscale market information public key",
      validatePublicKey,
    )
    .requiredOption(
      "--max-borrow-amount-raw <amount>",
      "Max principal borrowable per instruction (base units)",
    )
    .requiredOption(
      "--max-total-borrow-amount-raw <amount>",
      "Max outstanding principal per loan in this market (base units)",
    )
    .requiredOption(
      "--max-ltv-bps <bps>",
      "Max expected liquidation LTV threshold, in basis points",
    )
    .requiredOption(
      "--durations <list>",
      "Allowed duration indexes, comma- or space-separated (0=1d,1=1w,2=1m,3=3m,4=1y)",
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Add or update optional advanced risk limits for a borrow market",
    )
    .action(async (market: PublicKey, options) => {
      const maxBorrowAmount = parseNonNegativeU64(
        options.maxBorrowAmountRaw,
        "max-borrow-amount-raw",
      );
      const maxTotalBorrowAmount = parseNonNegativeU64(
        options.maxTotalBorrowAmountRaw,
        "max-total-borrow-amount-raw",
      );
      const maxLtvBps = parseBps(options.maxLtvBps, "max-ltv-bps");
      const durations = parseDurationIndexes(options.durations, "durations");

      const timelock = await readVaultTimelock(context);
      const base = await loopscaleBorrowPolicyToEdit(context, timelock);
      const policy = base.value ?? new LoopscaleBorrowPolicy();
      const marketPolicy = new LoopscaleBorrowMarketPolicy(
        market,
        maxBorrowAmount,
        maxTotalBorrowAmount,
        maxLtvBps,
        durations,
      );
      const existingIndex = policy.marketPolicies.findIndex((p) =>
        p.market.equals(market),
      );
      const action = existingIndex >= 0 ? "updated" : "added";
      const previous =
        existingIndex >= 0
          ? borrowMarketFields(policy.marketPolicies[existingIndex])
          : undefined;
      if (existingIndex >= 0) {
        policy.marketPolicies[existingIndex] = marketPolicy;
      } else {
        policy.marketPolicies.push(marketPolicy);
      }

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleBorrow.setPolicy(
            policy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm ${action === "updated" ? "updating" : "adding"} borrow market ${market}`,
              ...marketFieldLines(borrowMarketFields(marketPolicy), previous),
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale borrow policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Borrow market ${market} ${action}`),
      );
    });

  loopscaleBorrow
    .command("remove-market")
    .argument(
      "<market>",
      "Loopscale market information public key",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove optional advanced risk limits for a borrow market")
    .action(async (market: PublicKey, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleBorrowPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        fail(
          `No borrow policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
      }
      if (!policy.marketPolicies.find((p) => p.market.equals(market))) {
        fail(
          `Market not in borrow policy${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
      }

      const removed = policy.marketPolicies.find((p) =>
        p.market.equals(market),
      )!;
      policy.marketPolicies = policy.marketPolicies.filter(
        (p) => !p.market.equals(market),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleBorrow.setPolicy(
            policy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing the limits of borrow market ${market}:`,
              ...marketFieldLines(borrowMarketFields(removed)),
              "The market stays usable under the collateral and principal allowlists, with no per-market limit.",
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale borrow policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Limits of borrow market ${market} removed`),
      );
    });

  loopscaleBorrow
    .command("quote")
    .argument("<collateral-token>", "Collateral mint address or symbol")
    .argument("<collateral-amount>", "Collateral amount")
    .argument("<borrow-token>", "Principal mint address or symbol")
    .argument("<borrow-amount>", "Principal amount to borrow")
    .option(
      "--duration-type <n>",
      "Loopscale quote duration type (0=days, 1=weeks, 2=months, 3=minutes, 4=years)",
      "0",
    )
    .requiredOption("--duration <n>", "Loopscale quote duration units")
    .option(
      "--external-yield-source <u8>",
      "Only select quotes from strategies with this external yield source",
    )
    .option("--json", "Print the raw selected quote as JSON", false)
    .description("Fetch the best Loopscale quote for a borrow")
    .action(
      async (
        cToken: string,
        cAmount: string,
        bToken: string,
        bAmount: string,
        opts: {
          durationType: string;
          duration: string;
          externalYieldSource?: string;
          json?: boolean;
        },
      ) => {
        const quoteDurationType = parseUnsignedNumber(
          opts.durationType,
          "duration-type",
          4,
        );
        const quoteDuration = parseUnsignedNumber(
          opts.duration,
          "duration",
          U32_MAX,
        );
        const principalToken = await resolveTokenMint(
          context.glamClient,
          bToken,
        );
        const collateralToken = await resolveTokenMint(
          context.glamClient,
          cToken,
        );
        const principalMint = new PublicKey(principalToken.address);
        const collateralMint = new PublicKey(collateralToken.address);
        const collateralAmount = parsePositiveUiAmount(
          cAmount,
          collateralToken.decimals,
          "collateral-amount",
        );
        const borrowAmount = parsePositiveUiAmount(
          bAmount,
          principalToken.decimals,
          "borrow-amount",
        );

        const quote = await context.glamClient.loopscaleBorrow.fetchBestQuote({
          principalMint,
          collateralMint,
          collateralAmount,
          durationType: quoteDurationType,
          duration: quoteDuration,
          borrowAmount,
          externalYieldSource:
            opts.externalYieldSource === undefined
              ? undefined
              : parseUnsignedNumber(
                  opts.externalYieldSource,
                  "external-yield-source",
                  U8_MAX,
                ),
        });

        if (opts.json) {
          console.log(JSON.stringify(quote, null, 2));
          return;
        }

        console.log(`Strategy: ${quote.strategy}`);
        console.log(`Collateral identifier: ${quote.collateralIdentifier}`);
        console.log(`Amount: ${quote.amount}`);
        console.log(`APY cBPS: ${quote.apy}`);
        console.log(`LTV cBPS: ${quote.ltv}`);
        console.log(`LQT cBPS: ${quote.lqt}`);
      },
    );

  loopscaleBorrow
    .command("create-loan")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Create a new Loopscale loan account")
    .action(async (options: { yes: boolean }) => {
      const nonce = new BN(Date.now());
      const loan = context.glamClient.loopscaleBorrow.getLoanPda(nonce);

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleBorrow.createLoan(
            { nonce },
            context.txOptions,
          ),
        {
          skip: options.yes ?? false,
          message: [
            "Confirm Loopscale create-loan",
            `nonce: ${nonce}`,
            `loan: ${loan}`,
          ].join("\n"),
        },
        (txSig) => `Loopscale loan ${loan} created (nonce ${nonce}): ${txSig}`,
      );
    });

  loopscaleBorrow
    .command("close-loan")
    .argument(
      "<loan>",
      "Existing empty Loopscale loan account",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Close an empty Loopscale loan account")
    .action(async (loan: PublicKey, options: { yes?: boolean }) => {
      const loanAccount =
        await context.glamClient.loopscaleBorrow.fetchOwnedLoan(loan);

      if (loanAccount.activeCollateral.length > 0) {
        fail(
          `Loan ${loan} still has active collateral (${listCollateralMints(loanAccount)}); withdraw collateral before closing.`,
        );
      }
      if (loanAccount.activeLedgers.length > 0) {
        fail(
          `Loan ${loan} still has active principal (${summarizeActivePrincipal(loanAccount)}); repay principal before closing.`,
        );
      }

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleBorrow.closeLoan(loan, context.txOptions),
        {
          skip: options.yes ?? false,
          message: `Confirm closing Loopscale loan: ${loan}`,
        },
        (txSig) => `Loopscale loan ${loan} closed: ${txSig}`,
      );
    });

  loopscaleBorrow
    .command("deposit-collateral")
    .argument("<loan>", "Existing Loopscale loan account", validatePublicKey)
    .argument("<collateral-token>", "Collateral mint address or symbol")
    .argument("<amount>", "Collateral amount")
    .option(
      "--asset-type [asset-type]",
      "Asset type enum. Only 0, SPL token collateral, is supported",
      "0",
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Deposit collateral into an existing Loopscale loan")
    .action(
      async (
        loan: PublicKey,
        cToken: string,
        amount: string,
        options: { assetType: string; yes: boolean },
      ) => {
        const { assetType, yes } = options;

        const { address, decimals, symbol } = await resolveTokenMint(
          context.glamClient,
          cToken,
        );
        const collateralMint = new PublicKey(address);
        const collateralAmount = requireSafeIntegerAmount(
          parsePositiveUiAmount(amount, decimals, "amount"),
          "amount",
          "the Loopscale API",
        );
        // Read before the confirmation, like the amount. The SDK deposits
        // SPL token collateral only, and refused another type after it.
        const collateralAssetType = parseU8(assetType, "asset-type");
        if (collateralAssetType !== 0) {
          fail(
            `asset-type ${collateralAssetType} is not supported: the SDK deposits asset type 0, SPL token collateral, only`,
          );
        }

        const collateralLabel = `${amount} ${symbol}`;
        await executeTxWithErrorHandling(
          () =>
            context.glamClient.loopscaleBorrow.depositCollateral(
              {
                amount: collateralAmount,
                assetType: collateralAssetType,
                assetIdentifier: collateralMint,
                assetIndexGuidance: [],
              },
              {
                loan,
                depositMint: collateralMint,
              },
              context.txOptions,
            ),
          {
            skip: yes,
            message: [
              "Confirm Loopscale deposit-collateral",
              `loan: ${loan}`,
              `collateral: ${collateralLabel}`,
              `asset type: ${collateralAssetType}`,
            ].join("\n"),
          },
          (txSig) => `Deposited ${collateralLabel} into loan ${loan}: ${txSig}`,
        );
      },
    );

  loopscaleBorrow
    .command("withdraw-collateral")
    .argument("<loan>", "Existing Loopscale loan account", validatePublicKey)
    .argument("<collateral-token>", "Collateral mint address or symbol")
    .argument("<amount>", "Collateral amount")
    .option("--collateral-index <u8>", "Collateral index override")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Withdraw collateral from an existing Loopscale loan")
    .action(
      async (
        loan: PublicKey,
        cToken: string,
        amount: string,
        options: {
          collateralIndex?: string;
          yes: boolean;
        },
      ) => {
        const { collateralIndex, yes } = options;

        const loanAccount =
          await context.glamClient.loopscaleBorrow.fetchOwnedLoan(loan);

        const { address, symbol, decimals } = await resolveTokenMint(
          context.glamClient,
          cToken,
        );
        const collateralMint = new PublicKey(address);

        // Slot of the chosen collateral within the loan's collateral array;
        // the loan stores per-slot lqt at the matching lqtMatrix row.
        const collateralSlot =
          collateralIndex !== undefined
            ? parseUnsignedNumber(collateralIndex, "collateral-index", U8_MAX)
            : loanAccount.collateral.findIndex((c) =>
                c.assetMint.equals(collateralMint),
              );
        if (
          collateralSlot < 0 ||
          collateralSlot >= loanAccount.collateral.length ||
          !loanAccount.collateral[collateralSlot].assetMint.equals(
            collateralMint,
          )
        ) {
          fail(`Collateral ${collateralMint} is not held by loan ${loan}`);
        }

        const collateral = loanAccount.collateral[collateralSlot];
        const withdrawAmount = requireSafeIntegerAmount(
          parsePositiveUiAmount(amount, decimals, "amount"),
          "amount",
          "the Loopscale API",
        );
        if (withdrawAmount.gt(collateral.amount)) {
          fail(
            `Cannot withdraw ${amount} ${symbol}; collateral slot ${collateralSlot} holds ${collateral.amount.toString()} raw units`,
          );
        }

        // Source expected loan values from the loan's cached state: apy from the
        // matching active ledger (if any) and lqt from the collateral slot.
        const ledger = loanAccount.activeLedgers[0];
        const expectedApy = ledger ? ledger.apy : new BN(0);
        const expectedLqt = loanAccount.lqtMatrix[collateralSlot] as Tuple5;

        const collateralLabel = `${amount} ${symbol}`;
        await executeTxWithErrorHandling(
          () =>
            context.glamClient.loopscaleBorrow.withdrawCollateral(
              {
                amount: withdrawAmount,
                collateralIndex: collateralSlot,
                assetIndexGuidance: [],
                expectedLoanValues: { expectedApy, expectedLqt },
                closeIfEligible: false,
                withdrawAll: false,
              },
              {
                loan,
                assetMint: collateralMint,
              },
              context.txOptions,
            ),
          {
            skip: yes,
            message: [
              "Confirm Loopscale withdraw-collateral",
              `loan: ${loan}`,
              `collateral: ${collateralLabel}`,
              `collateral index: ${collateralSlot}`,
            ].join("\n"),
          },
          (txSig) => `Withdrew ${collateralLabel} from loan ${loan}: ${txSig}`,
        );
      },
    );

  loopscaleBorrow
    .command("borrow-principal")
    .argument("<loan>", "Existing Loopscale loan account", validatePublicKey)
    .argument("<amount>", "Principal amount to borrow")
    .option(
      "--borrow-token <mint-or-symbol>",
      "Principal mint or symbol (required for quote API first borrows)",
    )
    .option(
      "--collateral-token <mint-or-symbol>",
      "Collateral mint or symbol (required when the loan holds multiple collateral mints)",
    )
    .option(
      "--duration-type <n>",
      `Loopscale quote duration type for a first borrow (${LOOPSCALE_DURATION_UNITS.map((unit, type) => `${type}=${unit}s`).join(", ")})`,
      "0",
    )
    .option(
      "--duration <n>",
      "Loopscale quote duration units for a first borrow. A strategy lends for 1 day, 1 week, 1 month, 3 months or 1 year, and for no other duration",
    )
    .option(
      "--strategy-duration-index <u8>",
      "Duration index to use with --strategy when multiple strategy terms match the collateral",
    )
    .option(
      "--strategy <pubkey>",
      "Target Loopscale strategy for a first borrow instead of selecting from the quote API",
      validatePublicKey,
    )
    .option(
      "--external-yield-source <u8>",
      "Only select quote API strategies with this external yield source",
    )
    .option("--skip-sol-unwrap", "Skip SOL unwrap", false)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Borrow principal against an existing Loopscale loan")
    .action(
      async (
        loan: PublicKey,
        amount: string,
        options: {
          borrowToken?: string;
          collateralToken?: string;
          durationType: string;
          duration?: string;
          strategy?: PublicKey;
          strategyDurationIndex?: string;
          externalYieldSource?: string;
          skipSolUnwrap: boolean;
          yes: boolean;
        },
        command: Command,
      ) => {
        const {
          borrowToken,
          collateralToken,
          skipSolUnwrap,
          externalYieldSource,
          yes,
        } = options;

        // A borrow takes its terms from an active ledger of the loan, from the
        // strategy --strategy names, or from the quote API. Each option is
        // read here, whichever of them applies.
        const durationType = parseUnsignedNumber(
          options.durationType,
          "duration-type",
          4,
        );
        const duration =
          options.duration === undefined
            ? undefined
            : parseUnsignedNumber(options.duration, "duration", U32_MAX);
        const strategyDurationIndex =
          options.strategyDurationIndex === undefined
            ? undefined
            : parseUnsignedNumber(
                options.strategyDurationIndex,
                "strategy-duration-index",
                STRATEGY_DURATION_COUNT - 1,
              );
        const externalYieldSourceFilter =
          externalYieldSource === undefined
            ? undefined
            : parseUnsignedNumber(
                externalYieldSource,
                "external-yield-source",
                U8_MAX,
              );
        // --strategy rules the quote API out, and its absence rules the
        // strategy's own terms out. An option of the other side would change
        // nothing, so it is refused.
        if (options.strategy === undefined) {
          if (strategyDurationIndex !== undefined) {
            fail("--strategy-duration-index applies only with --strategy");
          }
        } else {
          const quoteOnly = [
            [
              "--duration-type",
              command.getOptionValueSource("durationType") === "cli",
            ],
            ["--duration", duration !== undefined],
            [
              "--external-yield-source",
              externalYieldSourceFilter !== undefined,
            ],
          ] as const;
          for (const [flag, given] of quoteOnly) {
            if (given) {
              fail(
                `${flag} applies only without --strategy, which takes the borrow's terms from the strategy`,
              );
            }
          }
        }

        const loanAccount =
          await context.glamClient.loopscaleBorrow.fetchOwnedLoan(loan);
        const { activeCollateral, activeLedgers, collateral, lqtMatrix } =
          loanAccount;

        if (activeCollateral.length === 0) {
          fail(
            `Loan ${loan} has no collateral deposited, do deposit-collateral first`,
          );
        }

        let principalMint: PublicKey | undefined;
        if (borrowToken) {
          principalMint = await resolveTokenPublicKey(
            context.glamClient,
            borrowToken,
          );
        }

        const targetStrategy = options.strategy;
        if (targetStrategy) {
          const strategyAccount =
            await context.glamClient.loopscaleBorrow.fetchStrategy(
              targetStrategy,
            );
          if (
            principalMint &&
            !strategyAccount.principalMint.equals(principalMint)
          ) {
            fail(
              `Requested strategy ${targetStrategy} principal mint ${strategyAccount.principalMint} does not match ${principalMint}`,
            );
          }
          principalMint = strategyAccount.principalMint;
        }

        const existingLedgerMatch = principalMint
          ? loanAccount.ledgers
              .map((ledger, index) => ({ ledger, index }))
              .find(
                ({ ledger }) =>
                  ledger.status !== 0 &&
                  ledger.principalMint.equals(principalMint!),
              )
          : undefined;
        let ledgerMatch = existingLedgerMatch;
        const ledger = ledgerMatch?.ledger;
        if (
          ledger &&
          targetStrategy &&
          !ledger.strategy.equals(targetStrategy)
        ) {
          fail(
            `Loan ${loan} already has an active ${principalMint} ledger using strategy ${ledger.strategy}; borrowing the same principal with a different strategy requires refinancing the existing ledger.`,
          );
        }
        if (!principalMint) {
          if (activeLedgers.length === 1) {
            ledgerMatch = loanAccount.ledgers
              .map((ledger, index) => ({ ledger, index }))
              .find(({ ledger }) => ledger.status !== 0);
            principalMint = ledgerMatch!.ledger.principalMint;
          } else if (activeLedgers.length > 1) {
            fail(
              `Loan ${loan} has multiple active ledgers; specify --borrow-token or --strategy`,
            );
          } else {
            fail("--borrow-token is required for quote API first borrows");
          }
        }
        const inferredLedgerMatch = ledgerMatch ?? existingLedgerMatch;

        let collateralSlot: number;
        let collateralMint: PublicKey;
        if (collateralToken) {
          collateralMint = await resolveTokenPublicKey(
            context.glamClient,
            collateralToken,
          );
          collateralSlot = collateral.findIndex(
            (c) =>
              c.assetMint.equals(collateralMint) &&
              (!c.amount.isZero() ||
                !c.assetIdentifier.equals(PublicKey.default)),
          );
          if (collateralSlot === -1) {
            fail(`Collateral ${collateralMint} is not held by loan ${loan}`);
          }
        } else if (ledgerMatch) {
          collateralSlot = loanAccount.weightMatrix.findIndex(
            (row, index) =>
              row[ledgerMatch.index] > 0 &&
              collateral[index] &&
              (!collateral[index].amount.isZero() ||
                !collateral[index].assetIdentifier.equals(PublicKey.default)),
          );
          if (collateralSlot === -1) {
            fail(
              `Loan ${loan} has no weighted collateral for active ledger ${ledgerMatch.index}`,
            );
          }
          collateralMint = collateral[collateralSlot].assetMint;
        } else {
          const uniqueMints = new PkSet(
            activeCollateral.map((c) => c.assetMint),
          );

          if (uniqueMints.size > 1) {
            fail(
              `Loan ${loan} holds multiple collateral mints; specify --collateral-token`,
            );
          }
          collateralMint = activeCollateral[0].assetMint;
          collateralSlot = collateral.findIndex((c) =>
            c.assetMint.equals(collateralMint),
          );
        }

        const assetIdentifier = collateral[collateralSlot].assetIdentifier;

        const { symbol, decimals } = await resolveTokenMint(
          context.glamClient,
          principalMint.toBase58(),
        );
        const borrowAmount = requireSafeIntegerAmount(
          parsePositiveUiAmount(amount, decimals, "amount"),
          "amount",
          "the Loopscale API",
        );

        if (ledgerMatch) {
          const selectedCollateralWeight =
            loanAccount.weightMatrix[collateralSlot]?.[ledgerMatch.index] ?? 0;
          if (selectedCollateralWeight === 0) {
            fail(
              `Active ledger ${ledgerMatch.index} borrows ${principalMint} but is not weighted against collateral ${collateralMint}. Borrowing the same principal against this collateral requires refinancing the existing ledger, which is not supported by the GLAM Loopscale proxy yet.`,
            );
          }
        }

        // Reuse the strategy and terms from an existing active ledger borrowing
        // the same principal, instead of quoting for a (possibly different) strategy.
        // FIXME: this may fail if the same strategy doesn't have enough capacity
        //
        // The duration index that is sent is the slot of a term. A strategy
        // may lend several terms at one APY, so the SDK is told the term: the
        // ledger's own, or the one the quote was asked for.
        const {
          strategy,
          expectedLoanValues,
          assetIndexGuidance,
          durationIndex,
          duration: sentTerm,
        } = ledgerMatch
          ? await (async () => {
              const { ledger } = ledgerMatch;
              const expectedApy = ledger.apy;
              const expectedLqt = lqtMatrix[collateralSlot] as Tuple5;
              if (tuple5IsZero(expectedLqt)) {
                fail(
                  `Loan ${loan} has an active ledger but collateral index ${collateralSlot} has zero expected LQT; cannot safely reuse loan terms.`,
                );
              }
              console.log(
                `Reusing loan strategy ${ledger.strategy} (apy=${expectedApy.toString()}, lqt=[${expectedLqt.join(", ")}])`,
              );
              return await context.glamClient.loopscaleBorrow.resolveBorrowTermsFromStrategy(
                {
                  strategy: ledger.strategy,
                  principalMint,
                  assetIdentifier,
                  expectedApy,
                  expectedLqt,
                  duration: ledger.duration,
                },
              );
            })()
          : targetStrategy
            ? await (async () => {
                const terms =
                  await context.glamClient.loopscaleBorrow.resolveBorrowTermsFromTargetStrategy(
                    {
                      strategy: targetStrategy,
                      principalMint,
                      assetIdentifier,
                      requestedDurationIndex: strategyDurationIndex,
                    },
                  );
                console.log(
                  `Using requested Loopscale strategy ${terms.strategy} (apy=${terms.expectedLoanValues.expectedApy.toString()}, lqt=[${terms.expectedLoanValues.expectedLqt.join(", ")}])`,
                );
                return terms;
              })()
            : await (async () => {
                const quoteDurationType =
                  duration === undefined && inferredLedgerMatch
                    ? inferredLedgerMatch.ledger.duration.durationType
                    : durationType;
                const quoteDuration =
                  duration ?? inferredLedgerMatch?.ledger.duration.duration;
                if (quoteDuration === undefined) {
                  fail("--duration is required for the first borrow");
                }
                const quotes =
                  await context.glamClient.loopscaleBorrow.fetchMaxQuotes({
                    principalMint,
                    collateralMint,
                    collateralAmount: collateral[collateralSlot].amount,
                    durationType: quoteDurationType,
                    duration: quoteDuration,
                    borrowAmount,
                    externalYieldSource: externalYieldSourceFilter,
                  });
                const activeStrategySet = new Set(
                  activeLedgers.map((ledger) => ledger.strategy.toBase58()),
                );
                const newStrategyQuotes = quotes.filter(
                  (quote) => !activeStrategySet.has(quote.strategy),
                );
                if (newStrategyQuotes.length === 0) {
                  fail(
                    `Loopscale quote API returned no inactive strategy for ${collateralMint}; use a different collateral, amount, or specify --strategy.`,
                  );
                }
                const quote =
                  await context.glamClient.loopscaleBorrow.selectBestQuote(
                    newStrategyQuotes,
                    externalYieldSourceFilter,
                    borrowAmount,
                  );
                if (quote.collateralIdentifier) {
                  const quotedCollateralIdentifier = new PublicKey(
                    quote.collateralIdentifier,
                  );
                  if (!quotedCollateralIdentifier.equals(assetIdentifier)) {
                    fail(
                      `Quote collateral identifier ${quotedCollateralIdentifier} does not match asset identifier ${assetIdentifier}`,
                    );
                  }
                }
                const quoteAmount = new BN(String(quote.amount));
                if (quoteAmount.lt(borrowAmount)) {
                  fail(
                    `Selected quote only supports ${quoteAmount.toString()} base units, below requested borrow amount ${borrowAmount.toString()}`,
                  );
                }
                const quoteTerms =
                  await context.glamClient.loopscaleBorrow.resolveBorrowTermsFromStrategy(
                    {
                      strategy: new PublicKey(quote.strategy),
                      principalMint,
                      assetIdentifier,
                      expectedApy: new BN(String(quote.apy)),
                      expectedLqt: [Number(quote.lqt), 0, 0, 0, 0],
                      duration: {
                        durationType: quoteDurationType,
                        duration: quoteDuration,
                      },
                    },
                  );
                console.log(
                  `Selected Loopscale strategy ${quoteTerms.strategy} from quote API (apy=${quoteTerms.expectedLoanValues.expectedApy.toString()}, lqt=[${quoteTerms.expectedLoanValues.expectedLqt.join(", ")}])`,
                );
                return quoteTerms;
              })();

        // A further borrow on an active ledger takes that ledger's terms. An
        // option that asks for other terms is refused. --external-yield-source
        // only filters quotes, so it has nothing here to differ from.
        if (ledgerMatch) {
          const ledgerTerms = ledgerMatch.ledger.duration;
          // As on the quote path, --duration is read with its type, which is
          // 0 unless --duration-type gives another.
          const asked =
            duration !== undefined
              ? `--duration ${duration} of type ${durationType}`
              : command.getOptionValueSource("durationType") === "cli"
                ? `--duration-type ${durationType}`
                : undefined;
          if (
            asked !== undefined &&
            ((duration !== undefined && duration !== ledgerTerms.duration) ||
              durationType !== ledgerTerms.durationType)
          ) {
            fail(
              `${asked} does not apply: the loan's active ledger ${ledgerMatch.index} has duration ${ledgerTerms.duration} of type ${ledgerTerms.durationType}, and a further borrow takes its terms`,
            );
          }
          // The index that is sent stands for a term, and that term is the
          // ledger's, whatever else the strategy lends at the ledger's APY.
          if (
            sentTerm.duration !== ledgerTerms.duration ||
            sentTerm.durationType !== ledgerTerms.durationType
          ) {
            fail(
              `Duration index ${durationIndex} stands for duration ${sentTerm.duration} of type ${sentTerm.durationType}, and the loan's active ledger ${ledgerMatch.index} has duration ${ledgerTerms.duration} of type ${ledgerTerms.durationType}, whose term a further borrow takes`,
            );
          }
          // The index that is sent is the one the SDK resolves for the ledger.
          if (
            strategyDurationIndex !== undefined &&
            strategyDurationIndex !== durationIndex
          ) {
            fail(
              `--strategy-duration-index ${strategyDurationIndex} does not apply: a further borrow on the loan's active ledger ${ledgerMatch.index} is sent with duration index ${durationIndex}`,
            );
          }
        }

        const principalLabel = `${amount} ${symbol}`;
        const confirmMessage = [
          "Confirm Loopscale borrow against existing loan",
          `loan: ${loan}`,
          `strategy: ${strategy}`,
          `collateral mint: ${collateralMint}`,
          `expected apy: ${expectedLoanValues.expectedApy.toString()}`,
          `expected lqt: [${expectedLoanValues.expectedLqt.join(", ")}]`,
          `duration index: ${durationIndex} (${formatLoopscaleDuration(sentTerm)})`,
          `borrow: ${principalLabel}`,
        ].join("\n");

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.loopscaleBorrow.borrowPrincipal(
              {
                amount: borrowAmount,
                assetIndexGuidance: Array.from(assetIndexGuidance),
                duration: durationIndex,
                expectedLoanValues,
                skipSolUnwrap,
              },
              {
                loan,
                strategy,
              },
              context.txOptions,
            ),
          {
            skip: yes,
            message: confirmMessage,
          },
          (txSig) =>
            `Borrowed ${principalLabel} against loan ${loan}: ${txSig}`,
        );
      },
    );

  loopscaleBorrow
    .command("repay-principal")
    .argument("<loan>", "Existing Loopscale loan account", validatePublicKey)
    .argument("<amount>", "Principal amount to repay")
    .option("--ledger-index <u8>", "Ledger index override")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Repay principal on a Loopscale loan ledger")
    .action(
      async (
        loan: PublicKey,
        amount: string,
        options: {
          ledgerIndex?: string;
          yes: boolean;
        },
      ) => {
        const { ledgerIndex, yes } = options;
        const loanAccount =
          await context.glamClient.loopscaleBorrow.fetchOwnedLoan(loan);

        // Resolve the target ledger: explicit index if given, otherwise the
        // loan's single active ledger.
        let ledgerIdx: number;
        if (ledgerIndex !== undefined) {
          ledgerIdx = parseUnsignedNumber(ledgerIndex, "ledger-index", U8_MAX);
          const ledger = loanAccount.ledgers[ledgerIdx];
          if (!ledger || ledger.status === 0) {
            fail(`Loan ${loan} has no active ledger at index ${ledgerIdx}`);
          }
        } else {
          const matches = loanAccount.ledgers
            .map((l, i) => ({ ledger: l, index: i }))
            .filter(({ ledger }) => ledger.status !== 0);
          if (matches.length === 0) {
            fail(`Loan ${loan} has no active borrow to repay.`);
          }
          if (matches.length > 1) {
            fail(
              `Loan ${loan} has multiple active ledgers ` +
                `(indices ${matches.map((m) => m.index).join(", ")}); specify --ledger-index`,
            );
          }
          ledgerIdx = matches[0].index;
        }

        const { principalMint, strategy } = loanAccount.ledgers[ledgerIdx];
        const { address, decimals, symbol } = await resolveTokenMint(
          context.glamClient,
          principalMint.toBase58(),
        );

        // On a full repay, on-chain repays the full amount due; pass principalDue
        // as a ceiling. The borrower ATA must be funded above principalDue to
        // cover accrued interest.
        const repayAmount = requireSafeIntegerAmount(
          parsePositiveUiAmount(amount, decimals, "amount"),
          "amount",
          "the Loopscale API",
        );
        const { principalMint: strategyPrincipalMint } =
          await context.glamClient.loopscaleBorrow.fetchStrategy(strategy);
        if (!strategyPrincipalMint.equals(principalMint)) {
          fail(
            `Ledger ${ledgerIdx} strategy principal mint ${strategyPrincipalMint} does not match ${principalMint}`,
          );
        }

        const principalLabel = `${amount} ${symbol}`;
        await executeTxWithErrorHandling(
          () =>
            context.glamClient.loopscaleBorrow.repayPrincipal(
              { amount: repayAmount, ledgerIndex: ledgerIdx, repayAll: false },
              { loan, strategy },
              context.txOptions,
            ),
          {
            skip: yes,
            message: [
              "Confirm Loopscale repay-principal",
              `loan: ${loan}`,
              `ledger index: ${ledgerIdx}`,
              `principal mint: ${address}`,
              `repay: ${principalLabel}`,
            ].join("\n"),
          },
          (txSig) =>
            `Repaid ${principalLabel} on loan ${loan} ledger ${ledgerIdx}: ${txSig}`,
        );
      },
    );
}
