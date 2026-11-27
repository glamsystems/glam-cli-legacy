import { type Command } from "commander";
import {
  type CliContext,
  clusterClock,
  executeTxWithErrorHandling,
  formatUiAmount,
} from "../utils";
import { fail } from "../errors";
import {
  collectPublicKeys,
  parsePositiveUiAmount,
  validatePublicKey,
} from "../parsing";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { U128_MAX_BN, U64_MAX_BN } from "@glamsystems/glam-sdk";

// Kamino Farms scales a direct farm's stake by 10^18 shares a base unit.
const STAKE_WAD = new BN(10).pow(new BN(18));

/**
 * The stake shares an unstake asks for to be paid `amount` base units of the
 * farm token: the amount at the farm's rate, its total active stake over its
 * total staked amount, rounded up. Kamino Farms pays for shares at the same
 * rate rounded down, so shares rounded down could pay less than the amount.
 * A farm with nothing staked converts at 10^18 shares a base unit.
 */
function stakeSharesForAmount(
  farmState: PublicKey,
  amount: BN,
  totalStakedAmount: BN,
  totalActiveStakeScaled: BN,
): BN {
  if (totalStakedAmount.isZero() && !totalActiveStakeScaled.isZero()) {
    fail(
      `Farm ${farmState} has a total staked amount of 0 against ${totalActiveStakeScaled} scaled stake shares, so an unstake would remove shares and return no tokens`,
    );
  }
  const shares =
    totalStakedAmount.isZero() || totalActiveStakeScaled.isZero()
      ? amount.mul(STAKE_WAD)
      : amount
          .mul(totalActiveStakeScaled)
          .add(totalStakedAmount.subn(1))
          .div(totalStakedAmount);
  // The instruction takes its shares as a u128.
  if (shares.gt(U128_MAX_BN)) {
    fail(
      `amount converts to ${shares} scaled stake shares at farm ${farmState}'s rate, more than the u128 maximum of ${U128_MAX_BN}`,
    );
  }
  return shares;
}

// Kamino Farms' locking modes besides none: the lock runs from each user's
// last stake, or from the farm's locking start.
const LOCKING_CONTINUOUS = 1;
const LOCKING_WITH_EXPIRY = 2;
const BPS = new BN(10_000);

/** The fields of a parsed farm state that hold its lock. */
type FarmLock = {
  timeUnit: number;
  lockingMode: BN;
  lockingStartTimestamp: BN;
  lockingDuration: BN;
  lockingEarlyWithdrawalPenaltyBps: BN;
};

/** A point in the farm's time unit. */
function farmTime(timeUnit: number, time: BN): string {
  return timeUnit === 0 ? `unix time ${time}` : `slot ${time}`;
}

/** The farm's time unit, as a span is counted in it. */
function farmUnits(timeUnit: number): string {
  return timeUnit === 0 ? "seconds" : "slots";
}

/**
 * The farm's clock, as Kamino Farms reads it: the Clock sysvar's unix
 * timestamp, an i64 the program takes as a u64, for a farm in seconds, and
 * its slot for a farm in slots.
 */
async function farmClock(context: CliContext, timeUnit: number): Promise<BN> {
  const { slot, unixTimestamp } = await clusterClock(
    context,
    "the farm's early withdrawal penalty",
  );
  return timeUnit === 0 ? unixTimestamp : slot;
}

/**
 * The early withdrawal penalty Kamino Farms applies to an unstake at `now`
 * from a farm that locks its stake, as its get_withdrawal_penalty_bps
 * computes it. Inside the lock the rate is the farm's rate times the time
 * the lock has left over its duration, floored, and before the lock begins
 * and once it has ended there is none. Inside the lock the program refuses a
 * rate of none, of the whole amount and above it. Its arithmetic is in u64s
 * with overflow checks, so an unstake fails where the lock's end or the rate
 * times the time left does not fit in one.
 */
