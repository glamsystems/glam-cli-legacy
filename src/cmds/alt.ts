import { type Command } from "commander";
import { type CliContext, executeTxWithErrorHandling } from "../utils";
import { fail } from "../errors";
import { validatePublicKey } from "../parsing";
import { type PublicKey, Transaction } from "@solana/web3.js";
import {
  buildCreateAltInstructions,
  buildExtendAltInstructions,
  collectVaultLookupTableAddresses,
  findGlamLookupTables,
  type VaultAccountsInfo,
} from "@glamsystems/glam-sdk";

// LOOKUP_TABLE_MAX_ADDRESSES: the most addresses a lookup table holds, and
// the most a v0 message's one-byte table index can reach.
const MAX_TABLE_ADDRESSES = 256;

async function getVaultAccountsInfo(
  context: CliContext,
): Promise<VaultAccountsInfo> {
  const client = context.glamClient;
  const stateAccount = await client.fetchStateAccount();
  const stateModel = await client.fetchStateModel();
  return {
    statePda: client.statePda,
    vaultPda: client.vaultPda,
    mintPda: client.mintPda,
    escrowPda: client.escrowPda,
    requestQueuePda: client.requestQueuePda,
    extraMetasPda: client.extraMetasPda,
    protocolProgramId: client.protocolProgram.programId,
    mintProgramId: client.mintProgram.programId,
    connection: client.connection,
    stateAccount,
    borrowable: stateModel.borrowable || undefined,
  };
}

export function installAltCommands(alt: Command, context: CliContext) {
  alt
    .command("create")
    .description(
      "Create address lookup table (ALT) for the connected GLAM vault",
    )
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (options) => {
      if (!context.glamClient.isVaultConnected) {
        console.error("GlamClient is not connected to a vault");
        process.exit(1);
      }

      const info = await getVaultAccountsInfo(context);
      const addresses = await collectVaultLookupTableAddresses(info);
      console.log(`Collected ${addresses.length} addresses for lookup table`);
      // The batches go out one transaction at a time, so the first ones and
      // their rent would land before the table refused one.
      if (addresses.length > MAX_TABLE_ADDRESSES) {
        fail(
          `A lookup table holds at most ${MAX_TABLE_ADDRESSES} addresses, and the vault has ${addresses.length}`,
        );
      }

      // The slot is an input to the table address derivation and must be in the
      // bank's SlotHashes when the transaction is simulated and sent. A confirmed
      // slot may not be there yet, so the slot is read at finalized.
      const slot = await context.glamClient.connection.getSlot("finalized");
      const { createIx, lookupTableAddress, extendIxBatches } =
        buildCreateAltInstructions(
          addresses,
          context.glamClient.signer,
          context.glamClient.signer,
          slot,
        );

      await executeTxWithErrorHandling(
        async () => {
          const txSigs: string[] = [];

          // First tx: create table + first extend batch
          const firstTx = new Transaction().add(createIx);
          if (extendIxBatches.length > 0) {
            firstTx.add(extendIxBatches[0]);
          }
          const vTx = await context.glamClient.intoVersionedTransaction(
            firstTx,
            context.txOptions,
          );
          const txSig = await context.glamClient.sendAndConfirm(vTx);
          txSigs.push(txSig);

          // Remaining extend batches
          for (let i = 1; i < extendIxBatches.length; i++) {
            const extendTx = new Transaction().add(extendIxBatches[i]);
            const vExtendTx = await context.glamClient.intoVersionedTransaction(
              extendTx,
              context.txOptions,
            );
            const extendSig =
              await context.glamClient.sendAndConfirm(vExtendTx);
            txSigs.push(extendSig);
          }

          context.glamClient.invalidateGlamLookupTablesCache();
          return txSigs.join(", ");
        },
        {
          skip: options?.yes,
          message: `Confirm creating address lookup table ${lookupTableAddress.toBase58()} with ${addresses.length} addresses?`,
        },
        (txSigs) =>
          `Address lookup table ${lookupTableAddress.toBase58()} created: ${txSigs}`,
      );
    });

  alt
    .command("extend")
    .argument("<table>", "Address lookup table to extend", validatePublicKey)
    .description("Extend an address lookup table")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (tableToExtend: PublicKey, options) => {
      if (!context.glamClient.isVaultConnected) {
        console.error("GlamClient is not connected to a vault");
        process.exit(1);
      }

      const info = await getVaultAccountsInfo(context);
      const allAddresses = await collectVaultLookupTableAddresses(info);

      // Fetch existing ALT entries
      const lookupTableAccounts = await findGlamLookupTables(
        context.glamClient.statePda,
        context.glamClient.vaultPda,
        context.glamClient.connection,
      );
      const existingTable = lookupTableAccounts.find((t) =>
        t.key.equals(tableToExtend),
      );
      if (!existingTable) {
        console.error(
          `Address lookup table ${tableToExtend.toBase58()} not found for this vault`,
        );
        process.exit(1);
      }

      // Diff: find addresses not already in the ALT
      const existingSet = new Set(
        existingTable.state.addresses.map((a) => a.toBase58()),
      );
      const newAddresses = allAddresses.filter(
        (addr) => !existingSet.has(addr.toBase58()),
      );

      if (newAddresses.length === 0) {
        console.log("Address lookup table is already up to date.");
        return;
      }

      console.log(`Found ${newAddresses.length} new addresses to add`);
      const held = existingTable.state.addresses.length;
      if (held + newAddresses.length > MAX_TABLE_ADDRESSES) {
        fail(
          `A lookup table holds at most ${MAX_TABLE_ADDRESSES} addresses: ${tableToExtend.toBase58()} holds ${held}, so it takes ${MAX_TABLE_ADDRESSES - held} of the ${newAddresses.length} new ones. Create another table with \`glam alt create\``,
        );
      }

      const extendIxs = buildExtendAltInstructions(
        tableToExtend,
        newAddresses,
        context.glamClient.signer,
        context.glamClient.signer,
      );

      await executeTxWithErrorHandling(
        async () => {
          const txSigs: string[] = [];
          for (const ix of extendIxs) {
            const tx = new Transaction().add(ix);
            const vTx = await context.glamClient.intoVersionedTransaction(
              tx,
              context.txOptions,
            );
            const txSig = await context.glamClient.sendAndConfirm(vTx);
            txSigs.push(txSig);
          }
          context.glamClient.invalidateGlamLookupTablesCache();
          return txSigs.join(", ");
        },
        {
          skip: options?.yes,
          message: `Confirm extending address lookup table ${tableToExtend.toBase58()} with ${newAddresses.length} new addresses?`,
        },
        (txSigs) =>
          `Address lookup table ${tableToExtend.toBase58()} extended: ${txSigs}`,
      );
    });

  alt
    .command("list")
    .description(
      "List address lookup table(s) created for the connected GLAM vault",
    )
    .action(async () => {
      if (!context.glamClient.isVaultConnected) {
        console.error("GlamClient is not connected to a vault");
        process.exit(1);
      }

      const { statePda, vaultPda, connection } = context.glamClient;
      const lookupTableAccounts = await findGlamLookupTables(
        statePda,
        vaultPda,
        connection,
      );

      if (lookupTableAccounts.length > 0) {
        console.log("GLAM address lookup tables:");
        lookupTableAccounts.map((t, i) => console.log(`[${i}] ${t.key}`));
      } else {
        console.log("No GLAM address lookup table found");
      }
    });
}
