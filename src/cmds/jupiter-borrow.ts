import { BN } from "@coral-xyz/anchor";
import {
  JUPITER_BORROW_PROTOCOL,
  JupiterBorrowPolicy,
} from "@glamsystems/glam-sdk";
import { PublicKey } from "@solana/web3.js";
import { type Command } from "commander";

import {
  type CliContext,
  executeTxWithErrorHandling,
  printPubkeyList,
  printTable,
  resolveTokenMint,
  resolveTokenPublicKey,
} from "../utils";
import {
  editsStagedLine,
  readVaultTimelock,
  type VaultTimelock,
} from "../staging";
import { parsePositiveUiAmount, parseU16, validatePublicKey } from "../parsing";

// Jupiter reads i128::MIN as the whole collateral or the whole debt, and the
// SDK negates the amount of a withdraw or a repay. So 2^127 base units asks
// for all of it: the one amount past u64::MAX those two actions take.
const WHOLE_POSITION = new BN(2).pow(new BN(127));

/** The Jupiter Lend borrow policy an edit replaces: the staged one under a timelock that holds one. */
async function jupiterBorrowPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => context.glamClient.jupiterBorrow.fetchPolicy(),
    () => context.glamClient.extJupiterProgram.programId,
    JUPITER_BORROW_PROTOCOL,
    JupiterBorrowPolicy.decode,
  );
}