function earlyWithdrawalPenalty(
  farmState: PublicKey,
  farm: FarmLock,
  lastStakeTs: BN,
  now: BN,
) {
  const { lockingMode, lockingDuration, timeUnit } = farm;
  const at = (time: BN) => farmTime(timeUnit, time);
  const rate = farm.lockingEarlyWithdrawalPenaltyBps;
  if (
    !lockingMode.eqn(LOCKING_CONTINUOUS) &&
    !lockingMode.eqn(LOCKING_WITH_EXPIRY)
  ) {
    fail(
      `Farm ${farmState} has locking mode ${lockingMode}, which Kamino Farms does not define, and an unstake from it fails`,
    );
  }
  const begins = lockingMode.eqn(LOCKING_WITH_EXPIRY)
    ? farm.lockingStartTimestamp
    : lastStakeTs;
  const ends = begins.add(lockingDuration);
  if (ends.gt(U64_MAX_BN)) {
    fail(
      `Farm ${farmState} locks the vault's stake for ${lockingDuration} ${farmUnits(timeUnit)} from ${at(begins)}, an end past the u64 maximum, where Kamino Farms' arithmetic overflows and every unstake from the lock fails`,
    );
  }
  const allowed = rate.gtn(0) && rate.lt(BPS);
  const inside = now.gte(begins) && now.lt(ends);
  if (inside && !allowed) {
    fail(
      `Farm ${farmState} locks the vault's stake until ${at(ends)} at an early withdrawal penalty of ${rate} basis points, and Kamino Farms refuses an unstake inside the lock at that rate with ${rate.gt(BPS) ? "InvalidPenaltyPercentage" : "EarlyWithdrawalNotAllowed"}`,
    );
  }
  if (inside && rate.mul(ends.sub(now)).gt(U64_MAX_BN)) {
    fail(
      `Farm ${farmState} charges ${rate} basis points times the ${ends.sub(now)} ${farmUnits(timeUnit)} its lock has left, a product past the u64 maximum, where Kamino Farms' arithmetic overflows and the unstake fails`,
    );
  }
  return {
    begins,
    ends,
    rate,
    allowed,
    // A lock of no length never holds the stake.
    beforeLock: now.lt(begins) && lockingDuration.gtn(0),
    bps: inside ? rate.mul(ends.sub(now)).div(ends.sub(begins)) : new BN(0),
  };
}

