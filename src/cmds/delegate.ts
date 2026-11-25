import { BN } from "@coral-xyz/anchor";
import {
  type DelegateAcl,
  SYSTEM_PROTOCOL,
  formatBits,
  getGlamProtocolProgramId,
  parseProtocolPermissionsBitmask,
  parsePermissionNames,
} from "@glamsystems/glam-sdk";
import { type Command } from "commander";
import {
  type CliContext,
  clusterClock,
  executeTxWithErrorHandling,
  printableText,
  resolvePermissionNames,
  resolveProtocolName,
} from "../utils";
import { parseArrayInput, validatePublicKey } from "../parsing";
import { fail } from "../errors";
import { readVaultTimelock, vaultTimelockOf } from "../staging";
import { type PublicKey } from "@solana/web3.js";

async function handleDelegatePermissions(
  operation: "grant" | "revoke",
  delegate: PublicKey,
  integrationProgram: PublicKey,
  protocolBitflag: number,
  protocolName: string,
  permissionsBitmask: BN,
  permissionNames: string[],
  context: CliContext,
  yes: boolean,
) {
  const action = operation === "grant" ? "Granted" : "Revoked";
  const preposition = operation === "grant" ? "to" : "from";
  const timelock = await readVaultTimelock(context);

  await executeTxWithErrorHandling(
    () =>
      operation === "grant"
        ? context.glamClient.access.grantDelegatePermissions(
            delegate,
            integrationProgram,
            protocolBitflag,
            permissionsBitmask,
            context.txOptions,
          )
        : context.glamClient.access.revokeDelegatePermissions(
            delegate,
            integrationProgram,
            protocolBitflag,
            permissionsBitmask,
            context.txOptions,
          ),
    {
      skip: yes,
      message: timelock.confirm(
        `Confirm ${operation === "grant" ? "granting" : "revoking"} ${delegate} "${permissionNames}" permissions for protocol "${protocolName}"?`,
      ),
    },
    timelock.outcome(
      `${action} ${delegate} "${permissionNames}" permissions ${preposition} ${integrationProgram} for protocol "${protocolName}"`,
    ),
  );
}

// SystemPermissions::CancelTimelock in glam_protocol.
const CANCEL_TIMELOCK = new BN(1 << 3);

/**
 * glam_protocol's emergency update refuses to remove a delegate whose
 * CancelTimelock permission has not expired on the cluster's clock, which a
 * host clock runs apart from; expiresAt 0 never expires.
 */
async function holdsActiveCancelTimelock(
  context: CliContext,
  acl: DelegateAcl,
): Promise<boolean> {
  const program = getGlamProtocolProgramId(context.glamClient.staging);
  const holds = acl.integrationPermissions.some(
    ({ integrationProgram, protocolPermissions }) =>
      integrationProgram.equals(program) &&
      protocolPermissions.some(
        ({ protocolBitflag, permissionsBitmask }) =>
          protocolBitflag === SYSTEM_PROTOCOL &&
          !new BN(permissionsBitmask.toString()).and(CANCEL_TIMELOCK).isZero(),
      ),
  );
  const expiresAt = new BN(acl.expiresAt.toString());
  if (!holds || expiresAt.isZero()) {
    return holds;
  }
  const { unixTimestamp } = await clusterClock(
    context,
    "a delegate's CancelTimelock expiry",
  );
  return expiresAt.gt(unixTimestamp);
}

