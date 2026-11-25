import { type Command } from "commander";
import { type PublicKey } from "@solana/web3.js";
import { fail } from "../errors";
import {
  type CliContext,
  executeTxWithErrorHandling,
  printableText,
} from "../utils";
import { collectPublicKeys, validatePublicKey } from "../parsing";
import {
  isTokenAclEnabled,
  fetchMintAndTokenProgram,
  getTokenAclMintConfigPda,
  getTokenAclGateListConfigPda,
  getTokenAclGateWalletEntryPda,
  getTokenAclGateExtraMetasPda,
  TokenAclListConfig,
  TokenAclMintConfig,
  TokenAclWalletEntry,
  TOKEN_ACL_GATE_PROGRAM,
} from "@glamsystems/glam-sdk";

function parseSeed(seedStr: string): Buffer {
  const seed = Buffer.alloc(32);
  Buffer.from(seedStr).copy(seed);
  return seed;
}

const MODES = new Map([
  ["allow", 0],
  ["allow-all-eoas", 1],
  ["block", 2],
]);

/**
 * A list's mode, and its name and seed. The seed is the mode's name in
 * lowercase, as setup-gate links the lists: the text as typed, `Allow`,
 * would name another list.
 */
function parseMode(modeStr: string): {
  mode: number;
  name: string;
  seed: Buffer;
} {
  const name = modeStr.toLowerCase();
  const mode = MODES.get(name);
  if (mode === undefined) {
    console.error(
      `Invalid mode: ${modeStr}. Allowed values: allow, allow-all-eoas, block`,
    );
    process.exit(1);
  }
  return { mode, name, seed: parseSeed(name) };
}

// A gate ListConfig: discriminator (1), authority (32), seed (32), mode (1)
// and wallets count (8).
const LIST_CONFIG_SIZE = 74;

/** The seed of a ListConfig's data as text, its zero padding dropped. */
function listSeedText(data: Buffer): string {
  return printableText(
    Buffer.from(data.subarray(33, 65)).toString().replace(/\0+$/, ""),
  );
}

/**
 * The existing list a command acts on: the one `--list` names, or the one
 * seeded with `--mode` exactly as typed. Earlier CLIs seeded a list with the
 * text as typed, so a list made as `Allow` has another address than `allow`,
 * and neither stands in for the other: a retried deletion would otherwise
 * delete the second. The account must be a gate list of this mint.
 */
async function existingList(
  context: CliContext,
  options: { mode?: string; list?: PublicKey },
): Promise<{ seed: string; label: string; listConfigPda: PublicKey }> {
  const { mintPda } = context.glamClient;
  if ((options.mode === undefined) === (options.list === undefined)) {
    fail(
      "Name the list with --mode, its seed exactly as it was made, or with --list, its ListConfig address, and not both",
    );
  }
  let listConfigPda: PublicKey;
  let lowercase: PublicKey | undefined;
  if (options.list) {
    listConfigPda = options.list;
  } else {
    const { name } = parseMode(options.mode!);
    listConfigPda = getTokenAclGateListConfigPda(
      mintPda,
      parseSeed(options.mode!),
    );
    if (options.mode !== name) {
      lowercase = getTokenAclGateListConfigPda(mintPda, parseSeed(name));
    }
  }
  const [account, lowercaseAccount] =
    await context.glamClient.connection.getMultipleAccountsInfo(
      lowercase ? [listConfigPda, lowercase] : [listConfigPda],
    );
  if (!account) {
    const named = options.list
      ? `${listConfigPda} has no account`
      : `No list is seeded "${printableText(options.mode!)}" for this mint (ListConfig PDA ${listConfigPda})`;
    fail(
      lowercaseAccount
        ? `${named}. The list seeded "${parseMode(options.mode!).name}" is ${lowercase}: pass --mode ${parseMode(options.mode!).name}, or --list ${lowercase}`
        : named,
    );
  }
  const data = Buffer.from(account.data);
  if (
    !account.owner.equals(TOKEN_ACL_GATE_PROGRAM) ||
    data.length !== LIST_CONFIG_SIZE ||
    !data.subarray(1, 33).equals(mintPda.toBuffer())
  ) {
    fail(
      `${listConfigPda} is not a Token ACL gate list of this mint ${mintPda}`,
    );
  }
  const seed = listSeedText(data);
  return { seed, label: `the list seeded "${seed}"`, listConfigPda };
}

