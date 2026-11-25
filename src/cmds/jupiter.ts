import {
  JUPITER_SWAP_PROTOCOL,
  JUPITER_V1_MAX_QUOTE_ACCOUNTS,
  JupiterSwapPolicy,
  type QuoteParams,
  type TokenListItem,
} from "@glamsystems/glam-sdk";
import { type Command } from "commander";
import {
  type CliContext,
  executeTxWithErrorHandling,
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
  parseInteger,
  parsePositiveInteger,
  parsePositiveUiAmount,
  requireSafeIntegerAmount,
  validatePublicKey,
} from "../parsing";

// The swap policy and Jupiter's route both hold slippage as a u16.
function parseSlippageBps(value: string): number {
  const slippageBps = parseBps(value, "slippage-bps");
  if (slippageBps === 0) {
    fail("slippage-bps must be a positive integer");
  }
  return slippageBps;
}

function buildQuoteParams(
  tokenFrom: TokenListItem,
  tokenTo: TokenListItem,
  amount: string | number,
  options: {
    maxAccounts?: string;
    slippageBps: string;
    onlyDirectRoutes?: boolean;
    instructionVersion: "V1" | "V2";
  },
): QuoteParams {
  const { maxAccounts, slippageBps, onlyDirectRoutes, instructionVersion } =
    options;

  const amountIn = requireSafeIntegerAmount(
    parsePositiveUiAmount(`${amount}`, tokenFrom.decimals, "amount"),
    "amount",
    "the Jupiter quote API",
  );

  return {
    inputMint: tokenFrom.address,
    outputMint: tokenTo.address,
    amount: amountIn.toNumber(),
    swapMode: "ExactIn",
    slippageBps: parseSlippageBps(slippageBps),
    excludeDexes: ["Obric V2"],
    asLegacyTransaction: false,
    // An option given with an empty value is read, and refused, like any
    // other: it is not the same as an option left out.
    ...(maxAccounts !== undefined
      ? { maxAccounts: parsePositiveInteger(maxAccounts, "max-accounts") }
      : {}),
    ...(onlyDirectRoutes ? { onlyDirectRoutes } : {}),
    instructionVersion,
  };
}

/**
 * The account cap the quote is asked with. On a version 1 transaction the SDK
 * asks Jupiter for at most 40 accounts, the given cap or not.
 */
function quoteAccountsLines(
  context: CliContext,
  quoteParams: QuoteParams,
): string[] {
  const version = context.glamClient.resolveTransactionVersion(
    context.txOptions.transactionVersion,
  );
  if (version !== 1) {
    return [];
  }
  const asked = Math.min(
    quoteParams.maxAccounts ?? JUPITER_V1_MAX_QUOTE_ACCOUNTS,
    JUPITER_V1_MAX_QUOTE_ACCOUNTS,
  );
  const given =
    quoteParams.maxAccounts !== undefined &&
    quoteParams.maxAccounts > JUPITER_V1_MAX_QUOTE_ACCOUNTS
      ? `${quoteParams.maxAccounts} given; `
      : "";
  return [
    `Max accounts asked of the quote: ${asked} (${given}a version 1 transaction holds no more of a route)`,
  ];
}

// What a swap that failed with nothing sent is told. A quote that already
// asked for direct routes is told nothing.
function onlyDirectRoutesAdvice(
  quoteParams: QuoteParams,
  operationLabel: string,
): string | undefined {
  return quoteParams.onlyDirectRoutes
    ? undefined
    : `Suggestion: retry ${operationLabel} with --only-direct-routes.`;
}

// The cap allowlist-token gives a policy it creates.
const DEFAULT_MAX_SLIPPAGE_BPS = 50;

/**
 * What a setter writes, for its confirmation: the policy it creates when the
 * vault has none, or the fields the policy then holds.
 */
function policySentLine(policy: JupiterSwapPolicy, created: boolean): string {
  const count = policy.swapAllowlist?.length ?? 0;
  const fields = [
    `max slippage ${policy.maxSlippageBps} BPS${policy.maxSlippageBps === 0 ? " (no swap this CLI sends passes it)" : ""}`,
    `max deviation ${policy.maxDeviationBps} BPS`,
    `${count} token${count === 1 ? "" : "s"} on the swap allowlist`,
  ].join(", ");
  return created
    ? `The vault has no Jupiter swap policy; this creates one with ${fields}.`
    : `The policy then holds ${fields}.`;
}

/** The Jupiter swap policy an edit replaces: the staged one under a timelock that holds one. */
async function jupiterSwapPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => context.glamClient.jupiterSwap.fetchPolicy(),
    () => context.glamClient.protocolProgram.programId,
    JUPITER_SWAP_PROTOCOL,
    JupiterSwapPolicy.decode,
  );
}