export function installJupiterBorrowCommands(
  borrowProgram: Command,
  context: CliContext,
) {
  borrowProgram
    .command("view-policy")
    .description("View Jupiter Lend borrow policy")
    .action(async () => {
      const policy = await context.glamClient.jupiterBorrow.fetchPolicy();
      if (!policy) {
        console.log("No policy found");
        process.exit(1);
      }
      printPubkeyList("Borrow vaults allowlist", policy.vaultsAllowlist);
      printPubkeyList(
        "Collateral tokens allowlist",
        policy.collateralMintsAllowlist,
      );
      printPubkeyList("Borrow tokens allowlist", policy.borrowMintsAllowlist);
    });

  borrowProgram
    .command("list-vaults")
    .description("List all Jupiter Lend borrow vaults")
    .action(async () => {
      const vaults = await context.glamClient.jupiterBorrow.listVaults();
      if (vaults.length === 0) {
        console.log("No Jupiter Lend borrow vaults found");
        return;
      }
      printTable(
        ["Vault ID", "Vault State", "Collateral Mint", "Debt Mint"],
        vaults.map((v) => [
          v.vaultId.toString(),
          v.vaultState.toBase58(),
          v.supplyToken.toBase58(),
          v.borrowToken.toBase58(),
        ]),
      );
    });

  borrowProgram
    .command("list-positions")
    .option(
      "--vault-id <vault-id>",
      "Only list positions for this Jupiter vault_id",
      (value: string) => parseU16(value, "vault-id"),
    )
    .description("List Jupiter Lend borrow positions held by the GLAM vault")
    .action(async (options: { vaultId?: number }) => {
      const positions = await context.glamClient.jupiterBorrow.listPositions(
        options.vaultId,
      );
      if (positions.length === 0) {
        const suffix =
          options.vaultId === undefined ? "" : ` for vault ${options.vaultId}`;
        console.log(`No Jupiter Lend borrow positions found${suffix}`);
        return;
      }
      printTable(
        ["Vault ID", "Position", "Mode", "Tick", "Tick ID"],
        positions.map((p) => [
          p.vaultId.toString(),
          p.pubkey.toBase58(),
          p.isSupplyOnlyPosition ? "Supply-only" : "Borrow",
          p.tick.toString(),
          p.tickId.toString(),
        ]),
      );
    });

  borrowProgram
    .command("allow-vault")
    .argument(
      "<vault>",
      "Jupiter Lend borrow vault public key",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a borrow vault to the allowlist")
    .action(async (vault: PublicKey, options: { yes?: boolean }) => {
      const timelock = await readVaultTimelock(context);
      const base = await jupiterBorrowPolicyToEdit(context, timelock);
      const policy = base.value ?? new JupiterBorrowPolicy([], [], []);
      if (policy.vaultsAllowlist.find((v) => v.equals(vault))) {
        console.error(
          `Vault ${vault} is already in the borrow allowlist${base.stagedApart ? " as staged" : ""}`,
        );
        process.exit(1);
      }
      policy.vaultsAllowlist.push(vault);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterBorrow.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes ?? false,
          message: timelock.confirm(
            [
              `Confirm adding vault ${vault} to Jupiter Lend borrow allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter Lend borrow allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Vault ${vault} added to borrow allowlist`),
      );
    });

  borrowProgram
    .command("remove-vault")
    .argument(
      "<vault>",
      "Jupiter Lend borrow vault public key",
      validatePublicKey,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a borrow vault from the allowlist")
    .action(async (vault: PublicKey, options: { yes?: boolean }) => {
      const timelock = await readVaultTimelock(context);
      const base = await jupiterBorrowPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        console.error(
          `No policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
        process.exit(1);
      }
      if (!policy.vaultsAllowlist.find((v) => v.equals(vault))) {
        console.error(
          `Vault not in borrow allowlist${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
        process.exit(1);
      }
      policy.vaultsAllowlist = policy.vaultsAllowlist.filter(
        (v) => !v.equals(vault),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterBorrow.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes ?? false,
          message: timelock.confirm(
            [
              `Confirm removing vault ${vault} from Jupiter Lend borrow allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter Lend borrow allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Vault ${vault} removed from borrow allowlist`),
      );
    });

  borrowProgram
    .command("allow-collateral")
    .argument("<token>", "Collateral token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a collateral token to the borrow allowlist")
    .action(async (tokenInput: string, options: { yes?: boolean }) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await jupiterBorrowPolicyToEdit(context, timelock);
      const policy = base.value ?? new JupiterBorrowPolicy([], [], []);
      if (policy.collateralMintsAllowlist.find((m) => m.equals(token))) {
        console.error(
          `Collateral token ${token} is already in the borrow allowlist`,
        );
        process.exit(1);
      }
      policy.collateralMintsAllowlist.push(token);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterBorrow.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes ?? false,
          message: timelock.confirm(
            [
              `Confirm adding collateral token ${token} to Jupiter Lend borrow allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter Lend borrow allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Collateral token ${token} added to borrow allowlist`),
      );
    });

  borrowProgram
    .command("remove-collateral")
    .argument("<token>", "Collateral token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a collateral token from the borrow allowlist")
    .action(async (tokenInput: string, options: { yes?: boolean }) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await jupiterBorrowPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        console.error(
          `No policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
        process.exit(1);
      }
      if (!policy.collateralMintsAllowlist.find((m) => m.equals(token))) {
        console.error(
          "Collateral token not in borrow allowlist. Removal not needed.",
        );
        process.exit(1);
      }
      policy.collateralMintsAllowlist = policy.collateralMintsAllowlist.filter(
        (m) => !m.equals(token),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterBorrow.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes ?? false,
          message: timelock.confirm(
            [
              `Confirm removing collateral token ${token} from Jupiter Lend borrow allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter Lend borrow allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(
          `Collateral token ${token} removed from borrow allowlist`,
        ),
      );
    });

  borrowProgram
    .command("allow-borrow-token")
    .alias("allow-borrow-mint")
    .argument("<token>", "Borrowable debt token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a borrowable debt token to the allowlist")
    .action(async (tokenInput: string, options: { yes?: boolean }) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await jupiterBorrowPolicyToEdit(context, timelock);
      const policy = base.value ?? new JupiterBorrowPolicy([], [], []);
      if (policy.borrowMintsAllowlist.find((m) => m.equals(token))) {
        console.error(
          `Borrow token ${token} is already in the borrow allowlist`,
        );
        process.exit(1);
      }
      policy.borrowMintsAllowlist.push(token);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterBorrow.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes ?? false,
          message: timelock.confirm(
            [
              `Confirm adding borrow token ${token} to Jupiter Lend borrow allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter Lend borrow allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Borrow token ${token} added to borrow allowlist`),
      );
    });

  borrowProgram
    .command("remove-borrow-token")
    .alias("remove-borrow-mint")
    .argument("<token>", "Borrowable debt token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a borrowable debt token from the allowlist")
    .action(async (tokenInput: string, options: { yes?: boolean }) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await jupiterBorrowPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        console.error(
          `No policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
        process.exit(1);
      }
      if (!policy.borrowMintsAllowlist.find((m) => m.equals(token))) {
        console.error(
          "Borrow token not in borrow allowlist. Removal not needed.",
        );
        process.exit(1);
      }
      policy.borrowMintsAllowlist = policy.borrowMintsAllowlist.filter(
        (m) => !m.equals(token),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterBorrow.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes ?? false,
          message: timelock.confirm(
            [
              `Confirm removing borrow token ${token} from Jupiter Lend borrow allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the Jupiter Lend borrow allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Borrow token ${token} removed from borrow allowlist`),
      );
    });

  borrowProgram
    .command("init-position")
    .requiredOption(
      "--vault-id <vault-id>",
      "Jupiter Vaults vault ID",
      (value: string) => parseU16(value, "vault-id"),
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Initialize a Jupiter Lend borrow position")
    .action(async (options: { vaultId: number; yes?: boolean }) => {
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.jupiterBorrow.initPosition(
            options.vaultId,
            context.txOptions,
          ),
        {
          skip: options.yes ?? false,
          message: `Confirm Jupiter Lend borrow init-position for vault ${options.vaultId}`,
        },
        (txSig) =>
          `Jupiter Lend borrow position initialized for vault ${options.vaultId}: ${txSig}`,
      );
    });

  type OperateAction = "deposit" | "withdraw" | "borrow" | "repay";

  async function runOperate(
    action: OperateAction,
    amount: string,
    position: PublicKey,
    yes = false,
  ) {
    const positionInfo =
      await context.glamClient.jupiterBorrow.getPosition(position);
    const vault = await context.glamClient.jupiterBorrow.getVault(
      positionInfo.vaultId,
    );
    const isCollateralSide = action === "deposit" || action === "withdraw";
    const tokenMint = isCollateralSide ? vault.supplyToken : vault.borrowToken;
    const token = await resolveTokenMint(
      context.glamClient,
      tokenMint.toBase58(),
    );
    const amountBN = parsePositiveUiAmount(
      amount,
      token.decimals,
      "amount",
      action === "withdraw" || action === "repay" ? WHOLE_POSITION : undefined,
    );

    const sdk = context.glamClient.jupiterBorrow;
    const send = () => {
      switch (action) {
        case "deposit":
          return sdk.deposit(position, amountBN, context.txOptions);
        case "withdraw":
          return sdk.withdraw(position, amountBN, context.txOptions);
        case "borrow":
          return sdk.borrow(position, amountBN, context.txOptions);
        case "repay":
          return sdk.repay(position, amountBN, context.txOptions);
      }
    };

    await executeTxWithErrorHandling(
      send,
      {
        skip: yes,
        message: [
          `Confirm Jupiter Lend borrow ${action}`,
          `position: ${position}`,
          `vault_id: ${vault.vaultId}`,
          amountBN.eq(WHOLE_POSITION)
            ? `amount: the whole ${isCollateralSide ? "collateral" : "debt"} (${amount} ${token.symbol})`
            : `amount: ${amount} ${token.symbol}`,
        ].join("\n"),
      },
      (txSig) =>
        `Jupiter Lend borrow ${action} ${amount} ${token.symbol}: ${txSig}`,
    );
  }

  borrowProgram
    .command("deposit")
    .argument("<amount>", "UI amount of collateral to deposit")
    .requiredOption("--position <pubkey>", "Position PDA", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Deposit collateral into a Jupiter Lend borrow position")
    .action(
      async (amount: string, options: { position: PublicKey; yes?: boolean }) =>
        runOperate("deposit", amount, options.position, options.yes ?? false),
    );

  borrowProgram
    .command("withdraw")
    .argument("<amount>", "UI amount of collateral to withdraw")
    .requiredOption("--position <pubkey>", "Position PDA", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Withdraw collateral from a Jupiter Lend borrow position")
    .action(
      async (amount: string, options: { position: PublicKey; yes?: boolean }) =>
        runOperate("withdraw", amount, options.position, options.yes ?? false),
    );

  borrowProgram
    .command("borrow")
    .argument("<amount>", "UI amount of debt to borrow")
    .requiredOption("--position <pubkey>", "Position PDA", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Borrow debt against a Jupiter Lend borrow position")
    .action(
      async (amount: string, options: { position: PublicKey; yes?: boolean }) =>
        runOperate("borrow", amount, options.position, options.yes ?? false),
    );

  borrowProgram
    .command("repay")
    .argument("<amount>", "UI amount of debt to repay")
    .requiredOption("--position <pubkey>", "Position PDA", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Repay debt on a Jupiter Lend borrow position")
    .action(
      async (amount: string, options: { position: PublicKey; yes?: boolean }) =>
        runOperate("repay", amount, options.position, options.yes ?? false),
    );
}