export function installDelegateCommands(
  delegate: Command,
  context: CliContext,
) {
  delegate
    .command("list")
    .description("List delegates and their permissions")
    .action(async () => {
      const stateModel = await context.glamClient.fetchStateModel();
      const cnt = stateModel.delegateAcls.length;
      console.log(
        `${printableText(stateModel.nameStr)} (${context.glamClient.statePda}) has ${cnt} delegate${cnt > 1 ? "s" : ""}:`,
      );
      for (let [i, acl] of stateModel.delegateAcls.entries()) {
        console.log(`[${i}] ${acl.pubkey}`);

        acl.integrationPermissions.forEach(
          ({ integrationProgram, protocolPermissions }) => {
            console.log(`  Integration: ${integrationProgram}`);

            protocolPermissions.forEach(
              ({ protocolBitflag, permissionsBitmask }) => {
                const { protocol, permissions } =
                  parseProtocolPermissionsBitmask(
                    integrationProgram,
                    protocolBitflag,
                    permissionsBitmask,
                    context.glamClient.staging,
                  );
                const permissionNames =
                  permissions.map((perm) => perm.name).join(", ") ||
                  formatBits(permissionsBitmask);
                console.log(`    ${protocol}: ${permissionNames}`);
              },
            );
          },
        );
      }
    });

  delegate
    .command("grant")
    .argument("<pubkey>", "Delegate pubkey", validatePublicKey)
    .requiredOption(
      "--protocol <name>",
      "Protocol name (e.g., KaminoLend, SplToken, JupiterSwap)",
    )
    .argument(
      "<permissions...>",
      "Permission names for the given protocol, comma- or space-separated",
    )
    .option("-y, --yes", "Skip confirmation prompt")
    .description("Grant delegate permissions for a single protocol")
    .action(
      async (delegate: PublicKey, permissions: string[], { protocol, yes }) => {
        const resolvedProtocol = resolveProtocolName(
          protocol,
          context.glamClient.staging,
        );
        const resolvedPermissions = resolvePermissionNames(
          resolvedProtocol,
          parseArrayInput(permissions),
          context.glamClient.staging,
        );
        const { integrationProgram, protocolBitflag, permissionsBitmask } =
          parsePermissionNames({
            protocolName: resolvedProtocol,
            permissionNames: resolvedPermissions,
            staging: context.glamClient.staging,
          });
        await handleDelegatePermissions(
          "grant",
          delegate,
          integrationProgram,
          protocolBitflag,
          resolvedProtocol,
          permissionsBitmask,
          resolvedPermissions,
          context,
          yes,
        );
      },
    );

  delegate
    .command("revoke")
    .argument("<pubkey>", "Delegate pubkey", validatePublicKey)
    .requiredOption(
      "--protocol <name>",
      "Protocol name (e.g., KaminoLend, SplToken, JupiterSwap)",
    )
    .argument(
      "<permissions...>",
      "Permission names for the given protocol, comma- or space-separated",
    )
    .option("-y, --yes", "Skip confirmation prompt")
    .description("Revoke delegate permissions for a single protocol by name")
    .action(
      async (delegate: PublicKey, permissions: string[], { protocol, yes }) => {
        const resolvedProtocol = resolveProtocolName(
          protocol,
          context.glamClient.staging,
        );
        const resolvedPermissions = resolvePermissionNames(
          resolvedProtocol,
          parseArrayInput(permissions),
          context.glamClient.staging,
        );
        const { integrationProgram, protocolBitflag, permissionsBitmask } =
          parsePermissionNames({
            protocolName: resolvedProtocol,
            permissionNames: resolvedPermissions,
            staging: context.glamClient.staging,
          });
        await handleDelegatePermissions(
          "revoke",
          delegate,
          integrationProgram,
          protocolBitflag,
          resolvedProtocol,
          permissionsBitmask,
          resolvedPermissions,
          context,
          yes,
        );
      },
    );

  delegate
    .command("revoke-all")
    .argument("<pubkey>", "Delegate pubkey", validatePublicKey)
    .option("-y, --yes", "Skip confirmation prompt")
    .description("Revoke delegate access entirely")
    .action(async (delegate: PublicKey, { yes }) => {
      const state = await context.glamClient.fetchStateAccount();
      const timelock = vaultTimelockOf(state);
      const acl = (state.delegateAcls as DelegateAcl[]).find((entry) =>
        entry.pubkey.equals(delegate),
      );
      // The emergency update edits the live list only, and succeeds on a key
      // it does not hold.
      if (!acl) {
        fail(
          `${delegate} is not a delegate of this vault, so an emergency revoke changes nothing${
            timelock.stagedListHolds("delegateAcls", delegate)
              ? `. A change already staged lists it: \`glam delegate revoke\` edits the staged list, and \`glam timelock cancel\` drops the staged changes`
              : ""
          }`,
        );
      }
      if (await holdsActiveCancelTimelock(context, acl)) {
        fail(
          `An emergency revoke cannot remove a delegate that holds an active CancelTimelock permission, and ${delegate} holds one. Revoke it first with \`glam delegate revoke ${delegate} --protocol SystemProgram CancelTimelock\`, which the vault timelock delays`,
        );
      }
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.access.emergencyAccessUpdate(
            { disabledDelegates: [delegate] },
            context.txOptions,
          ),
        {
          skip: yes,
          message: [
            timelock.confirmAtOnce(
              `Confirm revoking all ${delegate} permissions to the vault?`,
            ),
            // The emergency update edits the live list only.
            ...(timelock.stagedListHolds("delegateAcls", delegate)
              ? [
                  `A change already staged still lists ${delegate}: \`glam timelock apply\` puts the staged list in place and brings the delegate back. \`glam timelock cancel\` drops the staged changes.`,
                ]
              : []),
          ].join("\n"),
        },
        (txSig) => `Revoked ${delegate} access: ${txSig}`,
      );
    });
}
