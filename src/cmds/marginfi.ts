import { BN } from "@coral-xyz/anchor";
import {
  MARGINFI_PROTOCOL,
  MarginfiPolicy,
  U64_MAX_BN,
} from "@glamsystems/glam-sdk";
import { type Command } from "commander";

import {
  type CliContext,
  executeTxWithErrorHandling,
  printPubkeyList,
  resolveTokenPublicKey,
} from "../utils";
import {
  editsStagedLine,
  readVaultTimelock,
  type VaultTimelock,
} from "../staging";
import { fail } from "../errors";
import { parsePositiveBn, parseU16, validatePublicKey } from "../parsing";

/** The Marginfi policy an edit replaces: the staged one under a timelock that holds one. */
async function marginfiPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => context.glamClient.marginfi.fetchPolicy(),
    () => context.glamClient.extMarginfiProgram.programId,
    MARGINFI_PROTOCOL,
    MarginfiPolicy.decode,
  );
}

export function installMarginfiCommands(
  marginfi: Command,
  context: CliContext,
) {
  const pk = (value: string) => validatePublicKey(value);
  // Each amount is a u64 in base units.
  const amountRaw = (value: string) =>
    parsePositiveBn(value, "amount", U64_MAX_BN);

  marginfi
    .command("view-policy")
    .description("View Marginfi policy")
    .action(async () => {
      const policy = await context.glamClient.marginfi.fetchPolicy();
      if (!policy) {
        console.log("No policy found");
        process.exit(1);
      }
      printPubkeyList("Marginfi groups allowlist", policy.groupsAllowlist);
      printPubkeyList("Marginfi banks allowlist", policy.banksAllowlist);
      printPubkeyList(
        "Marginfi borrowable tokens allowlist",
        policy.borrowAllowlist,
      );
    });

  marginfi
    .command("allowlist-group")
    .argument("<group>", "Marginfi group", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a Marginfi group to the policy allowlist")
    .action(async (group, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await marginfiPolicyToEdit(context, timelock);
      const policy = base.value ?? new MarginfiPolicy([], [], []);
      if (!policy.groupsAllowlist.find((g) => g.equals(group))) {
        policy.groupsAllowlist.push(group);
      }
      await executeTxWithErrorHandling(
        () => context.glamClient.marginfi.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding group ${group}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Marginfi policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Marginfi group ${group} allowlisted`),
      );
    });

  marginfi
    .command("allowlist-bank")
    .argument("<bank>", "Marginfi bank", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a Marginfi bank to the policy allowlist")
    .action(async (bank, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await marginfiPolicyToEdit(context, timelock);
      const policy = base.value ?? new MarginfiPolicy([], [], []);
      if (!policy.banksAllowlist.find((b) => b.equals(bank))) {
        policy.banksAllowlist.push(bank);
      }
      await executeTxWithErrorHandling(
        () => context.glamClient.marginfi.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding bank ${bank}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Marginfi policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Marginfi bank ${bank} allowlisted`),
      );
    });

  marginfi
    .command("allowlist-borrowable-token")
    .alias("allowlist-borrowable-asset")
    .argument("<token>", "Borrowable token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a borrowable token to the Marginfi policy")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await marginfiPolicyToEdit(context, timelock);
      const policy = base.value ?? new MarginfiPolicy([], [], []);
      if (!policy.borrowAllowlist.find((t) => t.equals(token))) {
        policy.borrowAllowlist.push(token);
      }
      await executeTxWithErrorHandling(
        () => context.glamClient.marginfi.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding borrowable token ${token}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Marginfi policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Marginfi borrowable token ${token} allowlisted`),
      );
    });

  marginfi
    .command("init-pda")
    .argument("<group>", "Marginfi group", validatePublicKey)
    .argument(
      "<account-index-or-marginfi-account>",
      "Marginfi account index, or explicit Marginfi account PDA for legacy form",
    )
    .argument("[account-index]", "Marginfi account index for legacy form")
    .option("--third-party-id <id>", "Optional third party id", (value) =>
      parseU16(value, "third-party-id"),
    )
    .description(
      "Initialize a Marginfi account PDA with the GLAM vault as authority",
    )
    .action(
      async (
        group,
        accountIndexOrMarginfiAccount,
        accountIndexArg,
        options,
      ) => {
        const accountIndex =
          accountIndexArg === undefined
            ? parseU16(accountIndexOrMarginfiAccount, "account-index")
            : parseU16(accountIndexArg, "account-index");
        const marginfiAccount =
          accountIndexArg === undefined
            ? context.glamClient.marginfi.getAccountPda(
                group,
                accountIndex,
                options.thirdPartyId ?? null,
              )
            : validatePublicKey(accountIndexOrMarginfiAccount);

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.marginfi.initializeAccountPda(
              group,
              marginfiAccount,
              accountIndex,
              options.thirdPartyId ?? null,
              context.txOptions,
            ),
          { skip: true },
          (txSig) =>
            `Initialized Marginfi account PDA ${marginfiAccount}: ${txSig}`,
        );
      },
    );

  marginfi
    .command("close-account")
    .argument("<marginfi-account>", "Marginfi account", validatePublicKey)
    .description("Close an empty Marginfi account owned by the GLAM vault")
    .action(async (marginfiAccount) => {
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.marginfi.closeAccount(
            marginfiAccount,
            context.txOptions,
          ),
        { skip: true },
        (txSig) => `Closed Marginfi account ${marginfiAccount}: ${txSig}`,
      );
    });

  marginfi
    .command("borrow")
    .argument("<bank>", "Borrow bank", validatePublicKey)
    .argument("<marginfi-account>", "Marginfi account", validatePublicKey)
    .argument("<amount>", "Amount to borrow, in base units", amountRaw)
    .option("--group <pubkey>", "Override derived Marginfi group", pk)
    .option(
      "--destination-token-account <pubkey>",
      "The vault's associated token account for the bank's mint, the only account the borrow can pay into",
      pk,
    )
    .option(
      "--bank-liquidity-vault-authority <pubkey>",
      "Override derived bank liquidity vault authority",
      pk,
    )
    .option(
      "--liquidity-vault <pubkey>",
      "Override derived bank liquidity vault",
      pk,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Borrow from a Marginfi bank")
    .action(async (bank, marginfiAccount, amount: BN, options) => {
      // The accounts are resolved before the confirmation, which names the
      // token account that receives the funds. The Marginfi account takes
      // the debt, not the tokens.
      const derived = await context.glamClient.marginfi.resolveBorrowAccounts(
        bank,
        marginfiAccount,
      );
      // The SDK creates the vault's associated token account at the
      // destination before it borrows, so another account fails the
      // transaction after the confirmation.
      if (
        options.destinationTokenAccount &&
        !options.destinationTokenAccount.equals(derived.destinationTokenAccount)
      ) {
        fail(
          `--destination-token-account ${options.destinationTokenAccount} is not ${derived.destinationTokenAccount}, the vault's associated token account for the bank's mint, which the borrow creates and pays into`,
        );
      }
      const accounts = {
        ...derived,
        group: options.group ?? derived.group,
        destinationTokenAccount:
          options.destinationTokenAccount ?? derived.destinationTokenAccount,
        bankLiquidityVaultAuthority:
          options.bankLiquidityVaultAuthority ??
          derived.bankLiquidityVaultAuthority,
        liquidityVault: options.liquidityVault ?? derived.liquidityVault,
      };
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.marginfi.borrow(
            accounts,
            amount,
            context.txOptions,
          ),
        {
          skip: !!options.yes,
          message: `Confirm borrowing ${amount} base units from Marginfi bank ${bank} into token account ${accounts.destinationTokenAccount}, as debt of Marginfi account ${marginfiAccount}`,
        },
        (txSig) => `Borrowed from Marginfi: ${txSig}`,
      );
    });

  marginfi
    .command("repay")
    .argument("<bank>", "Repay bank", validatePublicKey)
    .argument("<marginfi-account>", "Marginfi account", validatePublicKey)
    .argument("<amount>", "Amount to repay, in base units", amountRaw)
    .option("--all", "Repay all", false)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Repay a Marginfi borrow")
    .action(async (bank, marginfiAccount, amount: BN, options) => {
      // As in borrow: the tokens leave a token account, and the Marginfi
      // account is the one whose debt they repay.
      const accounts = await context.glamClient.marginfi.resolveRepayAccounts(
        bank,
        marginfiAccount,
      );
      const paid = `from token account ${accounts.sourceTokenAccount}, against the debt of Marginfi account ${marginfiAccount}`;
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.marginfi.repay(
            accounts,
            amount,
            options.all ? true : null,
            context.txOptions,
          ),
        {
          skip: !!options.yes,
          message: options.all
            ? `Confirm repaying the whole borrow at Marginfi bank ${bank} ${paid} (--all, sent with the amount ${amount})`
            : `Confirm repaying ${amount} base units to Marginfi bank ${bank} ${paid}`,
        },
        (txSig) => `Repaid Marginfi borrow: ${txSig}`,
      );
    });

  marginfi
    .command("kamino-deposit")
    .argument("<bank>", "Marginfi Kamino bank", validatePublicKey)
    .argument("<marginfi-account>", "Marginfi account", validatePublicKey)
    .argument(
      "<amount>",
      "Amount to deposit, in base units of the liquidity token",
      amountRaw,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Deposit Kamino-backed collateral into Marginfi")
    .action(async (bank, marginfiAccount, amount: BN, options) => {
      await executeTxWithErrorHandling(
        async () => {
          const accounts =
            await context.glamClient.marginfi.resolveKaminoCollateralAccounts(
              bank,
              marginfiAccount,
            );
          return await context.glamClient.marginfi.kaminoDeposit(
            accounts,
            amount,
            context.txOptions,
          );
        },
        {
          skip: !!options.yes,
          message: `Confirm depositing ${amount} base units into Marginfi Kamino bank ${bank} for account ${marginfiAccount}`,
        },
        (txSig) => `Deposited Kamino-backed collateral into Marginfi: ${txSig}`,
      );
    });

  marginfi
    .command("kamino-withdraw")
    .argument("<bank>", "Marginfi Kamino bank", validatePublicKey)
    .argument("<marginfi-account>", "Marginfi account", validatePublicKey)
    .argument(
      "<amount>",
      "Amount to withdraw, in base units of the Kamino collateral token (not of the liquidity token)",
      amountRaw,
    )
    .option("--all", "Withdraw all", false)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Withdraw Kamino-backed collateral from Marginfi")
    .action(async (bank, marginfiAccount, amount: BN, options) => {
      await executeTxWithErrorHandling(
        async () => {
          const accounts =
            await context.glamClient.marginfi.resolveKaminoCollateralAccounts(
              bank,
              marginfiAccount,
            );
          return await context.glamClient.marginfi.kaminoWithdraw(
            accounts,
            amount,
            options.all ? true : null,
            context.txOptions,
          );
        },
        {
          skip: !!options.yes,
          message: options.all
            ? `Confirm withdrawing the whole balance from Marginfi Kamino bank ${bank} for account ${marginfiAccount} (--all, sent with the amount ${amount})`
            : `Confirm withdrawing ${amount} base units of Kamino collateral from Marginfi Kamino bank ${bank} for account ${marginfiAccount}`,
        },
        (txSig) => `Withdrew Kamino-backed collateral from Marginfi: ${txSig}`,
      );
    });
}