export function installTokenAclCommands(
  tokenAcl: Command,
  context: CliContext,
) {
  tokenAcl
    .command("status")
    .description("Show Token ACL status for the current mint")
    .action(async () => {
      const { glamClient } = context;
      const mintPda = glamClient.mintPda;
      const enabled = await isTokenAclEnabled(glamClient.connection, mintPda);
      const { mint } = await fetchMintAndTokenProgram(
        glamClient.connection,
        mintPda,
      );
      const mintConfigPda = getTokenAclMintConfigPda(mintPda);

      console.log("Mint:", mintPda.toBase58());
      console.log("Token ACL enabled:", enabled);
      console.log(
        "Freeze authority:",
        mint.freezeAuthority?.toBase58() ?? "none",
      );
      console.log("MintConfig PDA:", mintConfigPda.toBase58());

      // Fetch and display MintConfig details if it exists
      const mintConfigAccount =
        await glamClient.connection.getAccountInfo(mintConfigPda);
      if (mintConfigAccount) {
        const mintConfig = TokenAclMintConfig.decode(
          mintConfigPda,
          mintConfigAccount.data,
        );
        console.log(
          "Permissionless thaw:",
          mintConfig.enablePermissionlessThaw ? "enabled" : "disabled",
        );
        console.log(
          "Permissionless freeze:",
          mintConfig.enablePermissionlessFreeze ? "enabled" : "disabled",
        );
        console.log("Gating program:", mintConfig.gatingProgram.toBase58());
      }

      // Fetch gate extra metas to find lists linked to this mint
      const extraMetasPda = getTokenAclGateExtraMetasPda(mintPda);
      const extraMetasInfo =
        await glamClient.connection.getAccountInfo(extraMetasPda);
      const extraMetasData = extraMetasInfo?.data;

      if (!extraMetasData) {
        console.log("\nNo gate configured (run setup-gate to link lists).");
      } else {
        // Fetch all lists where authority = mintPda
        const listAccounts = await glamClient.connection.getProgramAccounts(
          TOKEN_ACL_GATE_PROGRAM,
          {
            filters: [
              { dataSize: 74 }, // discriminator(1) + authority(32) + seed(32) + mode(1) + walletsCount(8)
              {
                memcmp: {
                  offset: 1, // after discriminator
                  bytes: mintPda.toBase58(),
                },
              },
            ],
          },
        );

        // Only show lists that are linked to this mint's gate extra metas
        const linkedLists = listAccounts.filter(({ pubkey }) =>
          extraMetasData.includes(pubkey.toBuffer()),
        );

        if (linkedLists.length === 0) {
          console.log("\nNo gate lists configured for this mint.");
        } else {
          console.log(`\nGate lists (${linkedLists.length}):`);
          for (const { pubkey, account } of linkedLists) {
            const listConfig = TokenAclListConfig.decode(pubkey, account.data);
            const walletsCount = listConfig.walletsCount;
            const seedStr = Buffer.from(listConfig.seed.toBytes())
              .toString()
              .replace(/\0+$/, "");
            console.log(
              `  "${seedStr}" (${listConfig.modeName}, ${walletsCount} wallet(s)) ${pubkey.toBase58()}`,
            );

            // Fetch wallet entries for this list
            if (!walletsCount.isZero()) {
              const walletAccounts =
                await glamClient.connection.getProgramAccounts(
                  TOKEN_ACL_GATE_PROGRAM,
                  {
                    filters: [
                      { dataSize: 65 }, // discriminator(1) + wallet(32) + listConfig(32)
                      {
                        memcmp: {
                          offset: 33, // after discriminator + wallet
                          bytes: pubkey.toBase58(),
                        },
                      },
                    ],
                  },
                );
              for (const {
                pubkey: entryPubkey,
                account: entryAccount,
              } of walletAccounts) {
                const entry = TokenAclWalletEntry.decode(
                  entryPubkey,
                  entryAccount.data,
                );
                console.log(`    - ${entry.wallet.toBase58()}`);
              }
            }
          }
        }
      }
    });

  tokenAcl
    .command("enable")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Enable Token ACL (sRFC-37) on the current mint")
    .action(async (options) => {
      const { glamClient, txOptions } = context;
      await executeTxWithErrorHandling(
        () => glamClient.mint.enableTokenAcl(undefined, txOptions),
        {
          skip: options?.yes,
          message:
            "Enable Token ACL? This transfers freeze authority to the Token ACL program.",
        },
        (txSig) => `Token ACL enabled: ${txSig}`,
      );
    });

  tokenAcl
    .command("create-list")
    .requiredOption("--mode <mode>", "List mode: allow, block, allow-all-eoas")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Create a Token ACL list")
    .action(async (options) => {
      const { glamClient, txOptions } = context;
      const { mode, name, seed } = parseMode(options.mode);
      const listConfigPda = getTokenAclGateListConfigPda(
        glamClient.mintPda,
        seed,
      );

      await executeTxWithErrorHandling(
        () => glamClient.mint.aclGateCreateList(seed, mode, txOptions),
        {
          skip: options?.yes,
          message: `Create ${name} list? ListConfig PDA: ${listConfigPda}`,
        },
        (txSig) => `List created: ${txSig}\nListConfig PDA: ${listConfigPda}`,
      );
    });

  tokenAcl
    .command("delete-list")
    .option(
      "--mode <mode>",
      "The list's seed, a mode name exactly as the list was made: allow, block or allow-all-eoas, or a list an earlier CLI made with capitals, such as Allow",
    )
    .option(
      "--list <address>",
      "The list's ListConfig address, instead of --mode",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Delete a Token ACL list")
    .action(async (options) => {
      const { glamClient, txOptions } = context;
      const { label, listConfigPda } = await existingList(context, options);

      await executeTxWithErrorHandling(
        () => glamClient.mint.aclGateDeleteList(listConfigPda, txOptions),
        {
          skip: options?.yes,
          message: `Delete ${label}? ListConfig PDA: ${listConfigPda.toBase58()}`,
        },
        (txSig) =>
          `List deleted: ${txSig}\nListConfig PDA: ${listConfigPda.toBase58()}\n` +
          `Note: If this list was used in setup-gate, re-run "setup-gate" to update gate extra metas.`,
      );
    });

  tokenAcl
    .command("add-wallet")
    .argument("<wallet>", "Wallet public key to add", validatePublicKey)
    .option(
      "--mode <mode>",
      "The list's seed, a mode name exactly as the list was made: allow, block or allow-all-eoas, or a list an earlier CLI made with capitals, such as Allow",
    )
    .option(
      "--list <address>",
      "The list's ListConfig address, instead of --mode",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a wallet to a Token ACL list")
    .action(async (wallet, options) => {
      const { glamClient, txOptions } = context;
      const { label, listConfigPda } = await existingList(context, options);

      await executeTxWithErrorHandling(
        () =>
          glamClient.mint.aclGateAddWallet(listConfigPda, wallet, txOptions),
        {
          skip: options?.yes,
          message: `Add wallet ${wallet.toBase58()} to ${label}? ListConfig PDA: ${listConfigPda.toBase58()}`,
        },
        (txSig) => `Wallet added: ${txSig}`,
      );
    });

  tokenAcl
    .command("remove-wallet")
    .argument("<wallet>", "Wallet public key to remove", validatePublicKey)
    .option(
      "--mode <mode>",
      "The list's seed, a mode name exactly as the list was made: allow, block or allow-all-eoas, or a list an earlier CLI made with capitals, such as Allow",
    )
    .option(
      "--list <address>",
      "The list's ListConfig address, instead of --mode",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a wallet from a Token ACL list")
    .action(async (wallet, options) => {
      const { glamClient, txOptions } = context;
      const { label, listConfigPda } = await existingList(context, options);
      const walletEntryPda = getTokenAclGateWalletEntryPda(
        listConfigPda,
        wallet,
      );

      await executeTxWithErrorHandling(
        () =>
          glamClient.mint.aclGateRemoveWallet(
            listConfigPda,
            walletEntryPda,
            txOptions,
          ),
        {
          skip: options?.yes,
          message: `Remove wallet ${wallet.toBase58()} from ${label}? ListConfig PDA: ${listConfigPda.toBase58()}`,
        },
        (txSig) => `Wallet removed: ${txSig}`,
      );
    });

  tokenAcl
    .command("list-wallets")
    .option(
      "--mode <mode>",
      "The list's seed, a mode name exactly as the list was made: allow, block or allow-all-eoas, or a list an earlier CLI made with capitals, such as Allow",
    )
    .option(
      "--list <address>",
      "The list's ListConfig address, instead of --mode",
      validatePublicKey,
    )
    .description("List all wallets in a Token ACL list")
    .action(async (options) => {
      const { glamClient } = context;
      const { seed, listConfigPda } = await existingList(context, options);

      // Fetch and display list config
      const listConfigInfo =
        await glamClient.connection.getAccountInfo(listConfigPda);
      if (!listConfigInfo) {
        fail(`List "${seed}" not found (PDA: ${listConfigPda.toBase58()})`);
      }
      const listConfig = TokenAclListConfig.decode(
        listConfigPda,
        listConfigInfo.data,
      );
      const walletsCount = listConfig.walletsCount;

      console.log(`List: "${seed}"`);
      console.log(`ListConfig PDA: ${listConfigPda.toBase58()}`);
      console.log(`Mode: ${listConfig.modeName}`);
      console.log(`Wallets count: ${walletsCount.toString()}`);

      if (walletsCount.isZero()) {
        return;
      }

      // Fetch all wallet entries for this list config
      const accounts = await glamClient.connection.getProgramAccounts(
        TOKEN_ACL_GATE_PROGRAM,
        {
          filters: [
            { dataSize: 65 }, // discriminator(1) + wallet(32) + listConfig(32)
            {
              memcmp: {
                offset: 33, // after discriminator + wallet
                bytes: listConfigPda.toBase58(),
              },
            },
          ],
        },
      );

      console.log("\nWallets:");
      for (const { pubkey, account } of accounts) {
        const entry = TokenAclWalletEntry.decode(pubkey, account.data);
        console.log(`  ${entry.wallet.toBase58()}`);
      }
    });

  tokenAcl
    .command("setup-gate")
    .option(
      "--additional-lists <lists...>",
      "Additional lists to include in the gate, comma- or space-separated",
      collectPublicKeys,
      [],
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Setup gate extra metas for permissionless thaw")
    .action(async (options) => {
      const { glamClient, txOptions } = context;

      // Default lists controlled by glam mint PDA
      const listConfigs = ["allow", "block", "allow-all-eoas"].map(
        (seedStr: string) =>
          getTokenAclGateListConfigPda(glamClient.mintPda, parseSeed(seedStr)),
      );

      // Additional lists provided by user
      const additionalListConfigs: PublicKey[] = options.additionalLists || [];
      const allListConfigs = [...listConfigs, ...additionalListConfigs];

      // A default list that was never created is skipped; a list the user
      // names and that has no account is a mistake, and is refused.
      const accounts =
        await glamClient.connection.getMultipleAccountsInfo(allListConfigs);
      const missingAdditional = additionalListConfigs.filter(
        (_, index) => !accounts[listConfigs.length + index],
      );
      if (missingAdditional.length > 0) {
        fail(
          `setup-gate links only lists that exist, and ${missingAdditional.join(", ")} given in --additional-lists ${missingAdditional.length === 1 ? "has" : "have"} no account`,
        );
      }
      const validListConfigs = allListConfigs.filter(
        (_, index) => accounts[index],
      );
      if (validListConfigs.length !== allListConfigs.length) {
        console.warn(
          "Skipping invalid list configs (onchain account doesn't exist)",
        );
      }

      await executeTxWithErrorHandling(
        () =>
          glamClient.mint.aclGateSetupExtraMetas(validListConfigs, txOptions),
        {
          skip: options?.yes,
          message: `Setup gate extra metas with ${validListConfigs.length} list config(s)?`,
        },
        (txSig) => `Gate extra metas configured: ${txSig}`,
      );
    });

  tokenAcl
    .command("thaw")
    .argument("<wallet>", "Wallet to thaw", validatePublicKey)
    .requiredOption("--seed <seed>", "Seed string of the allowlist")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Permissionless thaw for an allowlisted wallet")
    .action(async (wallet, options) => {
      const { glamClient, txOptions } = context;
      const seed = parseSeed(options.seed);
      const listConfigPda = getTokenAclGateListConfigPda(
        glamClient.mintPda,
        seed,
      );
      const walletEntryPda = getTokenAclGateWalletEntryPda(
        listConfigPda,
        wallet,
      );

      await executeTxWithErrorHandling(
        () =>
          glamClient.mint.thawPermissionless(
            wallet,
            [{ listConfig: listConfigPda, walletEntry: walletEntryPda }],
            txOptions,
          ),
        {
          skip: options?.yes,
          message: `Thaw token account for wallet ${wallet.toBase58()}?`,
        },
        (txSig) => `Token account thawed: ${txSig}`,
      );
    });
}
