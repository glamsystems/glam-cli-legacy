import { type Command } from "commander";
import { type CliContext, executeTxWithErrorHandling } from "../utils";
import { fail } from "../errors";
import {
  parseNonNegativeInteger,
  parsePositiveInteger,
  parsePositiveUiAmount,
  parseU32,
} from "../parsing";
import { BN } from "@coral-xyz/anchor";
import {
  editsStagedLine,
  readVaultTimelock,
  type VaultTimelock,
} from "../staging";
import {
  bytesToHex,
  CCTP_PROTOCOL,
  CctpPolicy,
  evmAddressToPublicKey,
  publicKeyToEvmAddress,
} from "@glamsystems/glam-sdk";
import { PublicKey } from "@solana/web3.js";

/**
 * The 32 bytes a CCTP destination is sent or stored as: a base58 key with
 * --base58, else 40 hexadecimal digits, an EVM address padded to 32 bytes,
 * or 64, the recipient's own 32 bytes. Read before the confirmation, which
 * shows them.
 */
function parseDestination(value: string, base58?: boolean): PublicKey {
  const address = value.trim();
  try {
    return base58 ? new PublicKey(address) : evmAddressToPublicKey(address);
  } catch (error) {
    fail(
      base58
        ? `destination-address ${address} is not a base58 public key`
        : (error as Error).message,
    );
  }
}

/** The CCTP policy an edit replaces: the staged one under a timelock that holds one. */
async function cctpPolicyToEdit(context: CliContext, timelock: VaultTimelock) {
  return timelock.policy(
    () => context.glamClient.cctp.fetchPolicy(),
    () => context.glamClient.extCctpProgram.programId,
    CCTP_PROTOCOL,
    CctpPolicy.decode,
  );
}

function encodedDestination(destination: PublicKey): string {
  return `0x${bytesToHex(destination.toBytes())}`;
}

/**
 * A stored destination as it reads: an EVM address where its first 12 bytes
 * are zero, and all 32 bytes otherwise, which the address's 20 would cut.
 */
export function shownDestination(destination: PublicKey): string {
  return destination
    .toBytes()
    .subarray(0, 12)
    .every((byte) => byte === 0)
    ? publicKeyToEvmAddress(destination)
    : encodedDestination(destination);
}

