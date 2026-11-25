import {
  bfToDecimal,
  Fraction,
  KAMINO_LENDING_PROTOCOL,
  KaminoLendingPolicy,
  PkMap,
  PkSet,
  U64_MAX_BN,
} from "@glamsystems/glam-sdk";
import { type Command } from "commander";
import {
  type CliContext,
  executeTxWithErrorHandling,
  printPubkeyList,
  resolveTokenMint,
  resolveTokenPublicKey,
} from "../utils";
import {
  editsStagedLine,
  readVaultTimelock,
  type VaultTimelock,
} from "../staging";
import { fail } from "../errors";
import {
  parsePositiveUiAmount,
  parseUnsignedNumber,
  validatePublicKey,
} from "../parsing";
import { PublicKey } from "@solana/web3.js";
import { Decimal } from "decimal.js";

// Kamino Lending numbers its elevation groups 1 to 32, and 0 leaves them.
const KAMINO_ELEVATION_GROUPS = 32;

/** The Kamino lending policy an edit replaces: the staged one under a timelock that holds one. */
async function kaminoLendingPolicyToEdit(
  context: CliContext,
  timelock: VaultTimelock,
) {
  return timelock.policy(
    () => context.glamClient.kaminoLending.fetchPolicy(),
    () => context.glamClient.extKaminoProgram.programId,
    KAMINO_LENDING_PROTOCOL,
    KaminoLendingPolicy.decode,
  );
}

