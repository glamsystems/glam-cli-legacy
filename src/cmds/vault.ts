import {
  WSOL,
  stringToChars,
  charsToString,
  GlamClient,
  StateAccountType,
  fetchMintAndTokenProgram,
  fetchMintsAndTokenPrograms,
  PkSet,
} from "@glamsystems/glam-sdk";
import { BN } from "@coral-xyz/anchor";
import { unpackAccount } from "@solana/spl-token";
import { type Command } from "commander";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import fs from "fs";
import {
  type CliContext,
  executeTxWithErrorHandling,
  formatUiAmount,
  parseMintJson,
  parseStateJson,
  printTable,
  printableText,
  recordSentSignatures,
  resolveTokenPublicKey,
} from "../utils";
import { fail } from "../errors";
import {
  editsStagedLine,
  readVaultTimelock,
  vaultTimelockOf,
} from "../staging";
import {
  parseArrayInput,
  parsePositiveUiAmount,
  parseUnsignedNumber,
  validateBooleanInput,
  validateFileExists,
  validatePublicKey,
} from "../parsing";

// web3.js reads an account's lamports into a number, which holds a count past
// 2^53 rounded, by at most this many lamports for any u64.
const LAMPORTS_ROUNDING = 1024;

/**
 * What the vault holds of a token, in base units. A native (wSOL) account
 * holds every lamport above the reserve it records, as
 * validate_asset_balance_zero in glam_protocol measures it: its token balance
 * plus `unsynced`, the lamports no SyncNative has added to that balance.
 * `approximate` says that `unsynced` was counted from lamports read rounded,
 * so both figures are off by the rounding at most.
 */
async function vaultTokenHolding(
  context: CliContext,
  token: PublicKey,
): Promise<{ held: BN; unsynced: BN; decimals: number; approximate: boolean }> {
  const { connection } = context.glamClient;
  const { mint, tokenProgram } = await fetchMintAndTokenProgram(
    connection,
    token,
  );
  const { decimals } = mint;
  const ata = context.glamClient.getVaultAta(token, tokenProgram);
  const info = await connection.getAccountInfo(ata, "confirmed");
  // No token account: nothing at the address, or lamports sent to it before
  // one was created, which the program reads as a zero balance too.
  if (!info || info.data.length === 0) {
    const none = new BN(0);
    return { held: none, unsynced: none, decimals, approximate: false };
  }
  const account = unpackAccount(ata, info, tokenProgram);
  const amount = new BN(account.amount.toString());
  if (account.rentExemptReserve === null) {
    return { held: amount, unsynced: new BN(0), decimals, approximate: false };
  }
  const above = new BN(BigInt(info.lamports).toString())
    .sub(new BN(account.rentExemptReserve.toString()))
    .sub(amount);
  // Lamports below the reserve plus the token balance is a state no token
  // program leaves; it counts as nothing unsynced. So does a difference no
  // larger than the rounding of a u64 can make, once the lamports are rounded.
  const rounded = !Number.isSafeInteger(info.lamports);
  const unsynced = above.gtn(rounded ? LAMPORTS_ROUNDING : 0)
    ? above
    : new BN(0);
  return {
    held: amount.add(unsynced),
    unsynced,
    decimals,
    approximate: rounded && !unsynced.isZero(),
  };
}

/**
 * What a removal from the asset or borrowable list does to a token the vault
 * holds. Pricing values the vault's tokens on either list and no other, so a
 * held token on neither drops out of the vault's value.
 */
async function heldTokenLine(
  context: CliContext,
  token: PublicKey,
  stillListed: boolean,
): Promise<string[]> {
  if (stillListed) {
    return [];
  }
  const { held, unsynced, decimals, approximate } = await vaultTokenHolding(
    context,
    token,
  );
  if (held.isZero()) {
    return [];
  }
  const about = approximate ? "about " : "";
  // Pricing reads a wSOL account's token balance, so it counts these lamports
  // only once a SyncNative has added them to it.
  const notSynced = unsynced.isZero()
    ? ""
    : `, ${about}${formatUiAmount(unsynced, decimals)} of that as lamports in its token account that no SyncNative has added to the token balance, which pricing counts only once one has`;
  return [
    `The vault holds ${about}${formatUiAmount(held, decimals)} of ${token}${notSynced}. Pricing values only the tokens on the vault allowlist or the borrowable list, so once this applies the vault's value leaves them out.`,
  ];
}

