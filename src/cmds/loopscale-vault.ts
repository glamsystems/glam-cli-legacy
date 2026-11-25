import { BN } from "@coral-xyz/anchor";
import {
  LOOPSCALE_VAULT_PROTOCOL,
  LoopscaleVaultPolicy,
} from "@glamsystems/glam-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { type Command } from "commander";

import {
  type CliContext,
  executeTxWithErrorHandling,
  printPubkeyList,
  resolveTokenList,
} from "../utils";
import {
  editsStagedLine,
  readVaultTimelock,
  type VaultTimelock,
} from "../staging";
import { fail } from "../errors";
import {
  parseNonNegativeUiAmount,
  parsePositiveUiAmount,
  validatePublicKey,
} from "../parsing";

type DepositWithdrawOptions = {
  minAmountOut: string;
  yes: boolean;
};

type UnstakeOptions = {
  stake: PublicKey;
  yes: boolean;
};

type ClaimRewardsOptions = {
  stake: PublicKey;
  mints: string;
  yes: boolean;
};

/** The Loopscale vault policy an edit replaces: the staged one under a timelock that holds one. */
async function loopscaleVaultPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => context.glamClient.loopscaleVault.fetchPolicy(),
    () => context.glamClient.loopscaleVault.programId,
    LOOPSCALE_VAULT_PROTOCOL,
    LoopscaleVaultPolicy.decode,
  );
}

