import { type Command } from "commander";
import { type CliContext, executeTxWithErrorHandling } from "../utils";
import { describeDuration, readVaultTimelock } from "../staging";
import { runsAuditedMint, stagedPolicyLines } from "../staged-policies";
import { stagedRouteChanges } from "./bridge";
import { type PublicKey } from "@solana/web3.js";
import { parseU32 } from "../parsing";
import {
  type IntegrationAcl,
  type DelegateAcl,
  getProtocolNamesFromBitmask,
  getPermissionNamesFromBitmask,
  compareIntegrationAcls,
  compareDelegateAcls,
  comparePublicKeyArrays,
} from "@glamsystems/glam-sdk";

export function installTimelockCommands(program: Command, context: CliContext) {
  program
    .command("view")
    .description("View current timelock")
    .action(async () => {
      const stateModel = await context.glamClient.fetchStateModel();
      if (!stateModel) {
        console.error("State model not found");
        process.exit(1);
      }

      if (stateModel.timelockExpiresAt) {
        const expiresAt = new Date(stateModel.timelockExpiresAt * 1000);
        const now = new Date();
        const timeRemaining = Math.max(
          0,
          Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
        );
        console.log(
          `Timelock: ${stateModel.timelockDuration} seconds, remaining: ${timeRemaining}s (${Math.floor(timeRemaining / 60)}m ${timeRemaining % 60}s)`,
        );
      } else {
        console.log(`Timelock: ${stateModel.timelockDuration} seconds`);
      }

      if (
        stateModel.pendingStateUpdates &&
        Object.keys(stateModel.pendingStateUpdates).length > 0
      ) {
        console.log("\nPending state updates:");

        for (const [name, value] of Object.entries(
          stateModel.pendingStateUpdates,
        )) {
          if (name === "integrationAcls") {
            // Compare current and staged integrationAcls
            const diff = compareIntegrationAcls(
              stateModel.integrationAcls,
              value as IntegrationAcl[],
              context.glamClient.staging,
            );

            // A staged list can enable the same protocols and store another
            // policy, as a staged minimum subscription does.
            const policyLines = stagedPolicyLines(
              diff.policyChanges,
              context.glamClient.staging,
              await runsAuditedMint(
                diff.policyChanges,
                context.glamClient.staging,
                context.glamClient.connection,
              ),
            );

            if (
              diff.added.length === 0 &&
              diff.removed.length === 0 &&
              diff.modified.length === 0 &&
              policyLines.length === 0
            ) {
              // A list can hold a program, or a protocol's policy, more than
              // once. The program reads the first, so a staged list can
              // differ only in entries it never reads.
              console.log(
                diff.identical
                  ? "  integrationAcls: No changes"
                  : "  integrationAcls: No change to the enabled protocols or the policies the program reads. The stored entries differ.",
              );
              continue;
            }

            console.log("  integrationAcls:");

            // Show added integrations
            if (diff.added.length > 0) {
              console.log("    Added integrations:");
              diff.added.forEach((acl) => {
                const protocols = getProtocolNamesFromBitmask(
                  acl.integrationProgram,
                  acl.protocolsBitmask,
                  context.glamClient.staging,
                );
                console.log(
                  `      [+] ${acl.integrationProgram.toBase58().slice(0, 8)}... (${protocols.join(", ")})`,
                );
              });
            }

            // Show removed integrations
            if (diff.removed.length > 0) {
              console.log("    Removed integrations:");
              diff.removed.forEach((acl) => {
                const protocols = getProtocolNamesFromBitmask(
                  acl.integrationProgram,
                  acl.protocolsBitmask,
                  context.glamClient.staging,
                );
                console.log(
                  `      [-] ${acl.integrationProgram.toBase58().slice(0, 8)}... (${protocols.join(", ")})`,
                );
              });
            }

            // Show modified integrations
            if (diff.modified.length > 0) {
              console.log("    Modified integrations:");
              diff.modified.forEach((mod) => {
                console.log(
                  `      [~] ${mod.integrationProgram.toBase58().slice(0, 8)}...`,
                );
                if (mod.enabledProtocols.length > 0) {
                  console.log(
                    `          Enabling: ${mod.enabledProtocols.join(", ")}`,
                  );
                }
                if (mod.disabledProtocols.length > 0) {
                  console.log(
                    `          Disabling: ${mod.disabledProtocols.join(", ")}`,
                  );
                }
              });
            }

            // Show added, removed and replaced policies
            if (policyLines.length > 0) {
              console.log("    Policy changes (amounts in base units):");
              policyLines.forEach((line) => console.log(`      ${line}`));
            }
          } else if (name === "delegateAcls") {
            // Compare current and staged delegateAcls
            const diff = compareDelegateAcls(
              stateModel.delegateAcls,
              value as DelegateAcl[],
              context.glamClient.staging,
            );

            if (
              diff.added.length === 0 &&
              diff.removed.length === 0 &&
              diff.modified.length === 0
            ) {
              console.log("  delegateAcls: No changes");
              continue;
            }

            console.log("  delegateAcls:");

            // Show added delegates
            if (diff.added.length > 0) {
              console.log("    Added delegates:");
              diff.added.forEach((acl) => {
                console.log(
                  `      [+] ${acl.pubkey.toBase58().slice(0, 8)}...`,
                );
                const expiresAt = new Date(acl.expiresAt.toNumber() * 1000);
                console.log(`          Expires: ${expiresAt.toISOString()}`);
                if (acl.integrationPermissions.length > 0) {
                  console.log("          Permissions:");
                  acl.integrationPermissions.forEach((intPerm) => {
                    intPerm.protocolPermissions.forEach((protoPerm) => {
                      const protocolNames = getProtocolNamesFromBitmask(
                        intPerm.integrationProgram,
                        protoPerm.protocolBitflag,
                        context.glamClient.staging,
                      );
                      const permissions = getPermissionNamesFromBitmask(
                        intPerm.integrationProgram,
                        protoPerm.protocolBitflag,
                        protoPerm.permissionsBitmask,
                        context.glamClient.staging,
                      );
                      console.log(
                        `            ${protocolNames[0] || "Unknown"}: ${permissions.join(", ")}`,
                      );
                    });
                  });
                }
              });
            }

            // Show removed delegates
            if (diff.removed.length > 0) {
              console.log("    Removed delegates:");
              diff.removed.forEach((acl) => {
                console.log(
                  `      [-] ${acl.pubkey.toBase58().slice(0, 8)}...`,
                );
              });
            }

            // Show modified delegates
            if (diff.modified.length > 0) {
              console.log("    Modified delegates:");
              diff.modified.forEach((mod) => {
                console.log(
                  `      [~] ${mod.pubkey.toBase58().slice(0, 8)}...`,
                );

                // Show expiration changes
                if (!mod.currentExpiresAt.eq(mod.stagedExpiresAt)) {
                  const currentExpires = new Date(
                    mod.currentExpiresAt.toNumber() * 1000,
                  );
                  const stagedExpires = new Date(
                    mod.stagedExpiresAt.toNumber() * 1000,
                  );
                  console.log(
                    `          Expiration: ${currentExpires.toISOString()} → ${stagedExpires.toISOString()}`,
                  );
                }

                // Show permission changes
                if (mod.permissionChanges.length > 0) {
                  console.log("          Permission changes:");
                  mod.permissionChanges.forEach((change) => {
                    console.log(`            ${change.protocolName}:`);
                    if (change.addedPermissions.length > 0) {
                      console.log(
                        `              Adding: ${change.addedPermissions.join(", ")}`,
                      );
                    }
                    if (change.removedPermissions.length > 0) {
                      console.log(
                        `              Removing: ${change.removedPermissions.join(", ")}`,
                      );
                    }
                  });
                }
              });
            }
          } else if (name === "assets" || name === "borrowable") {
            const { added, removed } = comparePublicKeyArrays(
              (stateModel[name] as PublicKey[] | null) || [],
              value as PublicKey[],
            );

            if (added.length === 0 && removed.length === 0) {
              console.log(`  ${name}: No changes`);
            } else {
              console.log(`  ${name}:`);
              added.forEach((pk) => {
                console.log(`    [+] ${pk.toBase58()}`);
              });
              removed.forEach((pk) => {
                console.log(`    [-] ${pk.toBase58()}`);
              });
            }
          } else if (name === "timelockDuration") {
            console.log(
              `  ${name}: ${stateModel.timelockDuration}s → ${value}s`,
            );
          } else {
            // For other fields, just show that they have pending changes
            console.log(`  ${name}: Has pending changes`);
          }
        }
      } else {
        console.log("\nNo pending state updates.");
      }

      // A bridge protocol's stored policy is a hash of its route set, so a staged route set
      // shows above as a policy of other bytes, and the routes are compared here.
      if (stateModel.pendingStateUpdates?.integrationAcls) {
        const routeLines = await stagedRouteChanges(context);
        if (routeLines.length > 0) {
          console.log(`\n${routeLines.join("\n")}`);
        }
      }
    });

  program
    .command("set")
    .argument("<duration>", "Timelock duration in seconds", (value) =>
      parseU32(value, "duration"),
    )
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Set timelock duration")
    .action(async (duration: number, { yes }) => {
      const timelock = await readVaultTimelock(context);
      const question = `Set timelock to ${describeDuration(duration)}?`;
      // Without a timelock the new duration applies at once, and from then on
      // every owner change waits for it, a shorter timelock included.
      const message = timelock.active
        ? timelock.confirm(
            `${question} Until it is applied, the current timelock of ${describeDuration(timelock.duration)} stays in force.`,
          )
        : duration > 0
          ? `${question} The vault has no timelock, so this applies at once. From then on every owner change waits ${duration} seconds after it lands before it can be applied, a change of this timelock included.`
          : question;
      await executeTxWithErrorHandling(
        () => context.glamClient.timelock.set(duration, context.txOptions),
        {
          skip: yes,
          message,
        },
        timelock.outcome("Timelock updated"),
      );
    });

  program
    .command("apply")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Apply timelocked changes")
    .action(async ({ yes }) => {
      await executeTxWithErrorHandling(
        () => context.glamClient.timelock.apply(context.txOptions),
        {
          skip: yes,
          message: "Apply timelocked changes?",
        },
        (txSig) => `Timelock applied: ${txSig}`,
      );
    });

  program
    .command("cancel")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .description("Cancel pending timelocked changes")
    .action(async ({ yes }) => {
      await executeTxWithErrorHandling(
        () => context.glamClient.timelock.cancel(context.txOptions),
        {
          skip: yes,
          message: "Cancel pending timelocked changes?",
        },
        (txSig) => `Timelock cancelled: ${txSig}`,
      );
    });
}
