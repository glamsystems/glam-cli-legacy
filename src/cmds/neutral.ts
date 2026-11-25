import { type BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { type Command } from "commander";
import {
  type CliContext,
  executeTxWithErrorHandling,
  resolveTokenMint,
  validatePublicKey,
} from "../utils";
import {
  parsePositiveBn,
  parsePositiveUiAmount,
  parseUnsignedNumber,
} from "../parsing";
import {
  DEFAULT_NEUTRAL_WITHDRAWAL_MAX_DEVIATION_BPS,
  NT_BUNDLE_PROTOCOL,
  NtBundlePolicy,
  U128_MAX_BN,
} from "@glamsystems/glam-sdk";
import { fail } from "../errors";
import {
  editsStagedLine,
  readVaultTimelock,
  type VaultTimelock,
} from "../staging";

/** The NT bundle policy an edit replaces: the staged one under a timelock that holds one. */
async function neutralPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => context.glamClient.neutral.fetchPolicy(),
    () => context.glamClient.extNeutralProgram.programId,
    NT_BUNDLE_PROTOCOL,
    NtBundlePolicy.decode,
  );
}

export function installNeutralCommands(neutral: Command, context: CliContext) {
  neutral
    .command("view-policy")
    .description("View NT bundle policy")
    .action(async () => {
      const policy = await context.glamClient.neutral.fetchPolicy();
      if (!policy) {
        console.log("No policy found");
        return;
      }

      console.log("NT bundles allowlist:");
      for (let i = 0; i < policy.bundlesAllowlist.length; i++) {
        console.log(`[${i}] ${policy.bundlesAllowlist[i]}`);
      }
    });

  neutral
    .command("allowlist-bundle")
    .argument("<bundle>", "NT bundle public key", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a NT bundle to the allowlist")
    .action(async (bundle: PublicKey, options: { yes?: boolean }) => {
      // The SDK's allowlistBundle adds to the live policy. Under a timelock a
      // second addition then replaced the first one staged.
      const timelock = await readVaultTimelock(context);
      const base = await neutralPolicyToEdit(context, timelock);
      const policy = base.value ?? new NtBundlePolicy([]);
      if (policy.bundlesAllowlist.find((b) => b.equals(bundle))) {
        fail(
          `NT bundle ${bundle} is already in the allowlist${base.stagedApart ? " as staged" : ""}`,
        );
      }

      policy.bundlesAllowlist.push(bundle);
      await executeTxWithErrorHandling(
        () => context.glamClient.neutral.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes ?? false,
          message: timelock.confirm(
            [
              `Confirm adding NT bundle ${bundle} to allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the NT bundle allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`NT bundle ${bundle} added to allowlist`),
      );
    });

  neutral
    .command("init-depositor")
    .argument("<bundle>", "NT bundle public key", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Initialize a NT user bundle account")
    .action(async (bundle: PublicKey, options: { yes?: boolean }) => {
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.neutral.initializeBundleDepositor(
            bundle,
            context.txOptions,
          ),
        {
          skip: options?.yes ?? false,
          message: `Confirm initializing depositor for NT bundle ${bundle}`,
        },
        (txSig) => `NT bundle depositor initialized: ${txSig}`,
      );
    });

  neutral
    .command("deposit")
    .alias("request-deposit")
    .argument("<bundle>", "NT bundle public key", validatePublicKey)
    .argument("<amount>", "UI amount of the bundle asset to deposit")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Request a NT bundle deposit from the GLAM vault")
    .action(
      async (bundle: PublicKey, amount: string, options: { yes?: boolean }) => {
        const { assetAddress, assetDecimals } =
          await context.glamClient.neutral.fetchBundle(bundle);
        const mint = await resolveTokenMint(
          context.glamClient,
          assetAddress.toBase58(),
        );
        if (mint.decimals !== assetDecimals) {
          throw new Error(
            `Mint decimals ${mint.decimals} does not match bundle asset decimals ${assetDecimals}`,
          );
        }

        // Read from the user's own text, before the confirmation shows it.
        const depositAmount = parsePositiveUiAmount(
          amount,
          mint.decimals,
          "amount",
        );

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.neutral.requestDeposit(
              bundle,
              depositAmount,
              context.txOptions,
            ),
          {
            skip: options?.yes ?? false,
            message: `Confirm depositing ${amount.trim()} ${mint.symbol} to NT bundle ${bundle}`,
          },
          (txSig) => `NT bundle deposit requested: ${txSig}`,
        );
      },
    );

  neutral
    .command("withdraw")
    .alias("request-withdrawal")
    .argument("<bundle>", "NT bundle public key", validatePublicKey)
    .argument(
      "<shares-amount>",
      "Raw NT bundle shares amount to withdraw",
      // A u128 on the wire, so it is read as a big integer: a JavaScript
      // number rounds an integer past 2^53 - 1.
      (value: string) => parsePositiveBn(value, "shares-amount", U128_MAX_BN),
    )
    .option(
      "-m, --max-deviation <bps>",
      "Maximum deviation from estimated value (in basis points)",
      (value: string) => parseUnsignedNumber(value, "max-deviation", 10_000),
      DEFAULT_NEUTRAL_WITHDRAWAL_MAX_DEVIATION_BPS,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Request a NT bundle withdrawal from the GLAM vault")
    .action(
      async (
        bundle: PublicKey,
        sharesAmount: BN,
        options: {
          maxDeviation: number;
          yes?: boolean;
        },
      ) => {
        const estimate =
          await context.glamClient.neutral.estimateWithdrawalValue(
            bundle,
            sharesAmount,
            options.maxDeviation,
          );

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.neutral.requestWithdrawal(
              bundle,
              sharesAmount,
              estimate.minEstimatedValue,
              context.txOptions,
            ),
          {
            skip: options?.yes ?? false,
            message: `Confirm requesting withdrawal of ${sharesAmount} shares from bundle ${bundle} with minimum estimated value ${estimate.minEstimatedValue}`,
          },
          (txSig) => `NT bundle withdrawal requested: ${txSig}`,
        );
      },
    );
}
