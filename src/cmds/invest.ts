import { BN } from "@coral-xyz/anchor";
import { GlamClient, fetchMintAndTokenProgram } from "@glamsystems/glam-sdk";
import { type Command } from "commander";
import { type PublicKey } from "@solana/web3.js";
import {
  type CliContext,
  executeTxWithErrorHandling,
  printableText,
  recordSentSignatures,
} from "../utils";
import { parsePositiveUiAmount, validatePublicKey } from "../parsing";
import tokens from "../tokens-verified.json";

/** The vault a command acts on, and where the CLI took it from. */
function vaultNamed(
  name: string,
  state: PublicKey,
  shareMint: PublicKey,
  fromConfig: boolean,
): string {
  return `vault${name ? ` ${printableText(name)}` : ""} (state ${state}, share mint ${shareMint}${fromConfig ? "; the active vault in the CLI config" : ""})`;
}

export function installInvestCommands(invest: Command, context: CliContext) {
  invest
    .command("subscribe")
    .argument("<amount>", "UI amount to subscribe")
    .argument(
      "[state]",
      "State pubkey of the vault to subscribe to. Leave empty to use the active GLAM in CLI config.",
      validatePublicKey,
    )
    .description("Subscribe to a tokenized vault")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .option("-q, --queued", "Subscribe to a tokenized vault in queued mode")
    .action(async (amount, state, options) => {
      let glamClient = context.glamClient;
      if (state) {
        glamClient = new GlamClient({
          provider: context.glamClient.provider,
          cluster: context.cliConfig.cluster,
          statePda: state,
          // The same transaction version the session was started with.
          transactionVersion: context.glamClient.transactionVersion,
        });
        recordSentSignatures(glamClient);
      }

      const stateModel = await glamClient.fetchStateModel();
      const minSubscription = new BN(
        stateModel?.mintModel?.minSubscription || 0,
      );

      const { baseAssetMint, baseAssetDecimals } = stateModel;

      const metadata = tokens.find(
        (t) => t.address === baseAssetMint.toString(),
      );
      if (!metadata) {
        console.warn(`Base asset ${baseAssetMint} is unverified`);
      }
      const name = metadata?.name || baseAssetMint.toBase58();
      const symbol = metadata?.symbol || "Unknown token";

      const amountBN = parsePositiveUiAmount(
        amount,
        baseAssetDecimals,
        "amount",
      );
      if (amountBN.lt(minSubscription)) {
        console.error(
          `Amount must be at least ${minSubscription.toNumber() / 10 ** baseAssetDecimals} ${symbol}`,
        );
        process.exit(1);
      }

      const preInstructions = await glamClient.price.priceVaultIxs(); // this loads lookup tables
      const lookupTables = glamClient.price.lookupTables;

      await executeTxWithErrorHandling(
        () =>
          glamClient.invest.subscribe(amountBN, !!options?.queued, {
            ...context.txOptions,
            preInstructions: options?.queued ? [] : preInstructions, // queued subscription does not need pricing ixs
            lookupTables,
          }),
        {
          skip: options?.yes,
          message: `Confirm ${options?.queued ? "queued" : "instant"} subscription with ${amount} ${symbol} (${name}) to ${vaultNamed(stateModel.nameStr, glamClient.statePda, glamClient.mintPda, !state)}?`,
        },
        (txSig) =>
          `${glamClient.signer} ${options?.queued ? "queued" : "instant"} subscription: ${txSig}`,
      );
    });

  invest
    .command("claim-subscription")
    .description(
      "Claim subscription and receive share tokens. Only needed for queued subscriptions.",
    )
    .action(async () => {
      const preInstructions = await context.glamClient.price.priceVaultIxs();
      const lookupTables = context.glamClient.price.lookupTables;

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.invest.claim({
            ...context.txOptions,
            preInstructions,
            lookupTables,
          }),
        { skip: true },
        (txSig) => `${context.glamClient.signer} claimed shares: ${txSig}`,
      );
    });

  invest
    .command("redeem")
    .argument("<amount>", "UI amount of shares to redeem")
    .description("Request to redeem share tokens")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .action(async (amount, options) => {
      const { mint } = await fetchMintAndTokenProgram(
        context.glamClient.connection,
        context.glamClient.mintPda,
      );
      const decimals = mint.decimals;
      const amountBN = parsePositiveUiAmount(amount, decimals, "amount");

      const stateModel = await context.glamClient.fetchStateModel();
      const minRedemption = new BN(stateModel?.mintModel?.minRedemption || 0);

      if (amountBN.lt(minRedemption)) {
        console.error(
          `Amount must be at least ${minRedemption.toNumber() / 10 ** decimals} shares`,
        );
        process.exit(1);
      }

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.invest.queuedRedeem(amountBN, context.txOptions),
        {
          skip: options?.yes,
          message: `Confirm queued redemption of ${amount} shares of ${vaultNamed(stateModel.nameStr, context.glamClient.statePda, context.glamClient.mintPda, true)}`,
        },
        (txSig) => `${context.glamClient.signer} requested to redeem: ${txSig}`,
      );
    });

  invest
    .command("claim-redemption")
    .description("Claim redemption to receive deposit asset")
    .action(async () => {
      const preInstructions = await context.glamClient.price.priceVaultIxs(); // this loads lookup tables
      const lookupTables = context.glamClient.price.lookupTables;

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.invest.claim({
            ...context.txOptions,
            preInstructions,
            lookupTables,
          }),
        { skip: true },
        (txSig) => `${context.glamClient.signer} claimed tokens: ${txSig}`,
      );
    });

  invest
    .command("cancel-request")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Cancel a queued subscription or redemption request that has not been fulfilled",
    )
    .action(async (options) => {
      const stateModel = await context.glamClient.fetchStateModel();
      await executeTxWithErrorHandling(
        () => context.glamClient.invest.cancel(context.txOptions),
        {
          skip: options?.yes,
          message: `Confirm canceling the queued subscription or redemption in ${vaultNamed(stateModel.nameStr, context.glamClient.statePda, context.glamClient.mintPda, true)}?`,
        },
        (txSig) =>
          `${context.glamClient.signer} cancelled queued request: ${txSig}`,
      );
    });
}
