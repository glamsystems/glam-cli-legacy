import { type Command } from "commander";
import { type CliContext, executeTxWithErrorHandling } from "../utils";
import { parsePositiveUiAmount } from "../parsing";

export function installMarinadeCommands(
  marinade: Command,
  context: CliContext,
) {
  marinade
    .command("stake")
    .argument("<amount>", "UI amount of SOL to stake")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Stake SOL and get mSOL")
    .action(async (amount, options) => {
      const amountBN = parsePositiveUiAmount(amount, 9, "amount");
      await executeTxWithErrorHandling(
        () => context.glamClient.marinade.deposit(amountBN, context.txOptions),
        {
          skip: options?.yes,
          message: `Confirm staking ${amount} SOL to Marinade stake pool`,
        },
        (txSig) => `Staked ${amount} SOL: ${txSig}`,
      );
    });

  marinade
    .command("withdraw-stake")
    .argument("<amount>", "UI amount of mSOL")
    .option("-d, --deactivate", "Deactivate the stake account", false)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Withdraw <amount> mSOL into a stake account")
    .action(async (amount, options) => {
      const amountBN = parsePositiveUiAmount(amount, 9, "amount");
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.marinade.withdrawStakeAccount(
            amountBN,
            options.deactivate,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: `Confirm withdrawing ${amount} mSOL into a stake account${options.deactivate ? ", then deactivating it (--deactivate)" : ""}`,
        },
        (txSig) =>
          `Withdrew ${amount} mSOL into a stake account${options.deactivate ? " and deactivated it" : ""}: ${txSig}`,
      );
    });
}
