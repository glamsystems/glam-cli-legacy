import {
  WSOL,
  SPL_TOKEN_PROTOCOL,
  TransferPolicy,
} from "@glamsystems/glam-sdk";
import { type Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import {
  type CliContext,
  executeTxWithErrorHandling,
  printPubkeyList,
  resolveTokenMint,
} from "../utils";
import { fail } from "../errors";
import { parsePositiveUiAmount, validatePublicKey } from "../parsing";
import {
  editsStagedLine,
  readVaultTimelock,
  type VaultTimelock,
} from "../staging";

/** The token transfer policy an edit replaces: the staged one under a timelock that holds one. */
async function transferPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => context.glamClient.vault.fetchPolicy(),
    () => context.glamClient.extSplProgram.programId,
    SPL_TOKEN_PROTOCOL,
    TransferPolicy.decode,
  );
}

export function installTransferCommands(program: Command, context: CliContext) {
  program
    .command("view-policy")
    .description("View token transfer policy")
    .action(async () => {
      const tokenTransferPolicy = await context.glamClient.vault.fetchPolicy();
      if (!tokenTransferPolicy) {
        console.error("Token transfer policy not found.");
        process.exit(1);
      }
      printPubkeyList(
        "Token transfer allowlist",
        tokenTransferPolicy.allowlist,
      );
    });

  program
    .command("allowlist-destination")
    .argument(
      "<pubkey>",
      "Pubkey of the destination address",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a destination address to the token transfer allowlist")
    .action(async (pubkey: PublicKey, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await transferPolicyToEdit(context, timelock);
      const policy = base.value ?? new TransferPolicy([]);
      if (policy.allowlist.find((p) => p.equals(pubkey))) {
        console.error(
          `Destination address ${pubkey} is already in the allowlist${base.stagedApart ? " as staged" : ""}.`,
        );
        process.exit(1);
      }

      policy.allowlist.push(pubkey);
      await executeTxWithErrorHandling(
        () => context.glamClient.vault.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding destination ${pubkey} to allowlist?`,
              ...(base.stagedApart
                ? [editsStagedLine("the token transfer allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Added destination ${pubkey} to allowlist`),
      );
    });

  program
    .command("remove-destination")
    .argument(
      "<pubkey>",
      "Pubkey of the destination address",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Remove a destination address from the token transfer allowlist",
    )
    .action(async (pubkey: PublicKey, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await transferPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        console.error(
          `Token transfer policy not found${base.stagedApart ? " in the staged change" : ""}.`,
        );
        process.exit(1);
      }

      // The policy would be sent unchanged and the removal reported, under a
      // timelock restarting the wait of what is staged.
      if (!policy.allowlist.some((p) => p.equals(pubkey))) {
        fail(
          `Destination ${pubkey} is not in the token transfer allowlist${base.stagedApart ? " as staged" : ""}`,
        );
      }
      policy.allowlist = policy.allowlist.filter((p) => !p.equals(pubkey));
      await executeTxWithErrorHandling(
        () => context.glamClient.vault.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing destination ${pubkey} from allowlist?`,
              ...(base.stagedApart
                ? [editsStagedLine("the token transfer allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Removed destination ${pubkey} from allowlist`),
      );
    });

  program
    .argument("<amount>", "UI amount to transfer")
    .argument("<token>", "Token mint or symbol of SPL token to transfer")
    .argument("<to>", "Destination address (pubkey)", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Transfer SPL token to the destination address")
    .action(
      async (
        amount: string,
        token: string,
        destination: PublicKey,
        { yes },
      ) => {
        const tokenInfo = await resolveTokenMint(context.glamClient, token);
        const tokenMint = new PublicKey(tokenInfo.address);
        const assetLabel = tokenMint.equals(WSOL) ? "wSOL" : tokenInfo.symbol;
        const amountBN = parsePositiveUiAmount(
          amount,
          tokenInfo.decimals,
          "amount",
        );

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.vault.tokenTransfer(
              tokenMint,
              amountBN,
              destination,
              context.txOptions,
            ),
          {
            skip: yes,
            message: `Confirm transfer of ${amount} ${assetLabel} to ${destination}?`,
          },
          (txSig) =>
            `Transferred ${amount} ${assetLabel} to ${destination}: ${txSig}`,
        );
      },
    );
}
