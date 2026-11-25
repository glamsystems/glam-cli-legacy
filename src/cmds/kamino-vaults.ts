import { type Command } from "commander";
import {
  type CliContext,
  executeTxWithErrorHandling,
  printPubkeyList,
} from "../utils";
import {
  editsStagedLine,
  readVaultTimelock,
  type VaultTimelock,
} from "../staging";
import { parsePositiveUiAmount, validatePublicKey } from "../parsing";
import {
  KAMINO_VAULTS_PROTOCOL,
  KaminoVaultsPolicy,
} from "@glamsystems/glam-sdk";

/** The Kamino vaults policy an edit replaces: the staged one under a timelock that holds one. */
async function kaminoVaultsPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => context.glamClient.kaminoVaults.fetchPolicy(),
    () => context.glamClient.extKaminoProgram.programId,
    KAMINO_VAULTS_PROTOCOL,
    KaminoVaultsPolicy.decode,
  );
}

export function installKaminoVaultsCommands(
  kvaults: Command,
  context: CliContext,
) {
  kvaults
    .command("view-policy")
    .description("View Kamino vaults policy")
    .action(async () => {
      const policy = await context.glamClient.kaminoVaults.fetchPolicy();
      if (!policy) {
        console.log("No policy found");
        process.exit(1);
      }
      printPubkeyList("Kamino vaults allowlist", policy.vaultsAllowlist);
    });

  kvaults
    .command("allowlist-vault")
    .argument("<vault>", "Kamino vault public key", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a vault to the allowlist")
    .action(async (vault, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await kaminoVaultsPolicyToEdit(context, timelock);
      const policy = base.value ?? new KaminoVaultsPolicy([]);
      if (policy.vaultsAllowlist.find((v) => v.equals(vault))) {
        console.error(
          `Kamino vault ${vault} is already in the allowlist${base.stagedApart ? " as staged" : ""}`,
        );
        process.exit(1);
      }

      policy.vaultsAllowlist.push(vault);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoVaults.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding Kamino vault ${vault} to allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the Kamino vaults allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Kamino vault ${vault} added to allowlist`),
      );
    });

  kvaults
    .command("remove-vault")
    .argument("<vault>", "Kamino vault public key", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a vault from the allowlist")
    .action(async (vault, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await kaminoVaultsPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        console.error(
          `No policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
        process.exit(1);
      }
      if (!policy.vaultsAllowlist.find((v) => v.equals(vault))) {
        console.error(
          `Vault not in allowlist${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
        process.exit(1);
      }

      policy.vaultsAllowlist = policy.vaultsAllowlist.filter(
        (v) => !v.equals(vault),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoVaults.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing Kamino vault ${vault} from allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the Kamino vaults allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Kamino vault ${vault} removed from allowlist`),
      );
    });

  kvaults
    .command("deposit")
    .argument("<vault>", "Kamino vault public key", validatePublicKey)
    .argument("<amount>", "UI amount to deposit")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Deposit to a Kamino vault")
    .action(async (vault, amount, options) => {
      const vaultState =
        await context.glamClient.kaminoVaults.fetchAndParseVaultState(vault);
      const { tokenMint, tokenMintDecimals, vaultLookupTable } = vaultState;

      const amountBN = parsePositiveUiAmount(
        amount,
        tokenMintDecimals.toNumber(),
        "amount",
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoVaults.deposit(vault, amountBN, {
            ...context.txOptions,
            lookupTables: [vaultLookupTable],
          }),
        {
          skip: options?.yes,
          message: `Confirm depositing ${amount} ${tokenMint} to Kamino vault ${vault}?`,
        },
        (txSig) => `Deposit successful: ${txSig}`,
      );
    });

  kvaults
    .command("withdraw")
    .argument("<vault>", "Kamino vault public key", validatePublicKey)
    .argument("<amount>", "UI amount of Kamino vault shares to burn")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Withdraw from a Kamino vault by burning shares")
    .action(async (vault, amount, options) => {
      const vaultState =
        await context.glamClient.kaminoVaults.fetchAndParseVaultState(vault);
      const { sharesMintDecimals, vaultLookupTable } = vaultState;

      const amountBN = parsePositiveUiAmount(
        amount,
        sharesMintDecimals.toNumber(),
        "amount",
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoVaults.withdraw(vault, amountBN, {
            ...context.txOptions,
            lookupTables: [vaultLookupTable],
          }),
        {
          skip: options?.yes,
          message: `Confirm withdrawing ${amount} shares from Kamino vault ${vault}?`,
        },
        (txSig) => `Withdrawal successful: ${txSig}`,
      );
    });
}
