import { MSOL, STAKE_POOLS_MAP } from "@glamsystems/glam-sdk";
import { type Command } from "commander";
import { type PublicKey } from "@solana/web3.js";
import {
  type CliContext,
  executeTxWithErrorHandling,
  resolveTokenPublicKey,
} from "../utils";
import { fail } from "../errors";
import { parsePositiveUiAmount, validatePublicKey } from "../parsing";

export function installLstCommands(lst: Command, context: CliContext) {
  lst
    .command("stake")
    .argument("<stake-pool>", "Stake pool address", validatePublicKey)
    .argument("<amount>", "UI amount of SOL to stake")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Stake SOL into a LST pool")
    .action(async (stakePool: PublicKey, amount: string, options) => {
      const amountBN = parsePositiveUiAmount(amount, 9, "amount");

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.stakePool.depositSol(
            stakePool,
            amountBN,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          // The SDK sends ext_stake_pool a minimum out of 1 base unit.
          message: `Confirm staking ${amount} SOL into ${stakePool}, minimum pool tokens out: 1 base unit (no slippage bound)`,
        },
        (txSig) => `Staked ${amount} SOL: ${txSig}`,
      );
    });
  lst
    .command("unstake")
    .argument("<token>", "LST mint address or symbol")
    .argument("<amount>", "UI amount of LST to unstake")
    .option("-d, --deactivate", "Deactivate the stake account", false)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Unstake LST and receive SOL in a stake account")
    .action(async (token: string, amount: string, options) => {
      const asset = await resolveTokenPublicKey(context.glamClient, token);
      // The SDK unstakes the stake pool mints it lists and no other.
      const pool = STAKE_POOLS_MAP.get(asset.toBase58());
      if (!pool) {
        fail(`LST not supported: ${asset}`);
      }
      const amountBN = parsePositiveUiAmount(amount, pool.decimals, "amount");

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.stakePool.unstake(
            asset,
            amountBN,
            options.deactivate,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: [
            `Confirm unstaking ${amount} ${pool.symbol} (${asset})`,
            // Marinade takes no minimum; the SPL stake pool path sends 1.
            ...(asset.equals(MSOL)
              ? []
              : ["minimum SOL out: 1 lamport (no slippage bound)"]),
            ...(options.deactivate
              ? ["then deactivating the new stake account (--deactivate)"]
              : []),
          ].join(", "),
        },
        (txSig) =>
          `Unstaked ${amount} ${pool.symbol} (${asset})${options.deactivate ? " and deactivated the new stake account" : ""}: ${txSig}`,
      );
    });
}
