import { BN } from "@coral-xyz/anchor";
import {
  LoopscaleLendingMarketPolicy,
  LoopscaleLendingPolicy,
  LoopscaleSellLedgerPolicy,
  buildLoopscaleApiCollateralTermUpdates,
  LOOPSCALE_LENDING_PROTOCOL,
  type LoopscaleApiUpdateStrategyParams,
  type LoopscaleMarketInformation,
  U32_MAX,
  bnToSafeNumber,
  fetchMintAndTokenProgram,
} from "@glamsystems/glam-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { type Command } from "commander";

import {
  type CliContext,
  executeTxWithErrorHandling,
  printPubkeyList,
  printTable,
  formatUiAmount,
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
  parseCbps,
  parseDurationIndexes,
  parseNonNegativeU64,
  parseNonNegativeUiAmount,
  parsePositiveUiAmount,
  parseUnsignedNumber,
  requireSafeIntegerAmount,
  validatePublicKey,
} from "../parsing";
import {
  decodeLendingPolicyForView,
  fetchPolicyForView,
  fetchRawLoopscalePolicyData,
  listStrategyCollateralTerms,
  parseCollateralTermUpdates,
  resolveCollateralAssetList,
  resolveOptionalTokenList,
  strategyTermRows,
  collateralTermLines,
  keysText,
  lendingMarketFields,
  marketFieldLines,
  MARKET_LIMITS_CLEARED,
} from "./loopscale-borrow";

/** The Loopscale lending policy an edit replaces: the staged one under a timelock that holds one. */
async function loopscaleLendingPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => context.glamClient.loopscaleLend.fetchPolicy(),
    () => context.glamClient.loopscaleLend.programId,
    LOOPSCALE_LENDING_PROTOCOL,
    LoopscaleLendingPolicy.decode,
  );
}