export function installLoopscaleVaultCommands(
  loopscaleVault: Command,
  context: CliContext,
) {
  loopscaleVault
    .command("view-policy")
    .description("View Loopscale vault policy")
    .action(async () => {
      const policy = await context.glamClient.loopscaleVault.fetchPolicy();
      if (!policy) {
        console.log("No vault policy found");
        process.exit(1);
      }
      printPubkeyList("Loopscale vault allowlist", policy.vaultAllowlist);
    });

  loopscaleVault
    .command("reset-policy")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Reset Loopscale vault policy to an empty default")
    .action(async (options: { yes: boolean }) => {
      const timelock = await readVaultTimelock(context);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleVault.setPolicy(
            new LoopscaleVaultPolicy(),
            context.txOptions,
          ),
        {
          skip: options.yes,
          message: timelock.confirm("Confirm resetting Loopscale vault policy"),
        },
        timelock.outcome("Loopscale vault policy reset"),
      );
    });

  loopscaleVault
    .command("allowlist-vault")
    .argument("<vault>", "Loopscale user vault public key", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a Loopscale user vault to the allowlist")
    .action(async (vault: PublicKey, options: { yes?: boolean }) => {
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleVaultPolicyToEdit(context, timelock);
      const policy = base.value ?? new LoopscaleVaultPolicy();
      if (policy.vaultAllowlist.find((v) => v.equals(vault))) {
        fail(
          `Loopscale vault ${vault} is already in the allowlist${base.stagedApart ? " as staged" : ""}`,
        );
      }

      policy.vaultAllowlist.push(vault);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleVault.setPolicy(
            policy,
            context.txOptions,
          ),
        {
          skip: options?.yes ?? false,
          message: timelock.confirm(
            [
              `Confirm adding Loopscale vault ${vault} to allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale vault allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Loopscale vault ${vault} added to allowlist`),
      );
    });

  loopscaleVault
    .command("remove-vault")
    .argument("<vault>", "Loopscale user vault public key", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a Loopscale user vault from the allowlist")
    .action(async (vault: PublicKey, options: { yes?: boolean }) => {
      const timelock = await readVaultTimelock(context);
      const base = await loopscaleVaultPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        fail(
          `No vault policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
      }
      if (!policy.vaultAllowlist.find((v) => v.equals(vault))) {
        fail(
          `Vault not in allowlist${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
      }

      policy.vaultAllowlist = policy.vaultAllowlist.filter(
        (v) => !v.equals(vault),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleVault.setPolicy(
            policy,
            context.txOptions,
          ),
        {
          skip: options?.yes ?? false,
          message: timelock.confirm(
            [
              `Confirm removing Loopscale vault ${vault} from allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the Loopscale vault allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Loopscale vault ${vault} removed from allowlist`),
      );
    });

  loopscaleVault
    .command("deposit")
    .argument("<vault>", "Loopscale user vault public key", validatePublicKey)
    .argument("<amount>", "Principal amount to deposit")
    .option("--min-amount-out <amount>", "Minimum LP amount to receive", "0")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Deposit principal into a Loopscale user vault")
    .action(
      async (
        vault: PublicKey,
        amount: string,
        options: DepositWithdrawOptions,
      ) => {
        const { accounts, principalDecimals, lpDecimals } =
          await context.glamClient.loopscaleVault.resolveVaultData(vault);
        const amountIn = parsePositiveUiAmount(
          amount,
          principalDecimals,
          "amount",
        );
        const minAmountOut = parseNonNegativeUiAmount(
          options.minAmountOut,
          lpDecimals,
          "min-amount-out",
        );

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.loopscaleVault.depositUserVault(
              { amountIn, minAmountOut },
              accounts,
              context.txOptions,
            ),
          {
            skip: options.yes,
            // The floor is sent with the amount: 0 accepts any LP amount.
            message: [
              "Confirm Loopscale vault deposit",
              `vault: ${vault}`,
              `principal: ${amount.trim()} (${amountIn} base units of ${accounts.principalMint})`,
              `minimum LP out: ${options.minAmountOut.trim()} (${minAmountOut} base units)`,
            ].join("\n"),
          },
          (txSig) => `Loopscale vault deposit successful: ${txSig}`,
        );
      },
    );

  loopscaleVault
    .command("withdraw")
    .argument("<vault>", "Loopscale user vault public key", validatePublicKey)
    .argument("<amount>", "UI LP amount to burn")
    .option(
      "--min-amount-out <amount>",
      "Minimum UI principal amount to receive",
      "0",
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Withdraw principal from a Loopscale user vault")
    .action(
      async (
        vault: PublicKey,
        amount: string,
        options: DepositWithdrawOptions,
      ) => {
        const accounts =
          await context.glamClient.loopscaleVault.resolveVaultData(vault);
        const amountIn = parsePositiveUiAmount(
          amount,
          accounts.lpDecimals,
          "amount",
        );
        const minAmountOut = parseNonNegativeUiAmount(
          options.minAmountOut,
          accounts.principalDecimals,
          "min-amount-out",
        );

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.loopscaleVault.withdrawUserVault(
              { amountIn, minAmountOut },
              accounts.accounts,
              context.txOptions,
            ),
          {
            skip: options.yes,
            // The floor is sent with the amount: 0 accepts any principal amount.
            message: [
              "Confirm Loopscale vault withdrawal",
              `vault: ${vault}`,
              `LP burned: ${amount.trim()} (${amountIn} base units)`,
              `minimum principal out: ${options.minAmountOut.trim()} (${minAmountOut} base units of ${accounts.accounts.principalMint})`,
            ].join("\n"),
          },
          (txSig) => `Loopscale vault withdrawal successful: ${txSig}`,
        );
      },
    );

  loopscaleVault
    .command("stake")
    .argument("<vault>", "Loopscale user vault public key", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Stake Loopscale user vault LP tokens")
    .action(async (vault: PublicKey, options: { yes: boolean }) => {
      const {
        accounts: { lpMint },
      } = await context.glamClient.loopscaleVault.resolveVaultData(vault);

      const nonceSigner = Keypair.generate();
      const vaultStake = context.glamClient.loopscaleVault.getVaultStakePda(
        nonceSigner.publicKey,
        vault,
      );

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleVault.stakeUserVaultLp(
            {
              amount: new BN(0),
              principalAmount: new BN(0),
              stakeAll: true,
              duration: 0,
              durationType: 0,
              actionType: 0,
            },
            {
              nonce: nonceSigner.publicKey,
              vault,
              vaultStake,
              lpMint,
            },
            {
              ...context.txOptions,
            },
            [nonceSigner],
          ),
        {
          skip: options.yes,
          message: `Confirm staking all LP tokens for Loopscale vault ${vault}`,
        },
        (txSig) => `Loopscale vault stake ${vaultStake} created: ${txSig}`,
      );
    });

  loopscaleVault
    .command("unstake")
    .argument("<vault>", "Loopscale user vault public key", validatePublicKey)
    .requiredOption(
      "--stake <stake>",
      "Loopscale VaultStake account",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Unstake Loopscale user vault LP tokens")
    .action(async (vault: PublicKey, options: UnstakeOptions) => {
      const {
        accounts: { lpMint },
      } = await context.glamClient.loopscaleVault.resolveVaultData(vault);

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleVault.unstakeUserVaultLp(
            { actionType: 0, principalAmount: new BN(0) }, // unstake all
            { vault, lpMint, vaultStake: options.stake },
            context.txOptions,
          ),
        {
          skip: options.yes,
          message: `Confirm unstaking Loopscale vault stake ${options.stake}`,
        },
        (txSig) => `Loopscale vault unstake successful: ${txSig}`,
      );
    });

  loopscaleVault
    .command("claim-rewards")
    .argument("<vault>", "Loopscale user vault public key", validatePublicKey)
    .requiredOption(
      "--stake <stake>",
      "Loopscale VaultStake account",
      validatePublicKey,
    )
    .requiredOption(
      "--mints <list>",
      "Comma- or space-separated reward token mint addresses or symbols",
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Claim rewards for a Loopscale VaultStake account")
    .action(async (vault: PublicKey, options: ClaimRewardsOptions) => {
      const mints = await resolveTokenList(context.glamClient, options.mints);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.loopscaleVault.claimVaultRewards(
            mints,
            {
              vault,
              vaultStake: options.stake,
            },
            context.txOptions,
          ),
        {
          skip: options.yes,
          // ext_loopscale adds each claimed mint to the vault's assets.
          message: [
            `Confirm claiming rewards from Loopscale vault stake ${options.stake}`,
            `vault: ${vault}`,
            `reward mints, each added to the vault's assets: ${mints.join(", ")}`,
          ].join("\n"),
        },
        (txSig) => `Loopscale vault rewards claimed: ${txSig}`,
      );
    });
}