// The most an account grows in one instruction: the runtime's
// MAX_PERMITTED_DATA_INCREASE. extend_state refuses a byte more.
const MAX_STATE_GROWTH_BYTES = 10_240;

// MAX_SIZE_NAME in glam_protocol: a portfolio manager name is 32 bytes.
const PORTFOLIO_MANAGER_NAME_BYTES = 32;

export function installVaultCommands(program: Command, context: CliContext) {
  program
    .command("list")
    .description("List GLAM vaults")
    .option(
      "-o, --owner-only",
      "Only show vaults owned by the connected wallet",
      false,
    )
    .option("-a, --all", "Show all GLAM vaults", false)
    .option(
      "-t, --type <type>",
      "Filter by type: vault, tokenizedVault, or singleAssetVault (case-insensitive)",
    )
    .option("-j, --json", "Output in JSON format", false)
    .action(async ({ ownerOnly, all, type, json }) => {
      if (ownerOnly && all) {
        console.error(
          "Options '--owner-only' and '--all' cannot be used together.",
        );
        process.exit(1);
      }

      const signer = context.glamClient.signer;
      const filterOptions = all
        ? { type }
        : ownerOnly
          ? { owner: signer, type }
          : { owner: signer, delegate: signer, type };

      const glamStates =
        await context.glamClient.fetchGlamStates(filterOptions);

      if (glamStates.length === 0) {
        console.log("No vaults found.");
        return;
      }

      const sorted = glamStates.sort((a, b) =>
        a.launchDate > b.launchDate ? -1 : 1,
      );

      if (json) {
        console.log(
          JSON.stringify(
            sorted.map((s) => ({
              type: s.productType,
              vaultState: s.idStr,
              vaultPda: s.vault.toBase58(),
              launchDate: s.launchDate,
              name: charsToString(s.name),
            })),
            null,
            2,
          ),
        );
        return;
      }

      printTable(
        ["Type", "Vault State", "Vault PDA", "Launch Date", "Name"],
        sorted.map((s) => [
          s.productType,
          s.idStr,
          s.vault.toBase58(),
          s.launchDate,
          printableText(charsToString(s.name)),
        ]),
      );
    });

  program
    .command("set")
    .argument("<state>", "GLAM state public key", validatePublicKey)
    .description("Set the active GLAM vault for subsequent CLI operations")
    .action(async (state: PublicKey) => {
      try {
        context.glamClient.statePda = state;
        const stateModel = await context.glamClient.fetchStateModel();
        context.cliConfig.glamState = state;
        console.log(`Active GLAM state: ${stateModel.idStr}`);
        console.log(`Vault: ${stateModel.vault}`);
      } catch {
        // @ts-expect-error
        context.glamClient.statePda = undefined;
        console.error("Invalid GLAM state public key.");
        process.exit(1);
      }
    });

  program
    .command("update-owner")
    .argument("<new-owner>", "New owner public key", validatePublicKey)
    .option("-n, --name <name>", "New portfolio manager name")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Update the owner of a GLAM vault")
    .action(async (newOwner: PublicKey, options) => {
      // stringToChars keeps the first 32 bytes, which can end inside a
      // character, while the confirmation showed the whole name.
      const nameBytes = Buffer.byteLength(options?.name ?? "", "utf8");
      if (nameBytes > PORTFOLIO_MANAGER_NAME_BYTES) {
        fail(
          `--name must be at most ${PORTFOLIO_MANAGER_NAME_BYTES} bytes of UTF-8, the size of a portfolio manager name; it is ${nameBytes}`,
        );
      }
      const newPortfolioManagerName = options?.name
        ? stringToChars(options.name)
        : undefined;

      const message = newPortfolioManagerName
        ? `Confirm transferring ownership to ${newOwner} (portfolio manager: ${options.name})?`
        : `Confirm transferring ownership to ${newOwner}?`;
      const timelock = await readVaultTimelock(context);

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.state.update(
            {
              owner: newOwner,
              portfolioManagerName: newPortfolioManagerName,
            },
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: timelock.confirm(message),
        },
        timelock.outcome("Vault ownership transferred"),
      );
    });

  const setEnabled = async (enabled: boolean, options: { yes: boolean }) => {
    const stateAccount = await context.glamClient.fetchStateAccount();
    const name = printableText(charsToString(stateAccount.name));

    await executeTxWithErrorHandling(
      () =>
        context.glamClient.access.emergencyAccessUpdate(
          { stateEnabled: enabled },
          context.txOptions,
        ),
      {
        skip: options?.yes,
        message: vaultTimelockOf(stateAccount).confirmAtOnce(
          `Confirm ${enabled ? "enabling" : "disabling"} vault: ${name}`,
        ),
      },
      (txSig) =>
        `GLAM vault ${name} ${enabled ? "enabled" : "disabled"}: ${txSig}`,
    );
  };

  program
    .command("enable")
    .description("Enable a GLAM vault")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .action(async (options) => setEnabled(true, options));

  program
    .command("disable")
    .description("Disable a GLAM vault")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .action(async (options) => setEnabled(false, options));

  // Deprecated: use 'enable' or 'disable' instead
  program
    .command("set-enabled")
    .argument("<enabled>", "New vault state", validateBooleanInput)
    .description("[deprecated] Use 'enable' or 'disable' instead")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .action(async (enabled, options) => {
      console.warn(
        "Warning: 'set-enabled' is deprecated, use 'enable' or 'disable' instead.",
      );
      await setEnabled(enabled, options);
    });

  program
    .command("view")
    .argument("[state]", "GLAM state public key", validatePublicKey)
    .description("View a GLAM product by its state pubkey")
    .option("-c, --compact", "Compact output")
    .action(async (state: PublicKey | null, options) => {
      const glamStateModel = await context.glamClient.fetchStateModel(
        state || context.cliConfig.glamState,
      );
      console.log(
        options?.compact
          ? JSON.stringify(glamStateModel)
          : JSON.stringify(glamStateModel, null, 2),
      );
    });

  program
    .command("create")
    .argument("<path>", "Path to the JSON file", validateFileExists)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Create a new GLAM vault from a json file")
    .action(async (file, options) => {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!json.state && !json.mint) {
        throw new Error(
          "Invalid JSON file: must contain 'state' or 'mint' property",
        );
      }

      const initStateParams = parseStateJson(json);
      const accountType = initStateParams.accountType;
      const accountTypeStr = Object.keys(accountType)[0];

      if (accountType === StateAccountType.VAULT) {
        await executeTxWithErrorHandling(
          async () => {
            const txSig = await context.glamClient.state.initialize(
              initStateParams,
              context.txOptions,
            );
            context.cliConfig.glamState = context.glamClient.statePda;
            console.log("State PDA:", context.glamClient.statePda.toBase58());
            console.log("Vault PDA:", context.glamClient.vaultPda.toBase58());
            return txSig;
          },
          {
            skip: options?.yes,
            message: `Confirm initializing ${accountTypeStr}: ${printableText(charsToString(initStateParams.name))}`,
          },
          (txSig) => `Initialized ${accountTypeStr}: ${txSig}`,
        );
        return;
      }

      const initMintParams = parseMintJson(json, accountType);
      await executeTxWithErrorHandling(
        async () => {
          // mint.initializeWithStateParams creates state with default setup
          // we update state with input after mint initialization to apply state params
          const txSig = await context.glamClient.mint.initializeWithStateParams(
            initMintParams,
            // @ts-expect-error
            initStateParams,
            context.txOptions,
          );
          context.cliConfig.glamState = context.glamClient.statePda;
          console.log("State PDA:", context.glamClient.statePda.toBase58());
          console.log("Vault PDA:", context.glamClient.vaultPda.toBase58());
          console.log("Mint PDA:", context.glamClient.mintPda.toBase58());
          return txSig;
        },
        {
          skip: options?.yes,
          message: `Confirm initializing ${accountTypeStr}: ${printableText(charsToString(initMintParams.name))}`,
        },
        (txSig) => `Initialized ${accountTypeStr}: ${txSig}`,
      );
    });

  program
    .command("extend")
    .argument(
      "<bytes>",
      `Bytes to add, at most ${MAX_STATE_GROWTH_BYTES} in one transaction`,
      (value: string) => {
        // extend_state takes its byte count as a u32 and grows the account
        // by it in one instruction, which the program refuses past the limit.
        const bytes = parseUnsignedNumber(
          value,
          "bytes",
          MAX_STATE_GROWTH_BYTES,
        );
        if (bytes === 0) {
          fail("bytes must be a positive integer");
        }
        return bytes;
      },
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Extend GLAM state account")
    .action(async (bytes, options) => {
      await executeTxWithErrorHandling(
        () => context.glamClient.state.extend(bytes, context.txOptions),
        {
          skip: options?.yes,
          message: `Confirm extending GLAM state ${context.cliConfig.glamState} by ${bytes} bytes`,
        },
        (txSig) =>
          `GLAM state ${context.cliConfig.glamState} extended: ${txSig}`,
      );
    });

  program
    .command("close")
    .argument("[state]", "Vault state public key", validatePublicKey)
    .description("Close a GLAM vault by its state pubkey")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .action(async (state: PublicKey | null, options) => {
      const statePda = state || context.cliConfig.glamState;
      const glamClient = new GlamClient({
        provider: context.glamClient.provider,
        statePda,
        cluster: context.cliConfig.cluster,
        // The same transaction version the session was started with.
        transactionVersion: context.glamClient.transactionVersion,
      });
      recordSentSignatures(glamClient);
      const stateModel = await glamClient.fetchStateModel();

      const preInstructions = new Array<TransactionInstruction>();
      if (stateModel.mint) {
        const closeMintIx = await glamClient.mint.txBuilder.closeMintIx();
        preInstructions.push(closeMintIx);
      }
      await executeTxWithErrorHandling(
        async () => {
          const txSig = await glamClient.state.close({
            ...context.txOptions,
            preInstructions,
          });
          context.cliConfig.glamState = null;
          return txSig;
        },
        {
          skip: options?.yes,
          message: `Confirm closing vault: ${printableText(stateModel.nameStr)}\n  - state: ${statePda}\n  - vault: ${stateModel.vault}`,
        },
        (txSig) => `${printableText(stateModel.nameStr)} closed: ${txSig}`,
      );
    });

  program
    .command("wrap")
    .argument("<amount>", "UI amount of SOL to wrap")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Wrap SOL")
    .action(async (amount: string, options) => {
      const lamports = parsePositiveUiAmount(amount, 9, "amount");

      await executeTxWithErrorHandling(
        () => context.glamClient.vault.wrap(lamports, context.txOptions),
        {
          skip: options?.yes,
          message: `Confirm wrapping ${amount} SOL`,
        },
        (txSig) => `Wrapped ${amount} SOL: ${txSig}`,
      );
    });

  program
    .command("unwrap")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Unwrap all vault wSOL: the wrapped lamports return to the vault, the token account's rent goes to the signer",
    )
    .action(async (options) => {
      await executeTxWithErrorHandling(
        () => context.glamClient.vault.unwrap(context.txOptions),
        {
          skip: options?.yes,
          message: `Confirm unwrapping all wSOL`,
        },
        (txSig) => `wSOL unwrapped: ${txSig}`,
      );
    });

  program
    .command("close-token-accounts")
    .argument(
      "[tokens...]",
      "Token mint address(es) or symbols to close, comma- or space-separated",
    )
    .option("--empty", "Close all empty (zero-balance) token accounts", false)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Close vault token accounts: each account's lamports go to the signer, except a wSOL account's wrapped lamports, which return to the vault",
    )
    .action(async (tokens: string[], options) => {
      let tokenAccountPubkeys: PublicKey[] = [];

      // --empty picks the accounts itself and would drop the tokens given.
      if (options.empty && parseArrayInput(tokens).length > 0) {
        fail(
          "Give token mints or --empty, not both: --empty closes every empty token account of the vault and no other",
        );
      }

      if (options.empty) {
        const vault = context.glamClient.vaultPda;
        const { tokenAccounts } =
          await context.glamClient.getSolAndTokenBalances(vault);
        const emptyAccounts = tokenAccounts.filter((ta) => ta.uiAmount === 0);

        if (emptyAccounts.length === 0) {
          console.log("No empty token accounts to close.");
          return;
        }

        const emptyMints = emptyAccounts.map((ta) => ta.mint);
        const mintInfos = await fetchMintsAndTokenPrograms(
          context.glamClient.connection,
          emptyMints,
        );
        tokenAccountPubkeys = mintInfos.map(
          ({ mint: { address }, tokenProgram }) =>
            context.glamClient.getVaultAta(address, tokenProgram),
        );
      } else if (parseArrayInput(tokens).length > 0) {
        const tokenInputs = parseArrayInput(tokens);
        const mintPubkeys = await Promise.all(
          tokenInputs.map((token) =>
            resolveTokenPublicKey(context.glamClient, token),
          ),
        );
        const mintInfos = await fetchMintsAndTokenPrograms(
          context.glamClient.connection,
          mintPubkeys,
        );
        tokenAccountPubkeys = mintInfos.map(
          ({ mint: { address }, tokenProgram }) =>
            context.glamClient.getVaultAta(address, tokenProgram),
        );
      } else {
        console.error(
          "Provide mint address(es) or use --empty to close all empty token accounts.",
        );
        process.exit(1);
      }

      const count = tokenAccountPubkeys.length;
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.vault.closeTokenAccounts(
            tokenAccountPubkeys,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: `Confirm closing ${count} token account(s)`,
        },
        (txSig) => `Closed ${count} token account(s): ${txSig}`,
      );
    });

  const tokenBalances = async (options: { all?: boolean; json?: boolean }) => {
    const { all, json } = options;
    const vault = context.glamClient.vaultPda;
    const { uiAmount: solUiAmount, tokenAccounts } =
      await context.glamClient.getSolAndTokenBalances(vault);

    const mints = tokenAccounts.map((ta) => ta.mint.toBase58());
    if (!mints.includes(WSOL.toBase58())) {
      mints.push(WSOL.toBase58());
    }

    const jupApi = context.glamClient.jupiterSwap.jupApi;
    const tokenList = await jupApi.fetchTokensList();

    const solPrice = tokenList.getByMint(WSOL)?.usdPrice || 0;
    const rows = [
      {
        token: "SOL",
        mint: "N/A",
        amount: solUiAmount,
        value: solPrice * solUiAmount,
      },
      ...tokenAccounts
        .filter((ta) => all || ta.uiAmount > 0)
        .map((ta) => {
          const mintStr = ta.mint.toBase58();
          const token = tokenList.getByMint(mintStr);
          const tokenSymbol =
            token?.symbol === "SOL" ? "wSOL" : token?.symbol || "Unknown";
          const value = (token?.usdPrice || 0) * ta.uiAmount;
          return {
            token: tokenSymbol,
            mint: mintStr,
            amount: ta.uiAmount,
            value,
          };
        }),
    ];

    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    printTable(
      ["Token", "Mint", "Amount", "Value (USD)"],
      rows.map((r) => [
        r.token,
        r.mint,
        r.token === "SOL" ? r.amount.toFixed(9) : r.amount.toString(),
        r.value ? r.value.toFixed(6) : "NaN",
      ]),
    );
  };

  program
    .command("token-balances")
    .description("Get token balances")
    .option(
      "-a, --all",
      "Show all assets including token accounts with 0 balance",
    )
    .option("-j, --json", "Output in JSON format", false)
    .action(tokenBalances);

  // Deprecated: use 'token-balances' instead
  program
    .command("balances")
    .description("[deprecated] Use 'token-balances' instead")
    .option(
      "-a, --all",
      "Show all assets including token accounts with 0 balance",
    )
    .action(async (options) => {
      console.warn(
        "Warning: 'balances' is deprecated, use 'token-balances' instead.",
      );
      await tokenBalances(options);
    });

  program
    .command("list-assets")
    .description("List vault asset allowlist and corresponding token accounts")
    .action(async () => {
      const state = await context.glamClient.fetchStateAccount();
      const mints = await fetchMintsAndTokenPrograms(
        context.glamClient.connection,
        state.assets,
      );

      const data = mints.map(
        ({ mint: { address, decimals }, tokenProgram }) => {
          const tokenAccount = context.glamClient.getVaultAta(
            address,
            tokenProgram,
          );
          return {
            assetMint: address,
            decimals,
            tokenAccount,
            tokenProgram,
          };
        },
      );
      console.log(JSON.stringify(data, null, 2));
    });

  program
    .command("allowlist-token")
    .alias("allowlist-asset")
    .alias("allowlist-mint")
    .argument("<token>", "Token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a token to vault allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const state = await context.glamClient.fetchStateAccount();
      const timelock = vaultTimelockOf(state);
      const base = timelock.list("assets", state.assets);
      const assetsSet = new PkSet(base.value);

      if (assetsSet.has(token)) {
        console.error(
          `Token ${token} already allowlisted${base.stagedApart ? " in the staged allowlist" : ""}`,
        );
        process.exit(1);
      }

      const assets = Array.from(assetsSet.add(token));

      await executeTxWithErrorHandling(
        () => context.glamClient.state.update({ assets }, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding ${token} to vault allowlist?`,
              ...(base.stagedApart
                ? [editsStagedLine("the vault allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`${token} added to vault allowlist`),
      );
    });

  program
    .command("remove-token")
    .alias("remove-asset")
    .alias("remove-mint")
    .argument("<token>", "Token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a token from vault allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const state = await context.glamClient.fetchStateAccount();

      if (token.equals(state.baseAssetMint)) {
        console.error(
          "Vault base asset token should not be removed from allowlist",
        );
        process.exit(1);
      }

      const timelock = vaultTimelockOf(state);
      const base = timelock.list("assets", state.assets);
      const assetsSet = new PkSet(base.value);
      const removed = assetsSet.delete(token);
      if (!removed) {
        console.error(
          `${token} not found in vault allowlist${base.stagedApart ? " as staged" : ""}`,
        );
        process.exit(1);
      }

      const assets = Array.from(assetsSet);
      const { borrowable } = await context.glamClient.fetchStateModel();
      // The borrowable list as it will stand: a removal staged from it too
      // left the token unpriced once both applied, with neither warning.
      const held = await heldTokenLine(
        context,
        token,
        timelock
          .list("borrowable", borrowable ?? [])
          .value.some((key) => key.equals(token)),
      );
      await executeTxWithErrorHandling(
        () => context.glamClient.state.update({ assets }, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing ${token} from vault allowlist?`,
              ...held,
              ...(base.stagedApart
                ? [editsStagedLine("the vault allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`${token} removed from vault allowlist`),
      );
    });

  program
    .command("allowlist-borrowable-token")
    .alias("allowlist-borrowable-asset")
    .alias("allowlist-borrowable-mint")
    .argument("<token>", "Token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a token to the vault's borrowable allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const stateModel = await context.glamClient.fetchStateModel();
      const timelock = await readVaultTimelock(context);
      const base = timelock.list("borrowable", stateModel.borrowable || []);
      const borrowableSet = new PkSet(base.value);

      if (borrowableSet.has(token)) {
        console.error(
          `Token ${token} already allowlisted as borrowable${base.stagedApart ? " in the staged allowlist" : ""}`,
        );
        process.exit(1);
      }

      const borrowable = Array.from(borrowableSet.add(token));

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.state.update({ borrowable }, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding ${token} to the vault's borrowable allowlist?`,
              ...(base.stagedApart
                ? [editsStagedLine("the borrowable allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`${token} added to the vault's borrowable allowlist`),
      );
    });

  program
    .command("remove-borrowable-token")
    .alias("remove-borrowable-asset")
    .alias("remove-borrowable-mint")
    .argument("<token>", "Token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description(
      "Remove a borrowable token from the vault's borrowable allowlist",
    )
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const stateModel = await context.glamClient.fetchStateModel();
      const timelock = await readVaultTimelock(context);
      const base = timelock.list("borrowable", stateModel.borrowable || []);
      const borrowableSet = new PkSet(base.value);
      const removed = borrowableSet.delete(token);

      if (!removed) {
        console.error(
          `${token} not found in the vault's borrowable allowlist${base.stagedApart ? " as staged" : ""}`,
        );
        process.exit(1);
      }

      const borrowable = Array.from(borrowableSet);
      // The vault allowlist as it will stand, staged removal included.
      const held = await heldTokenLine(
        context,
        token,
        timelock
          .list("assets", stateModel.assets ?? [])
          .value.some((key) => key.equals(token)),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.state.update({ borrowable }, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing ${token} from the vault's borrowable allowlist?`,
              ...held,
              ...(base.stagedApart
                ? [editsStagedLine("the borrowable allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(
          `${token} removed from the vault's borrowable allowlist`,
        ),
      );
    });

  program
    .command("holdings")
    .description("Get all vault holdings")
    .action(async () => {
      const holdings =
        await context.glamClient.price.getVaultHoldings("confirmed");
      console.log(holdings.toJson());
    });
}