export function installLoopscaleLendCommands(
  loopscaleLend: Command,
  context: CliContext,
) {
  loopscaleLend
    .command("list-strategies")
    .option("--json", "Print all strategies as JSON", false)
    .description(
      "List Loopscale lender strategies associated with the current GLAM state",
    )
    .action(async (options: { json?: boolean }) => {
      const strategies =
        await context.glamClient.loopscaleLend.fetchRegisteredStrategies();
      if (strategies.length === 0) {
        console.log("No Loopscale strategies found");
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(strategies, null, 2));
        return;
      }

      printTable(
        [
          "Strategy",
          "Lender",
          "Principal Mint",
          "Market",
          "Originations",
          "Token Balance",
          "Deployed",
          "Active Loans",
          "Terms",
        ],
        strategies.map((strategy) => [
          strategy.getAddress().toBase58(),
          strategy.lender.toBase58(),
          strategy.principalMint.toBase58(),
          strategy.marketInformation.toBase58(),
          strategy.originationsEnabled === 0 ? "disabled" : "enabled",
          strategy.tokenBalance.toString(),
          strategy.currentDeployedAmount.toString(),
          strategy.activeLoanCount.toString(),
          listStrategyCollateralTerms(strategy),
        ]),
      );
    });

  loopscaleLend
    .command("view-strategy")
    .argument("<strategy>", "Loopscale strategy account", validatePublicKey)
    .option("--json", "Print decoded strategy as JSON", false)
    .description("View a Loopscale lender strategy")
    .action(async (strategy: PublicKey, options: { json?: boolean }) => {
      const strategyAccount =
        await context.glamClient.loopscaleBorrow.fetchStrategy(strategy);
      if (options.json) {
        console.log(JSON.stringify(strategyAccount, null, 2));
        return;
      }

      let marketInfo: LoopscaleMarketInformation | undefined;
      try {
        marketInfo =
          await context.glamClient.loopscaleBorrow.fetchMarketInformation(
            strategyAccount.marketInformation,
          );
      } catch {
        marketInfo = undefined;
      }

      console.log(`Strategy: ${strategyAccount.getAddress()}`);
      console.log(`Lender: ${strategyAccount.lender}`);
      console.log(`Principal mint: ${strategyAccount.principalMint}`);
      console.log(`Market: ${strategyAccount.marketInformation}`);
      console.log(
        `Originations: ${
          strategyAccount.originationsEnabled === 0 ? "disabled" : "enabled"
        }`,
      );
      console.log(
        `External yield source: ${strategyAccount.externalYieldSource}`,
      );
      console.log(`Liquidity buffer cBPS: ${strategyAccount.liquidityBuffer}`);
      console.log(`Interest fee cBPS: ${strategyAccount.interestFee}`);
      console.log(`Origination fee cBPS: ${strategyAccount.originationFee}`);
      console.log(`Principal fee cBPS: ${strategyAccount.principalFee}`);
      console.log(`Origination cap: ${strategyAccount.originationCap}`);
      console.log(`Token balance: ${strategyAccount.tokenBalance}`);
      console.log(
        `Current deployed amount: ${strategyAccount.currentDeployedAmount}`,
      );
      console.log(
        `External yield amount: ${strategyAccount.externalYieldAmount}`,
      );
      console.log(
        `Outstanding interest amount: ${strategyAccount.outstandingInterestAmount}`,
      );
      console.log(`Fee claimable: ${strategyAccount.feeClaimable}`);
      console.log(`Active loan count: ${strategyAccount.activeLoanCount}`);
      console.log("");

      const rows = strategyTermRows(strategyAccount, marketInfo);
      if (rows.length === 0) {
        console.log("Collateral terms: []");
        return;
      }
      console.log("Collateral terms:");
      printTable(
        [
          "Collateral Index",
          "Duration Index",
          "APY cBPS",
          "Asset Identifier",
          "Quote Mint",
          "LTV cBPS",
          "LQT cBPS",
        ],
        rows,
      );
    });

  loopscaleLend
    .command("view-policy")
    .description("View Loopscale lending policy")
    .action(async () => {
      const { policy, error } = await fetchPolicyForView(
        "Lending",
        () => fetchRawLoopscalePolicyData(context, LOOPSCALE_LENDING_PROTOCOL),
        decodeLendingPolicyForView,
      );

      if (!policy && !error) {
        console.log("No lending policy found");
        process.exit(1);
      }

      console.log("Lending policy");
      if (error) {
        console.log(`  ${error}`);
        console.log(
          "  Use `loopscale-lend reset-policy` to replace the stale policy without decoding it.",
        );
      } else if (!policy) {
        console.log("  (not set)");
      } else {
        printPubkeyList(
          "Lending principal mints allowlist",
          policy.principalAllowlist,
        );
        printPubkeyList(
          "Lending collateral assets allowlist",
          policy.collateralAllowlist,
        );
        printTable(
          [
            "Market",
            "Max Deposit",
            "Max Total Deposit",
            "Min Loan APY (cbps)",
            "Max LTV (bps)",
            "Durations",
            "Collateral Assets",
          ],
          policy.marketPolicies.map((p) => [
            p.market.toBase58(),
            p.maxDepositAmount.toString(),
            p.maxTotalDepositAmount.toString(),
            String(p.minLoanApyCbps),
            String(p.maxLtvBps),
            p.durationIndexesAllowlist.join(",") || "-",
            p.collateralAssetAllowlist.map((a) => a.toBase58()).join(", ") ||
              "-",
          ]),
        );
        console.log(
          `Sell-ledger limits: maxDiscountBps=${policy.sellLedgerPolicy.maxDiscountBps} maxSlippageBps=${policy.sellLedgerPolicy.maxSlippageBps}`,
        );
      }
    });

  loopscaleLend
    .command("set-policy")
    .option(
      "--principal-allowlist <list>",
      "Comma- or space-separated principal token mint addresses or symbols",
      "",
    )
    .option(
      "--collateral-allowlist <list>",
      "Comma- or space-separated collateral asset identifiers, mint addresses, or symbols",
      "",
    )
    .option("--max-discount-bps <bps>", "Max sell-ledger discount in bps", "0")
    .option("--max-slippage-bps <bps>", "Max sell-ledger slippage in bps", "0")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Replace the full Loopscale lending policy without decoding the existing policy",
    )
    .action(async (options) => {
      const maxDiscountBps = parseBps(
        options.maxDiscountBps,
        "max-discount-bps",
      );
      const maxSlippageBps = parseBps(
        options.maxSlippageBps,
        "max-slippage-bps",
      );
      const principalAllowlist = await resolveOptionalTokenList(
        context,
        options.principalAllowlist,
      );
      const collateralAllowlist = await resolveOptionalTokenList(
        context,
        options.collateralAllowlist,
      );
      const policy = new LoopscaleLendingPolicy(
        principalAllowlist,
        collateralAllowlist,
        [],
        new LoopscaleSellLedgerPolicy(maxDiscountBps, maxSlippageBps),
      );

      const timelock = await readVaultTimelock(context);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleLend.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              "Confirm replacing Loopscale lending policy",
              `  principal allowlist: ${keysText(principalAllowlist, "all strategy creation, updates, deposits and ledger sales")}`,
              `  collateral allowlist: ${keysText(collateralAllowlist, "every strategy collateral asset")}`,
              `  sell-ledger limits: max discount ${maxDiscountBps} bps${maxDiscountBps === 0 ? " (requires no discount)" : ""}, max slippage ${maxSlippageBps} bps${maxSlippageBps === 0 ? " (allows no slippage)" : ""}`,
              MARKET_LIMITS_CLEARED,
            ].join("\n"),
          ),
        },
        timelock.outcome("Loopscale lending policy replaced"),
      );
    });

  loopscaleLend
    .command("reset-policy")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Reset Loopscale lending policy to an empty default without decoding the existing policy",
    )
    .action(async (options) => {
      const timelock = await readVaultTimelock(context);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleLend.setPolicy(
            new LoopscaleLendingPolicy(),
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            "Confirm resetting Loopscale lending policy",
          ),
        },
        timelock.outcome("Loopscale lending policy reset"),
      );
    });

  loopscaleLend
    .command("allowlist-token")
    .argument("<token>", "Principal token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a principal token to the lending allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleLendingPolicyToEdit(context, timelock);
      const policy = base.value ?? new LoopscaleLendingPolicy();
      if (policy.principalAllowlist.find((m) => m.equals(token))) {
        fail(
          `Principal token ${token} is already in the lending allowlist${base.stagedApart ? " as staged" : ""}`,
        );
      }

      policy.principalAllowlist.push(token);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleLend.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding lending principal token ${token}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Lending principal token ${token} added to allowlist`),
      );
    });

  loopscaleLend
    .command("remove-token")
    .argument("<token>", "Principal token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a principal token from the lending allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleLendingPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        fail(
          `No lending policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
      }
      if (!policy.principalAllowlist.find((m) => m.equals(token))) {
        fail(
          `Principal token not in lending allowlist${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
      }

      policy.principalAllowlist = policy.principalAllowlist.filter(
        (m) => !m.equals(token),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleLend.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing lending principal token ${token}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(
          `Lending principal token ${token} removed from allowlist`,
        ),
      );
    });

  loopscaleLend
    .command("allowlist-collateral")
    .argument("<asset>", "Collateral asset identifier, mint address, or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a collateral asset to the lending allowlist")
    .action(async (assetInput: string, options) => {
      const asset = await resolveTokenPublicKey(context.glamClient, assetInput);
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleLendingPolicyToEdit(context, timelock);
      const policy = base.value ?? new LoopscaleLendingPolicy();
      if (policy.collateralAllowlist.find((m) => m.equals(asset))) {
        fail(
          `Collateral asset ${asset} is already in the lending allowlist${base.stagedApart ? " as staged" : ""}`,
        );
      }

      policy.collateralAllowlist.push(asset);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleLend.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding lending collateral asset ${asset}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(
          `Lending collateral asset ${asset} added to allowlist`,
        ),
      );
    });

  loopscaleLend
    .command("remove-collateral")
    .argument("<asset>", "Collateral asset identifier, mint address, or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a collateral asset from the lending allowlist")
    .action(async (assetInput: string, options) => {
      const asset = await resolveTokenPublicKey(context.glamClient, assetInput);
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleLendingPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        fail(
          `No lending policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
      }
      if (!policy.collateralAllowlist.find((m) => m.equals(asset))) {
        fail(
          `Collateral asset not in lending allowlist${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
      }

      policy.collateralAllowlist = policy.collateralAllowlist.filter(
        (m) => !m.equals(asset),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleLend.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing lending collateral asset ${asset}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(
          `Lending collateral asset ${asset} removed from allowlist`,
        ),
      );
    });

  loopscaleLend
    .command("allowlist-market")
    .argument(
      "<market>",
      "Loopscale market information public key",
      validatePublicKey,
    )
    .requiredOption(
      "--max-deposit-amount-raw <amount>",
      "Max principal depositable per instruction (base units)",
    )
    .requiredOption(
      "--max-total-deposit-amount-raw <amount>",
      "Max principal exposure per strategy in this market (base units)",
    )
    .requiredOption(
      "--min-loan-apy-cbps <cbps>",
      "Min accepted loan APY for strategy terms, in centibasis points",
    )
    .requiredOption(
      "--max-ltv-bps <bps>",
      "Max accepted borrower LTV for strategy terms, in basis points",
    )
    .requiredOption(
      "--durations <list>",
      "Allowed duration indexes, comma- or space-separated (0=1d,1=1w,2=1m,3=3m,4=1y)",
    )
    .requiredOption(
      "--collateral-assets <list>",
      "Allowed collateral asset mints/symbols, comma- or space-separated",
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Add or update optional advanced risk limits for a lending market",
    )
    .action(async (market: PublicKey, options) => {
      const maxDepositAmount = parseNonNegativeU64(
        options.maxDepositAmountRaw,
        "max-deposit-amount-raw",
      );
      const maxTotalDepositAmount = parseNonNegativeU64(
        options.maxTotalDepositAmountRaw,
        "max-total-deposit-amount-raw",
      );
      const minLoanApyCbps = parseUnsignedNumber(
        options.minLoanApyCbps,
        "min-loan-apy-cbps",
        U32_MAX,
      );
      const maxLtvBps = parseBps(options.maxLtvBps, "max-ltv-bps");
      const durations = parseDurationIndexes(options.durations, "durations");
      const collateralAssets = await resolveCollateralAssetList(
        context,
        options.collateralAssets,
      );

      const timelock = await readVaultTimelock(context);
      const base = await loopscaleLendingPolicyToEdit(context, timelock);
      const policy = base.value ?? new LoopscaleLendingPolicy();
      const marketPolicy = new LoopscaleLendingMarketPolicy(
        market,
        maxDepositAmount,
        maxTotalDepositAmount,
        minLoanApyCbps,
        maxLtvBps,
        durations,
        collateralAssets,
      );
      const existingIndex = policy.marketPolicies.findIndex((p) =>
        p.market.equals(market),
      );
      const action = existingIndex >= 0 ? "updated" : "added";
      const previous =
        existingIndex >= 0
          ? lendingMarketFields(policy.marketPolicies[existingIndex])
          : undefined;
      if (existingIndex >= 0) {
        policy.marketPolicies[existingIndex] = marketPolicy;
      } else {
        policy.marketPolicies.push(marketPolicy);
      }

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleLend.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm ${action === "updated" ? "updating" : "adding"} lending market ${market}`,
              ...marketFieldLines(lendingMarketFields(marketPolicy), previous),
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Lending market ${market} ${action}`),
      );
    });

  loopscaleLend
    .command("remove-market")
    .argument(
      "<market>",
      "Loopscale market information public key",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove optional advanced risk limits for a lending market")
    .action(async (market: PublicKey, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleLendingPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        fail(
          `No lending policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
      }
      if (!policy.marketPolicies.find((p) => p.market.equals(market))) {
        fail(
          `Market not in lending policy${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
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
          context.glamClient.loopscaleLend.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing the limits of lending market ${market}:`,
              ...marketFieldLines(lendingMarketFields(removed)),
              "The market stays usable under the principal and collateral allowlists, with no per-market limit.",
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Limits of lending market ${market} removed`),
      );
    });

  loopscaleLend
    .command("set-sell-ledger-policy")
    .requiredOption(
      "--max-discount-bps <bps>",
      "Max discount from a ledger's expected value, in basis points",
    )
    .requiredOption(
      "--max-slippage-bps <bps>",
      "Max tolerated slippage while selling a ledger, in basis points",
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Set the lending sell-ledger discount and slippage limits")
    .action(async (options) => {
      const maxDiscountBps = parseBps(
        options.maxDiscountBps,
        "max-discount-bps",
      );
      const maxSlippageBps = parseBps(
        options.maxSlippageBps,
        "max-slippage-bps",
      );

      const timelock = await readVaultTimelock(context);
      const base = await loopscaleLendingPolicyToEdit(context, timelock);
      const policy = base.value ?? new LoopscaleLendingPolicy();
      policy.sellLedgerPolicy = new LoopscaleSellLedgerPolicy(
        maxDiscountBps,
        maxSlippageBps,
      );

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleLend.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              "Confirm updating sell-ledger limits",
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome("Sell-ledger limits updated"),
      );
    });

  loopscaleLend
    .command("create-strategy")
    .argument("<amount>", "Initial principal amount to deposit")
    .requiredOption(
      "--market <pubkey>",
      "Loopscale market information account",
      validatePublicKey,
    )
    .option(
      "--collateral-terms <term>",
      "Set a collateral term as <collateral-index|collateral-token>:<duration-index>:<apy-cbps>",
      (value, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--origination-cap <amount>",
      "Maximum principal amount that can be originated (defaults to amount)",
    )
    .option("--liquidity-buffer-cbps <n>", "Liquidity buffer in cBPS", "0")
    .option("--interest-fee-cbps <n>", "Interest fee in cBPS", "0")
    .option("--origination-fee-cbps <n>", "Origination fee in cBPS", "0")
    .option(
      "--principal-fee-cbps <n>",
      "Principal fee in cBPS (the create API supports only 0 and silently ignores the field; use the direct onchain path for a nonzero fee)",
      "0",
    )
    .option("--enable-originations", "Enable new originations", false)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Create and fund a Loopscale lender strategy (deprecated: builds through the Tars API route)",
    )
    .action(
      async (
        amount: string,
        options: {
          market: PublicKey;
          collateralTerms: string[];
          originationCap?: string;
          liquidityBufferCbps: string;
          interestFeeCbps: string;
          originationFeeCbps: string;
          principalFeeCbps: string;
          enableOriginations: boolean;
          yes: boolean;
        },
      ) => {
        console.warn(
          "Warning: create-strategy builds through the deprecated Tars API " +
            "route; current API responses include lookup-table setup this " +
            "CLI rejects before signing. A direct strategy-create command " +
            "ships with the forthcoming kit CLI; this CLI has no direct " +
            "create today (the SDK's txBuilder.createStrategyIx is the " +
            "build-only route). update-strategy and deposit-strategy here " +
            "handle lending terms and funding once a strategy exists.",
        );
        const {
          market,
          enableOriginations,
          originationFeeCbps,
          interestFeeCbps,
          principalFeeCbps,
          liquidityBufferCbps,
          yes,
        } = options;
        const marketInfo =
          await context.glamClient.loopscaleBorrow.fetchMarketInformation(
            market,
          );
        const { address, decimals, symbol } = await resolveTokenMint(
          context.glamClient,
          marketInfo.principalMint.toBase58(),
        );
        const principalMint = new PublicKey(address);
        const depositAmount = requireSafeIntegerAmount(
          parsePositiveUiAmount(amount, decimals, "amount"),
          "amount",
          "the Loopscale API",
        );
        // An empty value is read, and refused, like any other: only an option
        // left out takes the deposit amount as the cap.
        const originationCap =
          options.originationCap !== undefined
            ? requireSafeIntegerAmount(
                parseNonNegativeUiAmount(
                  options.originationCap,
                  decimals,
                  "origination-cap",
                ),
                "origination-cap",
                "the Loopscale API",
              )
            : depositAmount;
        const liquidityBuffer = parseCbps(
          liquidityBufferCbps,
          "liquidity-buffer-cbps",
        );
        const interestFee = parseCbps(interestFeeCbps, "interest-fee-cbps");
        const originationFee = parseCbps(
          originationFeeCbps,
          "origination-fee-cbps",
        );
        const principalFee = parseCbps(principalFeeCbps, "principal-fee-cbps");
        if (!principalFee.isZero()) {
          throw new Error(
            "--principal-fee-cbps is not supported by the create-strategy API, " +
              "which silently ignores the field; create the strategy with a " +
              "principal fee via the direct onchain path instead",
          );
        }

        const collateralTerms = await parseCollateralTermUpdates(
          context,
          marketInfo,
          options.collateralTerms,
        );

        const nonce = Keypair.generate();
        const strategy = context.glamClient.loopscaleLend.getStrategyPda(
          nonce.publicKey,
        );
        const principalLabel = `${amount} ${symbol}`;
        await executeTxWithErrorHandling(
          async () => {
            const { signatures } =
              await context.glamClient.loopscaleLend.createAndDepositStrategy(
                {
                  amount: depositAmount,
                  collateralTerms,
                  originationCap,
                  liquidityBuffer,
                  interestFee,
                  originationFee,
                  originationsEnabled: enableOriginations,
                  externalYieldSourceArgs: null,
                },
                {
                  nonce,
                  marketInformation: market,
                  principalMint,
                },
                context.txOptions,
              );
            return signatures.join(", ");
          },
          {
            skip: yes ?? false,
            message: [
              "Confirm creating Loopscale strategy and depositing",
              `strategy: ${strategy}`,
              `nonce: ${nonce.publicKey}`,
              `lender: ${context.glamClient.vaultPda}`,
              `market: ${market}`,
              `principal: ${principalLabel}`,
              `origination cap: ${originationCap.toString()} base units`,
              `liquidity buffer: ${liquidityBuffer.toString()} cBPS`,
              `interest fee: ${interestFee.toString()} cBPS`,
              `origination fee: ${originationFee.toString()} cBPS`,
              `originations enabled: ${enableOriginations}`,
              // The terms decide the rate at which the deposit is lent.
              ...collateralTermLines(marketInfo, collateralTerms),
            ].join("\n"),
          },
          (txSig) =>
            `Loopscale strategy ${strategy} created and funded with ${principalLabel}: ${txSig}`,
        );
      },
    );

  loopscaleLend
    .command("update-strategy")
    .requiredOption(
      "--strategy <pubkey>",
      "Existing Loopscale strategy account",
      validatePublicKey,
    )
    .option(
      "--collateral-term <term>",
      "Set a collateral term as <collateral-index|collateral-token>:<duration-index>:<apy-cbps>",
      (value, previous: string[] = []) => [...previous, value],
      [],
    )
    // Both forms declared: commander then leaves the value unset unless one
    // is given, and gives a lone flag no way to say false.
    .option("--originations-enabled", "Enable new originations")
    .option("--no-originations-enabled", "Disable new originations")
    .option(
      "--origination-cap <amount>",
      "Maximum principal amount to originate",
    )
    .option("--liquidity-buffer-cbps <n>", "Liquidity buffer in cBPS")
    .option("--interest-fee-cbps <n>", "Interest fee in cBPS")
    .option("--origination-fee-cbps <n>", "Origination fee in cBPS")
    .option("--principal-fee-cbps <n>", "Principal fee in cBPS")
    .option(
      "--external-yield-enabled",
      "Enable the Loopscale external yield source, and new originations with it",
    )
    .option(
      "--no-external-yield-enabled",
      "Disable the Loopscale external yield source, once the strategy holds no external yield",
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Update a Loopscale lender strategy")
    .action(
      async (options: {
        strategy: PublicKey;
        collateralTerm: string[];
        originationsEnabled?: boolean;
        originationCap?: string;
        liquidityBufferCbps?: string;
        interestFeeCbps?: string;
        originationFeeCbps?: string;
        principalFeeCbps?: string;
        externalYieldEnabled?: boolean;
        yes?: boolean;
      }) => {
        const {
          strategy,
          collateralTerm,
          originationsEnabled, // true: enable, false: disable, undefined: no change
          externalYieldEnabled, // true: enable, false: disable, undefined: no change
        } = options;
        if (externalYieldEnabled === true && originationsEnabled === false) {
          fail(
            "--external-yield-enabled enables new originations as well, so it cannot be given with --no-originations-enabled",
          );
        }

        const { strategy: strategyAccount, marketInfo } =
          await context.glamClient.loopscaleLend.fetchOwnedStrategyWithMarket(
            strategy,
          );
        const { mint } = await fetchMintAndTokenProgram(
          context.glamClient.connection,
          marketInfo.principalMint,
        );

        const collateralTerms = await parseCollateralTermUpdates(
          context,
          marketInfo,
          collateralTerm,
        );
        const params: LoopscaleApiUpdateStrategyParams = {};
        const changeLines: string[] = [];

        if (originationsEnabled !== undefined) {
          params.originationsEnabled = originationsEnabled;
          changeLines.push(
            `originations: ${originationsEnabled ? "enabled" : "disabled"}`,
          );
        }
        if (options.originationCap !== undefined) {
          const originationCap = parseNonNegativeUiAmount(
            options.originationCap,
            mint.decimals,
          );
          params.originationCap = bnToSafeNumber(originationCap);
          changeLines.push(
            `origination cap: ${originationCap.toString()} base units`,
          );
        }
        if (options.liquidityBufferCbps !== undefined) {
          const liquidityBuffer = parseCbps(options.liquidityBufferCbps);
          params.liquidityBuffer = bnToSafeNumber(liquidityBuffer);
          changeLines.push(
            `liquidity buffer: ${liquidityBuffer.toString()} cBPS`,
          );
        }
        if (options.interestFeeCbps !== undefined) {
          const interestFee = parseCbps(options.interestFeeCbps);
          params.interestFee = bnToSafeNumber(interestFee);
          changeLines.push(`interest fee: ${interestFee.toString()} cBPS`);
        }
        if (options.originationFeeCbps !== undefined) {
          const originationFee = parseCbps(options.originationFeeCbps);
          params.originationFee = bnToSafeNumber(originationFee);
          changeLines.push(
            `origination fee: ${originationFee.toString()} cBPS`,
          );
        }
        if (options.principalFeeCbps !== undefined) {
          const principalFee = parseCbps(options.principalFeeCbps);
          params.principalFee = bnToSafeNumber(principalFee);
          changeLines.push(`principal fee: ${principalFee.toString()} cBPS`);
        }
        if (externalYieldEnabled !== undefined && externalYieldEnabled) {
          if (strategyAccount.externalYieldSource === 1) {
            fail(`Strategy ${strategy} already has external yield source 1`);
          }
          if (strategyAccount.externalYieldSource !== 0) {
            fail(
              `Strategy ${strategy} has unsupported external yield source ${strategyAccount.externalYieldSource}`,
            );
          }

          params.externalYieldSource = {
            newExternalYieldSource: 1,
          };
          if (params.originationsEnabled !== true) {
            params.originationsEnabled = true;
            changeLines.push("originations: enabled");
          }
          changeLines.push("external yield source: 1");
        }
        if (externalYieldEnabled !== undefined && !externalYieldEnabled) {
          if (strategyAccount.externalYieldSource === 0) {
            fail(`Strategy ${strategy} already has external yield source 0`);
          }
          if (!strategyAccount.externalYieldAmount.isZero()) {
            fail(
              `Strategy ${strategy} still has external yield amount ${strategyAccount.externalYieldAmount}; withdraw external yield before disabling idle capital.`,
            );
          }

          params.externalYieldSource = {
            newExternalYieldSource: 0,
          };
          changeLines.push("external yield source: 0");
        }

        changeLines.push(...collateralTermLines(marketInfo, collateralTerms));

        const hasParams = Object.keys(params).length > 0;
        const apiCollateralTerms = buildLoopscaleApiCollateralTermUpdates(
          strategyAccount,
          marketInfo,
          collateralTerms,
        );
        if (!hasParams && collateralTerms.length === 0) {
          fail("No strategy updates requested");
        }

        await executeTxWithErrorHandling(
          async () =>
            (
              await context.glamClient.loopscaleLend.updateStrategy(
                {
                  strategy,
                  collateralTerms: apiCollateralTerms,
                  updateParams: hasParams ? params : undefined,
                },
                context.txOptions,
              )
            ).join(", "),
          {
            skip: options.yes ?? false,
            message: [
              "Confirm Loopscale update-strategy",
              `strategy: ${strategy}`,
              `principal mint: ${strategyAccount.principalMint}`,
              ...changeLines,
            ].join("\n"),
          },
          (txSigs) => `Loopscale strategy ${strategy} updated: ${txSigs}`,
        );
      },
    );

  loopscaleLend
    .command("deposit-strategy")
    .argument("<strategy>", "Loopscale strategy account", validatePublicKey)
    .argument("<amount>", "Principal amount to deposit")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Deposit principal liquidity into a Loopscale strategy")
    .action(
      async (
        strategy: PublicKey,
        amount: string,
        options: { yes?: boolean },
      ) => {
        const { strategy: strategyAccount, marketInfo } =
          await context.glamClient.loopscaleLend.fetchOwnedStrategyWithMarket(
            strategy,
          );
        const { mint } = await fetchMintAndTokenProgram(
          context.glamClient.connection,
          marketInfo.principalMint,
        );
        const depositAmount = requireSafeIntegerAmount(
          parsePositiveUiAmount(amount, mint.decimals, "amount"),
          "amount",
          "the Loopscale API",
        );

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.loopscaleLend.depositStrategy(
              depositAmount,
              {
                strategy,
                principalMint: strategyAccount.principalMint,
                marketInformation: strategyAccount.marketInformation,
              },
              context.txOptions,
            ),
          {
            skip: options.yes ?? false,
            message: [
              "Confirm Loopscale deposit-strategy",
              `strategy: ${strategy}`,
              `principal mint: ${strategyAccount.principalMint}`,
              `amount: ${amount}`,
            ].join("\n"),
          },
          (txSig) =>
            `Deposited ${amount} into Loopscale strategy ${strategy}: ${txSig}`,
        );
      },
    );

  loopscaleLend
    .command("withdraw-strategy")
    .argument("<strategy>", "Loopscale strategy account", validatePublicKey)
    .argument("<amount>", "Principal amount to withdraw, or 'all'")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Withdraw undeployed principal from a Loopscale strategy")
    .action(
      async (
        strategy: PublicKey,
        amount: string,
        options: { yes: boolean },
      ) => {
        const strategyAccount =
          await context.glamClient.loopscaleLend.fetchOwnedStrategy(strategy);
        const { principalMint, marketInformation } = strategyAccount;

        const { mint } = await fetchMintAndTokenProgram(
          context.glamClient.connection,
          principalMint,
        );
        const withdrawAll = amount === "all";
        const withdrawAmount = withdrawAll
          ? new BN(0)
          : requireSafeIntegerAmount(
              parsePositiveUiAmount(amount, mint.decimals, "amount"),
              "amount",
              "the Loopscale API",
            );
        // 'all' takes the strategy's token balance and leaves its external
        // yield, which only an amount reaches; the SDK refuses either case
        // past what the strategy holds, after the confirmation.
        const { tokenBalance, externalYieldAmount } = strategyAccount;
        if (withdrawAll && tokenBalance.isZero()) {
          fail(
            `withdraw-strategy all takes the strategy's undeployed principal, and its token balance is 0${externalYieldAmount.isZero() ? "" : `; give an amount to withdraw its ${formatUiAmount(externalYieldAmount, mint.decimals)} of external yield`}`,
          );
        }
        const withdrawable = tokenBalance.add(externalYieldAmount);
        if (!withdrawAll && withdrawAmount.gt(withdrawable)) {
          fail(
            `withdraw-strategy takes at most the strategy's token balance and external yield, ${formatUiAmount(withdrawable, mint.decimals)}, and amount is ${amount}`,
          );
        }

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.loopscaleLend.withdrawStrategy(
              withdrawAmount,
              withdrawAll,
              {
                strategy,
                principalMint,
                marketInformation,
              },
              context.txOptions,
            ),
          {
            skip: options.yes ?? false,
            message: [
              "Confirm Loopscale withdraw-strategy",
              `strategy: ${strategy}`,
              `principal mint: ${principalMint}`,
              withdrawAll
                ? `amount: all of the token balance, ${formatUiAmount(tokenBalance, mint.decimals)}`
                : `amount: ${amount}`,
              ...(withdrawAll && !externalYieldAmount.isZero()
                ? [
                    `external yield: ${formatUiAmount(externalYieldAmount, mint.decimals)} stays in the strategy; give an amount to withdraw it`,
                  ]
                : []),
            ].join("\n"),
          },
          (txSig) =>
            `Withdrew ${withdrawAll ? "all available principal" : amount} from Loopscale strategy ${strategy}: ${txSig}`,
        );
      },
    );

  loopscaleLend
    .command("close-strategy")
    .argument(
      "<strategy>",
      "Empty Loopscale strategy account",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Close an empty Loopscale strategy account")
    .action(async (strategy: PublicKey, options: { yes?: boolean }) => {
      const strategyAccount =
        await context.glamClient.loopscaleLend.fetchOwnedStrategy(strategy);
      context.glamClient.loopscaleLend.assertStrategyClosable(strategyAccount);

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleLend.closeStrategy(
            {
              strategy,
              principalMint: strategyAccount.principalMint,
            },
            context.txOptions,
          ),
        {
          skip: options.yes ?? false,
          message: [
            "Confirm Loopscale close-strategy",
            `strategy: ${strategy}`,
            `principal mint: ${strategyAccount.principalMint}`,
          ].join("\n"),
        },
        (txSig) => `Loopscale strategy ${strategy} closed: ${txSig}`,
      );
    });
}