export function installCctpCommands(program: Command, context: CliContext) {
  program
    .command("view-policy")
    .description("View CCTP policy")
    .action(async () => {
      const cctpPolicy = await context.glamClient.cctp.fetchPolicy();
      if (!cctpPolicy) {
        console.error("CCTP policy not found");
        process.exit(1);
      }
      console.log("CCTP allowed destinations:");
      for (const destination of cctpPolicy.allowedDestinations) {
        console.log(
          `\t${destination.domain}: ${shownDestination(destination.address)}`,
        );
      }
    });

  program
    .command("allowlist-destination")
    .argument("<domain>", "CCTP domain", (value: string) =>
      parseU32(value, "domain"),
    )
    .argument("<destination-address>", "Destination address")
    .option("--base58", "Address is a base58 string")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Add a destination to the allowlist")
    .action(async (domain, destinationAddress, { base58, yes }) => {
      const destinationPubkey = parseDestination(destinationAddress, base58);

      const timelock = await readVaultTimelock(context);
      const base = await cctpPolicyToEdit(context, timelock);
      const cctpPolicy = base.value ?? new CctpPolicy([]);
      if (
        cctpPolicy.allowedDestinations.find(
          (d) => d.domain === domain && d.address.equals(destinationPubkey),
        )
      ) {
        console.error(
          `Destination address ${destinationAddress} is already in the allowlist${base.stagedApart ? " as staged" : ""}`,
        );
        process.exit(1);
      }

      cctpPolicy.allowedDestinations.push({
        domain,
        address: destinationPubkey,
      });
      await executeTxWithErrorHandling(
        () => context.glamClient.cctp.setPolicy(cctpPolicy, context.txOptions),
        {
          skip: yes,
          message: timelock.confirm(
            [
              `Confirm adding destination ${destinationAddress} (domain ${domain}, stored as ${encodedDestination(destinationPubkey)}) to allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the CCTP allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(
          `Destination ${destinationAddress} (domain ${domain}) added to allowlist`,
        ),
      );
    });

  program
    .command("remove-destination")
    .argument("<domain>", "CCTP domain", (value: string) =>
      parseU32(value, "domain"),
    )
    .argument("<destination-address>", "Destination address")
    .option("--base58", "Address is a base58 string")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Remove a destination from the allowlist")
    .action(async (domain, destinationAddress, { base58, yes }) => {
      const destinationPubkey = parseDestination(destinationAddress, base58);

      const timelock = await readVaultTimelock(context);
      const base = await cctpPolicyToEdit(context, timelock);
      const cctpPolicy = base.value;
      if (!cctpPolicy) {
        console.error(
          `CCTP policy not found${base.stagedApart ? " in the staged change" : ""}`,
        );
        process.exit(1);
      }
      const kept = cctpPolicy.allowedDestinations.filter(
        (d) => !(d.domain === domain && d.address.equals(destinationPubkey)),
      );
      if (kept.length === cctpPolicy.allowedDestinations.length) {
        fail(
          `Destination ${destinationAddress} (domain ${domain}) is not in the allowlist${base.stagedApart ? " as staged" : ""}`,
        );
      }
      cctpPolicy.allowedDestinations = kept;
      await executeTxWithErrorHandling(
        () => context.glamClient.cctp.setPolicy(cctpPolicy, context.txOptions),
        {
          skip: yes,
          message: timelock.confirm(
            [
              `Confirm removing destination ${destinationAddress} (domain ${domain}, stored as ${encodedDestination(destinationPubkey)}) from allowlist`,
              ...(base.stagedApart
                ? [editsStagedLine("the CCTP allowlist")]
                : []),
            ].join("\n"),
          ),
        },
        timelock.outcome(
          `Destination ${destinationAddress} (domain ${domain}) removed from allowlist`,
        ),
      );
    });

  // https://developers.circle.com/cctp/cctp-supported-blockchains#cctp-v2-supported-domains
  program
    .command("bridge-usdc")
    .argument("<amount>", "USDC amount in UI units")
    .argument("<domain>", "CCTP domain", (value: string) =>
      parseU32(value, "domain"),
    )
    .argument("<destination-address>", "Recipient EVM address")
    .option(
      "-m, --max-fee-bps <bps>",
      "Max fee in basis points (default 1, at most 100: the program refuses more)",
      (val) => {
        const parsed = parseNonNegativeInteger(val, "max-fee-bps");
        if (parsed > 100) {
          throw new Error("max-fee-bps must be at most 100");
        }
        return parsed;
      },
      1,
    )
    .option("-b, --base58", "Address is a base58 string")
    .option("-f, --fast", "Fast transfer (lower finality threshold)", false)
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Bridge USDC to an EVM chain")
    .action(
      async (
        amount,
        domain,
        destinationAddress,
        { maxFeeBps, base58, fast, yes },
      ) => {
        const destinationPubkey = parseDestination(destinationAddress, base58);
        const cctpPolicy = await context.glamClient.cctp.fetchPolicy();
        if (
          cctpPolicy &&
          !cctpPolicy.allowedDestinations.find(
            (d) => d.domain === domain && d.address.equals(destinationPubkey),
          )
        ) {
          console.error(
            `Destination (${domain}, ${destinationAddress}) not in allowlist`,
          );
          process.exit(1);
        }

        // https://developers.circle.com/cctp/technical-guide#cctp-finality-thresholds
        const amountBN = parsePositiveUiAmount(amount, 6, "amount");
        const maxFee = amountBN.mul(new BN(maxFeeBps)).div(new BN(10000));
        const minFinalityThreshold = fast ? 1000 : 2000;

        await executeTxWithErrorHandling(
          () =>
            context.glamClient.cctp.bridgeUsdc(
              amountBN,
              domain,
              destinationPubkey,
              {
                maxFee,
                minFinalityThreshold,
              },
              context.txOptions,
            ),
          {
            skip: yes,
            // The fee bound that is sent is the floored amount, not the rate.
            message: `Confirm bridging ${amount} USDC to ${destinationAddress} (domain ${domain}, mint recipient ${encodedDestination(destinationPubkey)}, max fee ${maxFee.toString()} base units at ${maxFeeBps} bps, finality threshold ${minFinalityThreshold})`,
          },
          (txSig) => `USDC burned: ${txSig}`,
        );
      },
    );

  program
    .command("receive")
    .argument("<source-domain>", "Source domain", (value: string) =>
      parseU32(value, "source-domain"),
    )
    .option(
      "-t, --tx-hash <tx-hash>",
      "Transaction hash hex string (start with 0x)",
    )
    .option("-n, --nonce <nonce>", "Nonce hex string (start with 0x)")
    .description(
      "Receive USDC from an EVM chain. Either txHash or nonce is required.",
    )
    .action(async (sourceDomain, { txHash, nonce }) => {
      // The SDK looks the message up by the nonce when it has one, and by
      // the hash otherwise, so one of two would be dropped.
      if (txHash && nonce) {
        fail("Give --tx-hash or --nonce, not both");
      }

      await executeTxWithErrorHandling(
        () =>
          context.glamClient.cctp.receiveUsdc(
            sourceDomain,
            {
              txHash,
              nonce,
            },
            {
              ...context.txOptions,
              lookupTables: [
                new PublicKey("qj4EYgsGpnRdt9rvQW3wWZR8JVaKPg9rG9EB8DNgfz8"), // CCTP lookup table
              ],
            },
          ),
        { skip: true },
        (txSig) => `Received USDC: ${txSig}`,
      );
    });

  program
    .command("list")
    .option(
      "-s, --since-slot <slot>",
      "Fetch events since this slot",
      (value: string) => parseNonNegativeInteger(value, "since-slot"),
    )
    .option(
      "-b, --batch-size <size>",
      "Batch size of RPC requests. Higher values reduce latency but need higher RPC limits",
      (value: string) => parsePositiveInteger(value, "batch-size"),
    )
    .option("-c, --commitment <commitment>", "Commitment level", "confirmed")
    .description("List CCTP events of incoming and outgoing bridge transfers")
    .action(async ({ sinceSlot, commitment, batchSize }) => {
      const incomingEvents =
        await context.glamClient.cctp.getIncomingBridgeEvents({
          batchSize,
          commitment,
          minSlot: sinceSlot,
        });
      const outgoingEvents =
        await context.glamClient.cctp.getOutgoingBridgeEvents({
          batchSize,
          commitment,
          minSlot: sinceSlot,
        });
      console.log(
        JSON.stringify(
          {
            vaultState: context.glamClient.statePda,
            vaultPda: context.glamClient.vaultPda,
            incoming: incomingEvents,
            outgoing: outgoingEvents,
          },
          null,
          2,
        ),
      );
    });
}