export function installKaminoLendCommands(klend: Command, context: CliContext) {
  klend
    .command("view-policy")
    .description("View Kamino lending policy")
    .action(async () => {
      const policy = await context.glamClient.kaminoLending.fetchPolicy();
      if (!policy) {
        console.log("No policy found");
        process.exit(1);
      }
      printPubkeyList(
        "Kamino lending markets allowlist",
        policy.marketsAllowlist,
      );
      printPubkeyList(
        "Kamino lending borrowable tokens allowlist",
        policy.borrowAllowlist,
      );
    });

  klend
    .command("allowlist-market")
    .argument("<market>", "Kamino lending market public key", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a market to the allowlist")
    .action(async (market, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await kaminoLendingPolicyToEdit(context, timelock);
      const policy = base.value ?? new KaminoLendingPolicy([], []);
      if (policy.marketsAllowlist.find((m) => m.equals(market))) {
        console.error(
          `Kamino market ${market} is already in the allowlist${base.stagedApart ? " as staged" : ""}`,
        );
        process.exit(1);
      }

      policy.marketsAllowlist.push(market);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoLending.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding market ${market}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Kamino lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Kamino market ${market} added to allowlist`),
      );
    });

  klend
    .command("remove-market")
    .argument("<market>", "Kamino lending market public key", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a market from the allowlist")
    .action(async (market, options) => {
      const timelock = await readVaultTimelock(context);
      const base = await kaminoLendingPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        console.error(
          `No policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
        process.exit(1);
      }
      if (!policy.marketsAllowlist.find((m) => m.equals(market))) {
        console.error(
          `Market not in allowlist${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
        process.exit(1);
      }

      policy.marketsAllowlist = policy.marketsAllowlist.filter(
        (m) => !m.equals(market),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoLending.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing market ${market}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Kamino lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Kamino market ${market} removed from allowlist`),
      );
    });

  klend
    .command("allowlist-borrowable-token")
    .alias("allowlist-borrowable-asset")
    .argument("<token>", "Borrowable token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a borrowable token to the allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await kaminoLendingPolicyToEdit(context, timelock);
      const policy = base.value ?? new KaminoLendingPolicy([], []);

      if (policy.borrowAllowlist.find((a) => a.equals(token))) {
        console.error(
          `Borrowable token ${token} is already in the allowlist${base.stagedApart ? " as staged" : ""}`,
        );
        process.exit(1);
      }

      policy.borrowAllowlist.push(token);
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoLending.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm adding borrowable token ${token}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Kamino lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Borrowable token ${token} added to allowlist`),
      );
    });

  klend
    .command("remove-borrowable-token")
    .alias("remove-borrowable-asset")
    .argument("<token>", "Borrowable token mint address or symbol")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a borrowable token from the allowlist")
    .action(async (tokenInput: string, options) => {
      const token = await resolveTokenPublicKey(context.glamClient, tokenInput);
      const timelock = await readVaultTimelock(context);
      const base = await kaminoLendingPolicyToEdit(context, timelock);
      const policy = base.value;
      if (!policy) {
        console.error(
          `No policy found${base.stagedApart ? " in the staged change" : ""}`,
        );
        process.exit(1);
      }
      if (!policy.borrowAllowlist.find((a) => a.equals(token))) {
        console.error(
          `Borrowable token not in allowlist${base.stagedApart ? " as staged" : ""}. Removal not needed.`,
        );
        process.exit(1);
      }

      policy.borrowAllowlist = policy.borrowAllowlist.filter(
        (a) => !a.equals(token),
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoLending.setPolicy(policy, context.txOptions),
        {
          skip: options?.yes,
          message: timelock.confirm(
            [
              `Confirm removing borrowable token ${token}`,
              ...(base.stagedApart
                ? [editsStagedLine("the Kamino lending policy")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(`Borrowable token ${token} removed from allowlist`),
      );
    });

  klend
    .command("init")
    .description("Initialize Kamino user")
    .action(async () => {
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoLending.initUserMetadata(context.txOptions),
        { skip: true },
        (txSig) => `Initialized Kamino user: ${txSig}`,
      );
    });

  klend
    .command("list [market]")
    .description("List Kamino deposits and borrows")
    .action(async (market: string | null) => {
      const vault = context.glamClient.vaultPda;
      const lendingMarket = market ? new PublicKey(market) : undefined;

      const obligations =
        await context.glamClient.kaminoLending.findAndParseObligations(
          vault,
          lendingMarket,
        );

      const reservesSet = new PkSet();
      for (const { activeDeposits, activeBorrows } of obligations) {
        activeDeposits.forEach((d) => reservesSet.add(d.depositReserve));
        activeBorrows.forEach((b) => reservesSet.add(b.borrowReserve));
      }
      const reserves =
        await context.glamClient.kaminoLending.fetchAndParseReserves(
          Array.from(reservesSet),
        );
      const reservesMap = new PkMap<(typeof reserves)[0]>(
        reserves.map((r) => [r.getAddress(), r]),
      );

      for (const obligation of obligations) {
        const { activeDeposits, activeBorrows } = obligation;
        console.log(`Obligation: ${obligation.getAddress()}`);

        let i = 0;
        for (const { depositReserve, depositedAmount } of activeDeposits) {
          const reserve = reservesMap.get(depositReserve);
          if (!reserve) {
            console.error(`Reserve ${depositReserve} not found`);
            process.exit(1);
          }
          const { collateralExchangeRate, liquidity } = reserve;
          const supplyAmount = new Decimal(depositedAmount.toString()).div(
            collateralExchangeRate,
          );
          console.log(
            ` - deposit[${i++}]: ${supplyAmount.toString()} ${liquidity.mintPubkey}`,
          );
        }

        i = 0;
        for (const {
          borrowReserve,
          borrowedAmountSf,
          cumulativeBorrowRateBsf,
        } of activeBorrows) {
          const reserve = reservesMap.get(borrowReserve);
          if (!reserve) {
            console.error(`Reserve ${borrowReserve} not found`);
            process.exit(1);
          }
          const { cumulativeBorrowRate, liquidity } = reserve;
          const obligationCumulativeBorrowRate = bfToDecimal(
            cumulativeBorrowRateBsf,
          );
          const borrowAmount = new Fraction(borrowedAmountSf)
            .toDecimal()
            .mul(cumulativeBorrowRate)
            .div(obligationCumulativeBorrowRate);
          console.log(
            ` - borrow[${i++}]: ${borrowAmount.toString()} ${liquidity.mintPubkey}`,
          );
        }
      }
    });

  klend
    .command("deposit")
    .argument("<market>", "Kamino lending market public key", validatePublicKey)
    .argument("<token>", "Token mint or symbol")
    .argument("<amount>", "UI amount of token to deposit")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Deposit to Kamino Lending market")
    .action(
      async (market: PublicKey, token: string, amount: string, options) => {
        const tokenInfo = await resolveTokenMint(context.glamClient, token);
        const amountBN = parsePositiveUiAmount(
          amount,
          tokenInfo.decimals,
          "amount",
        );
        const tokenMint = new PublicKey(tokenInfo.address);

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.kaminoLending.deposit(
              market,
              tokenMint,
              amountBN,
              context.txOptions,
            ),
          {
            skip: options?.yes,
            message: `Confirm depositing ${amount} ${tokenInfo.symbol}?`,
          },
          (txSig) => `Deposited ${amount} ${tokenInfo.symbol}: ${txSig}`,
        );
      },
    );

  klend
    .command("withdraw")
    .argument("<market>", "Kamino lending market public key", validatePublicKey)
    .argument("<token>", "Token mint or symbol")
    .argument("<amount>", "UI amount of token to withdraw")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Withdraw asset from Kamino Lending market")
    .action(
      async (market: PublicKey, token: string, amount: string, options) => {
        const tokenInfo = await resolveTokenMint(context.glamClient, token);
        const amountBN = parsePositiveUiAmount(
          amount,
          tokenInfo.decimals,
          "amount",
        );
        const tokenMint = new PublicKey(tokenInfo.address);

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.kaminoLending.withdraw(
              market,
              tokenMint,
              amountBN,
              context.txOptions,
            ),
          {
            skip: options?.yes,
            // Kamino Lending reads u64::MAX as the whole deposit of an
            // obligation without borrows, and as the most its borrows leave
            // withdrawable otherwise, which can leave collateral behind.
            message: amountBN.eq(U64_MAX_BN)
              ? `Confirm withdrawing the maximum withdrawable ${tokenInfo.symbol} collateral: an amount of u64::MAX, which Kamino Lending reads when the transaction lands as the whole deposit if the obligation has no borrows, and otherwise as the most its borrows leave withdrawable, which can be less than the deposit`
              : `Confirm withdrawing ${amount} ${tokenInfo.symbol}`,
          },
          (txSig) =>
            amountBN.eq(U64_MAX_BN)
              ? `Withdrew the maximum withdrawable ${tokenInfo.symbol} collateral: ${txSig}`
              : `Withdraw ${amount} ${tokenInfo.symbol}: ${txSig}`,
        );
      },
    );

  klend
    .command("borrow")
    .argument("<market>", "Kamino lending market public key", validatePublicKey)
    .argument("<token>", "Token mint or symbol")
    .argument("<amount>", "UI amount of token to borrow")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Borrow from Kamino Lending market")
    .action(
      async (market: PublicKey, token: string, amount: string, options) => {
        const tokenInfo = await resolveTokenMint(context.glamClient, token);
        const amountBN = parsePositiveUiAmount(
          amount,
          tokenInfo.decimals,
          "amount",
        );
        const tokenMint = new PublicKey(tokenInfo.address);
        // u64::MAX is no amount a reserve lends: Kamino Lending reads it as
        // everything the obligation can borrow, which the user did not state.
        if (amountBN.eq(U64_MAX_BN)) {
          fail(
            "A Kamino Lending borrow of u64::MAX base units borrows as much as the obligation allows; give the amount to borrow",
          );
        }

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.kaminoLending.borrow(
              market,
              tokenMint,
              amountBN,
              context.txOptions,
            ),
          {
            skip: options?.yes,
            message: `Confirm borrowing ${amount} ${tokenInfo.symbol}`,
          },
          (txSig) => `Borrowed ${amount} ${tokenInfo.symbol}: ${txSig}`,
        );
      },
    );

  klend
    .command("repay")
    .argument("<market>", "Kamino lending market public key", validatePublicKey)
    .argument("<token>", "Token mint or symbol")
    .argument("<amount>", "UI amount of token to repay")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Repay loan from Kamino Lending market")
    .action(
      async (market: PublicKey, token: string, amount: string, options) => {
        const tokenInfo = await resolveTokenMint(context.glamClient, token);
        const amountBN = parsePositiveUiAmount(
          amount,
          tokenInfo.decimals,
          "amount",
        );
        const tokenMint = new PublicKey(tokenInfo.address);

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.kaminoLending.repay(
              market,
              tokenMint,
              amountBN,
              context.txOptions,
            ),
          {
            skip: options?.yes,
            // Kamino Lending reads u64::MAX as the whole debt.
            message: amountBN.eq(U64_MAX_BN)
              ? `Confirm repaying the whole ${tokenInfo.symbol} debt: an amount of u64::MAX, which Kamino Lending reads as everything owed when the transaction lands`
              : `Confirm repaying ${amount} ${tokenInfo.symbol}`,
          },
          (txSig) => `Repaid ${amount} ${tokenInfo.symbol}: ${txSig}`,
        );
      },
    );

  klend
    .command("request-elevation-group")
    .argument("<market>", "Kamino lending market public key", validatePublicKey)
    .argument(
      "<elevation-group>",
      `Elevation group number, 1 to ${KAMINO_ELEVATION_GROUPS}, or 0 to leave every group`,
      // The instruction takes a u8, and Kamino Lending refuses a group past
      // the last of its 32.
      (value: string) =>
        parseUnsignedNumber(value, "elevation-group", KAMINO_ELEVATION_GROUPS),
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Request elevation group for an obligation (staging only)")
    .action(async (market: PublicKey, elevationGroup: number, options) => {
      if (!context.glamClient.staging) {
        fail("request-elevation-group is only available on a staging vault");
      }

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoLending.requestElevationGroup(
            market,
            elevationGroup,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: `Confirm requesting elevation group ${elevationGroup} for market ${market}`,
        },
        (txSig) =>
          `Requested elevation group ${elevationGroup} for market ${market}: ${txSig}`,
      );
    });
}