export function installJupiterSwapCommands(
  program: Command,
  context: CliContext,
) {
  program
    .command("view-policy")
    .description("View Jupiter swap policy")
    .action(async () => {
      const policy = await context.glamClient.jupiterSwap.fetchPolicy();
      if (!policy) {
        console.log("No policy found");
        process.exit(1);
      }
      console.log(`Max slippage BPS: ${policy.maxSlippageBps}`);
      console.log(`Max deviation BPS: ${policy.maxDeviationBps}`);
      printPubkeyList("Swap allowlist", policy.swapAllowlist ?? []);
    });

  program
    .command("set-max-slippage")
    .argument(
      "<slippage-bps>",
      "Maximum slippage in basis points",
      parseSlippageBps,
    )
    .option("-y, --yes", "Skip confirmation", false)
    .description("Set the maximum allowed slippage for swaps")
    .action(async (slippageBps, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await jupiterSwapPolicyToEdit(context, timelock);
      const policy = base.value;
      const currentAllowlist = policy?.swapAllowlist || [];
      const currentMaxDeviation = policy?.maxDeviationBps || 0;

      const newPolicy = new JupiterSwapPolicy(
        slippageBps,
        currentAllowlist,
        currentMaxDeviation,
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterSwap.setPolicy(
            newPolicy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm setting max slippage to ${slippageBps} BPS`,
              policySentLine(newPolicy, policy === null),
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter swap policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Max slippage set to ${slippageBps} BPS`),
      );
    });

  program
    .command("set-max-deviation")
    .argument(
      "<deviation-bps>",
      "Maximum quote price deviation in basis points (range: -32768 to 32767; 0 requires quote to match or beat oracle, negative requires the quote to beat oracle by at least that many bps)",
      (raw) => {
        return parseInteger(raw, "deviation-bps", -32768, 32767);
      },
    )
    .option("-y, --yes", "Skip confirmation", false)
    .description("Set the maximum allowed quote price deviation for swaps")
    .action(async (deviationBps, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await jupiterSwapPolicyToEdit(context, timelock);
      const policy = base.value;
      const currentAllowlist = policy?.swapAllowlist || [];
      const currentMaxSlippage = policy?.maxSlippageBps || 0;

      const newPolicy = new JupiterSwapPolicy(
        currentMaxSlippage,
        currentAllowlist,
        deviationBps,
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterSwap.setPolicy(
            newPolicy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm setting max deviation to ${deviationBps} BPS`,
              policySentLine(newPolicy, policy === null),
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter swap policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Max deviation set to ${deviationBps} BPS`),
      );
    });

  program
    .command("allowlist-token")
    .alias("allowlist-mint")
    .argument("<token>", "Token mint address or symbol")
    .option("-y, --yes", "Skip confirmation", false)
    .description("Add a token to the swap allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await jupiterSwapPolicyToEdit(context, timelock);
      const policy = base.value;
      // A stored cap of 0 refuses every swap; `|| 50` raised it to 50.
      const currentSlippage = policy
        ? policy.maxSlippageBps
        : DEFAULT_MAX_SLIPPAGE_BPS;
      const currentAllowlist = policy?.swapAllowlist || [];

      if (currentAllowlist.find((t) => t.equals(token))) {
        console.error(
          `Token ${token} is already in the allowlist${base.stagedApart ? " as staged" : ""}`,
        );
        process.exit(1);
      }

      const newAllowlist = [...currentAllowlist, token];
      const newPolicy = new JupiterSwapPolicy(
        currentSlippage,
        newAllowlist,
        policy?.maxDeviationBps || 0,
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterSwap.setPolicy(
            newPolicy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding token ${token} to swap allowlist`,
              policySentLine(newPolicy, policy === null),
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter swap policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Token ${token} added to swap allowlist`),
      );
    });

  program
    .command("remove-token")
    .alias("remove-mint")
    .argument("<token>", "Token mint address or symbol")
    .option("-y, --yes", "Skip confirmation", false)
    .description("Remove a token from the swap allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await jupiterSwapPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy || !policy.swapAllowlist) {
        console.error(
          `No swap allowlist found${base.stagedApart ? " in the staged change" : ""}`,
        );
        process.exit(1);
      }

      if (!policy.swapAllowlist.find((t) => t.equals(token))) {
        console.error(
          `Token not in allowlist${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
        process.exit(1);
      }

      const newAllowlist = policy.swapAllowlist.filter((t) => !t.equals(token));
      const newPolicy = new JupiterSwapPolicy(
        policy.maxSlippageBps,
        newAllowlist.length > 0 ? newAllowlist : null,
        policy.maxDeviationBps,
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterSwap.setPolicy(
            newPolicy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing token ${token} from swap allowlist`,
              policySentLine(newPolicy, false),
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter swap policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Token ${token} removed from swap allowlist`),
      );
    });

  program
    .command("clear-allowlist")
    .option("-y, --yes", "Skip confirmation", false)
    .description("Clear the swap allowlist")
    .action(async (options) => {
      const timelock = await readVaultTimelock(context);
      const base = await jupiterSwapPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        console.error(
          `No policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
        process.exit(1);
      }
      const newPolicy = new JupiterSwapPolicy(
        policy.maxSlippageBps,
        null,
        policy.maxDeviationBps,
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterSwap.setPolicy(
            newPolicy,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              "Confirm clearing swap allowlist",
              policySentLine(newPolicy, false),
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter swap policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome("Swap allowlist cleared"),
      );
    });

  program
    .command("swap")
    .description("Swap assets held in the vault")
    .argument("<from>", "Source token mint or symbol")
    .argument("<to>", "Destination token mint or symbol")
    .argument("<amount>", "Decimal-adjusted UI amount")
    .option("-m, --max-accounts <num>", "Specify max accounts allowed")
    .option(
      "-s, --slippage-bps <bps>",
      "Slippage bps, defaults to 5 (0.05%)",
      "5",
    )
    .option("--use-v1", "Use v1 instruction (default: v2)", false)
    .option("-d, --only-direct-routes", "Direct routes only")
    .option(
      "-t, --tracking-account <pubkey>",
      "Tracking account public key",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation", false)
    .action(async (from, to, amount, options) => {
      const tokenFrom = await resolveTokenMint(context.glamClient, from);
      const tokenTo = await resolveTokenMint(context.glamClient, to);
      const {
        maxAccounts,
        slippageBps,
        onlyDirectRoutes,
        useV1,
        trackingAccount,
      } = options;

      const quoteParams = buildQuoteParams(tokenFrom, tokenTo, amount, {
        maxAccounts,
        slippageBps,
        onlyDirectRoutes,
        instructionVersion: useV1 ? "V1" : "V2",
      });

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterSwap.swap(
            { quoteParams, trackingAccount },
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: [
            `Confirm swapping ${amount} ${tokenFrom.symbol} to ${tokenTo.symbol} with quote params: ${JSON.stringify(
              quoteParams,
              null,
              2,
            )}`,
            ...quoteAccountsLines(context, quoteParams),
          ].join("\n"),
        },
        (txSig) =>
          `Swapped ${amount} ${tokenFrom.symbol} to ${tokenTo.symbol}: ${txSig}`,
        onlyDirectRoutesAdvice(quoteParams, "swap"),
      );
    });

  program
    .command("swap-v2")
    .description("Swap assets held in the vault using jupiter_swap_v2")
    .argument("<from>", "Source token mint or symbol")
    .argument("<to>", "Destination token mint or symbol")
    .argument("<amount>", "Decimal-adjusted UI amount")
    .option("-m, --max-accounts <num>", "Specify max accounts allowed")
    .option(
      "-s, --slippage-bps <bps>",
      "Slippage bps, defaults to 5 (0.05%)",
      "5",
    )
    .option("-d, --only-direct-routes", "Direct routes only")
    .option(
      "--skip-quote-price-check",
      "Skip the oracle quote price check when the signer has permission",
      false,
    )
    .option(
      "-t, --tracking-account <pubkey>",
      "Tracking account public key",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation", false)
    .action(async (from, to, amount, options) => {
      const tokenFrom = await resolveTokenMint(context.glamClient, from);
      const tokenTo = await resolveTokenMint(context.glamClient, to);
      const {
        maxAccounts,
        slippageBps,
        onlyDirectRoutes,
        skipQuotePriceCheck,
        trackingAccount,
      } = options;

      const quoteParams = buildQuoteParams(tokenFrom, tokenTo, amount, {
        maxAccounts,
        slippageBps,
        onlyDirectRoutes,
        instructionVersion: "V2",
      });

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterSwap.swapV2(
            { quoteParams, skipQuotePriceCheck, trackingAccount },
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: [
            `Confirm swapping ${amount} ${tokenFrom.symbol} to ${tokenTo.symbol} with jupiter_swap_v2 and quote params: ${JSON.stringify(
              quoteParams,
              null,
              2,
            )}`,
            ...quoteAccountsLines(context, quoteParams),
            // jupiter_swap_v2 skips the oracle deviation check of the quote
            // when the flag is set and the signer's permission allows it.
            ...(skipQuotePriceCheck
              ? [
                  "Oracle quote price check: skipped (--skip-quote-price-check) for a signer holding SkipQuotePriceCheck, or SkipQuotePriceCheckLimited when the output token has no oracle",
                ]
              : []),
          ].join("\n"),
        },
        (txSig) =>
          `Swapped ${amount} ${tokenFrom.symbol} to ${tokenTo.symbol} with jupiter_swap_v2: ${txSig}`,
        onlyDirectRoutesAdvice(quoteParams, "swap-v2"),
      );
    });
}