export function installKaminoFarmsCommands(
  kfarms: Command,
  context: CliContext,
) {
  kfarms
    .command("list")
    .description("List Kamino farms GLAM vault has unclaimed rewards in")
    .action(async () => {
      const farmStates =
        await context.glamClient.kaminoFarm.findAndParseFarmUserStates(
          context.glamClient.vaultPda,
        );
      const parsedFarms =
        await context.glamClient.kaminoFarm.fetchAndParseFarmStates(
          farmStates.map((f) => f.farmState),
        );

      for (let i = 0; i < farmStates.length; i++) {
        const {
          pubkey: userState,
          farmState,
          unclaimedRewards,
        } = farmStates[i];
        const parsedFarmState = parsedFarms.get(farmState);
        if (!parsedFarmState) {
          console.error(`Farm state ${farmState} not found`);
          process.exit(1);
        }
        const { rewards } = parsedFarmState;
        for (const { index, mint } of rewards) {
          console.log(
            `vaultFarmUser: ${userState}, reward token: ${mint}, unclaimed: ${unclaimedRewards[index]}`,
          );
        }
      }
    });

  kfarms
    .command("harvest")
    .argument(
      "<farm-user-states...>",
      "The vault's farm user states to harvest rewards from, the vaultFarmUser addresses `kamino-farms list` prints (not farm states), comma- or space-separated",
      collectPublicKeys,
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Harvest rewards from Kamino farms")
    .action(async (farmUserStates: PublicKey[], options) => {
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoFarm.harvest(
            farmUserStates,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: `Confirm harvesting farm rewards from ${farmUserStates.length} farm user state${farmUserStates.length === 1 ? "" : "s"}`,
        },
        (txSig) => `Harvested farm rewards: ${txSig}`,
      );
    });

  kfarms
    .command("stake")
    .argument("<farm-state>", "Farm state to stake to", validatePublicKey)
    .argument("<amount>", "UI amount of farm token to stake")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Stake farm token to a Kamino farm that is not delegated")
    .action(async (farmState: PublicKey, amount: string, options) => {
      const farms = await context.glamClient.kaminoFarm.fetchAndParseFarmStates(
        [farmState],
      );
      const parsedFarmState = farms.get(farmState);
      if (!parsedFarmState) {
        throw new Error("Farm state not found");
      }
      const { farmTokenMint, farmTokenDecimals } = parsedFarmState;
      // The SDK builds no stake for a delegated farm, and refused one after
      // the confirmation.
      if (farmTokenMint.equals(PublicKey.default)) {
        fail("Delegated farm is not supported");
      }
      const amountBN = parsePositiveUiAmount(
        amount,
        farmTokenDecimals.toNumber(),
        "amount",
      );

      // Kamino Farms stakes the whole balance of the vault's token account
      // for the u64 maximum, which the confirmation showed as an amount.
      const staked = amountBN.eq(U64_MAX_BN)
        ? `the vault's entire balance of the farm token (${amount.trim()} is the u64 maximum, which Kamino Farms reads as the whole balance)`
        : `${amount} farm tokens`;

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.kaminoFarm.stake(
            amountBN,
            farmState,
            context.txOptions,
          ),
        {
          skip: options?.yes,
          message: `Confirm staking ${staked} to farm ${farmState}`,
        },
        (txSig) => `Staked farm token: ${txSig}`,
      );
    });

  kfarms
    .command("unstake")
    .argument("<farm-state>", "Farm state to unstake from", validatePublicKey)
    .argument("<amount>", "UI amount of farm token to unstake")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Unstake farm token from a Kamino farm that is not delegated")
    .action(async (farmState: PublicKey, amount: string, options) => {
      const farms = await context.glamClient.kaminoFarm.fetchAndParseFarmStates(
        [farmState],
      );
      const parsedFarmState = farms.get(farmState);
      if (!parsedFarmState) {
        throw new Error("Farm state not found");
      }
      const {
        farmTokenMint,
        farmTokenDecimals,
        totalStakedAmount,
        totalActiveStakeScaled,
        withdrawalCooldownPeriod,
        timeUnit,
      } = parsedFarmState;
      // The SDK builds no unstake for a delegated farm, and refused one
      // after the confirmation.
      if (farmTokenMint.equals(PublicKey.default)) {
        fail("Delegated farm is not supported");
      }
      // The SDK withdraws the unstaked tokens in the unstake's transaction.
      // A farm with a cooldown holds them first, so the withdrawal fails and
      // takes the unstake with it.
      if (withdrawalCooldownPeriod > 0) {
        fail(
          `Farm ${farmState} holds unstaked tokens for ${withdrawalCooldownPeriod} ${farmUnits(timeUnit)} before they can be withdrawn, and this command withdraws them in the unstake's own transaction, which then fails`,
        );
      }
      const decimals = farmTokenDecimals.toNumber();
      const amountBN = parsePositiveUiAmount(amount, decimals, "amount");
      // Unstake takes stake shares, which the farm pays at its own rate.
      const shares = stakeSharesForAmount(
        farmState,
        amountBN,
        totalStakedAmount,
        totalActiveStakeScaled,
      );

      // Kamino Farms unstakes the lesser of the shares asked for and the
      // stake, so a request above the stake would pay less than is confirmed.
      // The vault's direct user state in the farm is read by its address. A
      // delegated farm was refused above, and its stakes have no such address.
      const { glamClient } = context;
      const user = (
        await glamClient.kaminoFarm.findAndParseFarmUserStates(
          glamClient.vaultPda,
          [farmState],
        )
      ).find((state) => state.farmState.equals(farmState));
      if (!user || user.activeStakeScaled.lt(shares)) {
        const stake = user?.activeStakeScaled ?? new BN(0);
        const paid = totalActiveStakeScaled.isZero()
          ? new BN(0)
          : stake.mul(totalStakedAmount).div(totalActiveStakeScaled);
        fail(
          `The vault's stake in farm ${farmState} is ${stake} scaled stake shares, which the farm pays as ${formatUiAmount(paid, decimals)} farm tokens, and unstaking ${amount} asks for ${shares} shares. Unstake at most ${formatUiAmount(paid, decimals)}`,
        );
      }

      // What the farm takes from the active stake for the shares, rounded
      // down. Shares rounded up can stand for more than the amount asked for.
      const paid = shares.mul(totalStakedAmount).div(totalActiveStakeScaled);
      const at = (time: BN) => farmTime(timeUnit, time);
      // The clock is read only for a farm that locks its stake.
      const penalty = parsedFarmState.lockingMode.isZero()
        ? null
        : earlyWithdrawalPenalty(
            farmState,
            parsedFarmState,
            user.lastStakeTs,
            await farmClock(context, timeUnit),
          );
      let penaltyNote = "";
      // The rate is read at the clock now, so it is an estimate: a continuous
      // lock restarts at each stake, and one that lands first raises it, from
      // none as well.
      const restarts =
        parsedFarmState.lockingMode.eqn(LOCKING_CONTINUOUS) &&
        parsedFarmState.lockingDuration.gtn(0);
      if (penalty?.beforeLock) {
        penaltyNote = `, with no early withdrawal penalty if it lands before the farm's lock begins at ${at(penalty.begins)}, ${penalty.allowed ? `and at most ${penalty.rate} basis points of them after` : "after which Kamino Farms refuses it"}`;
      } else if (penalty?.bps.gtn(0)) {
        // Kamino Farms keeps the penalty, rounded down, out of the amount.
        const kept = paid.mul(penalty.bps).div(BPS);
        const restart = restarts
          ? `. A stake that lands before this unstake restarts the lock and raises the penalty, up to ${penalty.rate} basis points`
          : "";
        penaltyNote = `, less an early withdrawal penalty estimated at ${penalty.bps} basis points, ${formatUiAmount(kept, decimals)} farm tokens at that rate, which the farm keeps while its lock runs to ${at(penalty.ends)}${restart}`;
      } else if (penalty && restarts) {
        penaltyNote = `, with no early withdrawal penalty at the clock now. A stake that lands before this unstake restarts the lock, ${penalty.allowed ? `and the penalty rises to as much as ${penalty.rate} basis points` : "inside which Kamino Farms refuses the unstake"}`;
      }

      await executeTxWithErrorHandling(
        () =>
          glamClient.kaminoFarm.unstake(shares, farmState, context.txOptions),
        {
          skip: options?.yes,
          message: `Confirm unstaking ${amount} farm tokens from farm ${farmState}, sent as ${shares} scaled stake shares, which take ${formatUiAmount(paid, decimals)} farm tokens from the vault's active stake at the farm's rate${penaltyNote}`,
        },
        (txSig) => `Unstaked farm token: ${txSig}`,
      );
    });
}
