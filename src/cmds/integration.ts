import {
  formatBits,
  getProgramAndBitflagByProtocolName,
  parseProtocolsBitmask,
} from "@glamsystems/glam-sdk";
import { type Command } from "commander";
import {
  type CliContext,
  executeTxWithErrorHandling,
  printableText,
  resolveProtocolName,
} from "../utils";
import { fail } from "../errors";
import { parseArrayInput, validatePublicKey } from "../parsing";
import {
  type Acl,
  type VaultTimelock,
  readVaultTimelock,
  vaultTimelockOf,
} from "../staging";
import { PublicKey } from "@solana/web3.js";

function validateIntegrationProgram(input: string) {
  return validatePublicKey(input);
}

function resolveProtocolNames(
  names: string[],
  staging: boolean,
): Record<string, number> {
  const lookup = getProgramAndBitflagByProtocolName(staging);
  const groups: Record<string, number> = {};

  for (const name of parseArrayInput(names)) {
    const resolved = resolveProtocolName(name, staging);
    const [programIdStr, bitflagStr] = lookup[resolved];
    const bitflag = parseInt(bitflagStr, 2);
    groups[programIdStr] = (groups[programIdStr] || 0) | bitflag;
  }

  return groups;
}

/**
 * The stored policies a removal of protocols deletes from an integration's
 * entry: glam_protocol drops each policy whose protocol it disables, and
 * enabling the protocol again starts with none.
 */
function deletedPolicies(
  acls: Acl[],
  program: PublicKey,
  mask: number,
  staging: boolean,
): string[] {
  const acl = acls.find((entry) => entry.integrationProgram.equals(program));
  return (acl?.protocolPolicies ?? [])
    .filter((policy) => (Number(policy.protocolBitflag) & mask) !== 0)
    .map((policy) => {
      const bitflag = Number(policy.protocolBitflag);
      const name =
        parseProtocolsBitmask(program, bitflag, staging).protocols[0]?.name ??
        `protocol bit ${bitflag}`;
      return `${name} (${policy.data.length} bytes)`;
    });
}

function deletedPoliciesLine(policies: string[]): string[] {
  return policies.length > 0
    ? [
        `This deletes the stored policy of ${policies.join(", ")}; enabling the protocol again starts with no policy.`,
      ]
    : [];
}

/** What a staged copy does to an integration an emergency update removes. */
function stagedComesBack(
  timelock: VaultTimelock,
  program: PublicKey,
): string[] {
  return timelock.stagedListHolds("integrationAcls", program)
    ? [
        `A change already staged still lists ${program}: \`glam timelock apply\` puts the staged list in place and brings it back. \`glam timelock cancel\` drops the staged changes.`,
      ]
    : [];
}

export function installIntegrationCommands(
  integration: Command,
  context: CliContext,
) {
  integration
    .command("list")
    .description("List enabled integration programs and protocols")
    .action(async () => {
      const stateModel = await context.glamClient.fetchStateModel();
      const cnt = stateModel.integrationAcls.length;
      console.log(
        `${printableText(stateModel.nameStr)} (${context.glamClient.statePda}) has ${cnt} integration program${
          cnt > 1 ? "s" : ""
        } enabled:`,
      );
      for (let [
        i,
        { integrationProgram, protocolsBitmask },
      ] of stateModel.integrationAcls.entries()) {
        const { protocols } = parseProtocolsBitmask(
          integrationProgram,
          protocolsBitmask,
          context.glamClient.staging,
        );

        console.log(
          `[${i}] ${integrationProgram}, protocols (${formatBits(
            protocolsBitmask,
          )}): ${protocols.map((p) => p.name).join(", ")}`,
        );
      }
    });

  integration
    .command("enable")
    .description("Enable protocols by name (grouped per integration program)")
    .argument(
      "<protocols...>",
      "Protocol names, comma- or space-separated (e.g., SplToken, JupiterSwap, KaminoLend)",
    )
    .option("-y, --yes", "Skip confirmation")
    .action(async (protocols: string[], { yes }) => {
      const groups = resolveProtocolNames(
        protocols,
        context.glamClient.staging,
      );

      const details = Object.entries(groups).map(([pid, mask]) => {
        const { protocols } = parseProtocolsBitmask(
          new PublicKey(pid),
          mask,
          context.glamClient.staging,
        );
        const names = protocols.map((p) => p.name).join(", ");
        return `${pid} -> ${names}`;
      });

      const timelock = await readVaultTimelock(context);
      const entries = Object.entries(groups);
      for (let i = 0; i < entries.length; i++) {
        const [pid, mask] = entries[i];
        const programId = new PublicKey(pid);
        const { protocols } = parseProtocolsBitmask(
          programId,
          mask,
          context.glamClient.staging,
        );
        const names = protocols.map((p) => p.name).join(", ");
        await executeTxWithErrorHandling(
          () =>
            context.glamClient.access.enableProtocols(
              programId,
              mask,
              context.txOptions,
            ),
          {
            skip: yes || i > 0,
            message: timelock.confirm(
              `Enable protocols from integration programs:\n${details.join("\n")}?`,
            ),
          },
          timelock.outcome(`Enabled ${names} on ${programId}`),
        );
      }
    });

  integration
    .command("disable")
    .description("Disable protocols by name (grouped per integration program)")
    .argument(
      "<protocols...>",
      "Protocol names, comma- or space-separated (e.g., SplToken, JupiterSwap, KaminoLend)",
    )
    .option("-y, --yes", "Skip confirmation")
    .action(async (protocols: string[], { yes }) => {
      const groups = resolveProtocolNames(
        protocols,
        context.glamClient.staging,
      );

      const details = Object.entries(groups).map(([pid, mask]) => {
        const { protocols } = parseProtocolsBitmask(
          new PublicKey(pid),
          mask,
          context.glamClient.staging,
        );
        const names = protocols.map((p) => p.name).join(", ");
        return `${pid} -> ${names}`;
      });

      const timelock = await readVaultTimelock(context);
      const acls = timelock.aclsToEdit();
      const deleted = Object.entries(groups).flatMap(([pid, mask]) =>
        deletedPolicies(
          acls,
          new PublicKey(pid),
          mask,
          context.glamClient.staging,
        ),
      );
      const entries = Object.entries(groups);
      for (let i = 0; i < entries.length; i++) {
        const [pid, mask] = entries[i];
        const programId = new PublicKey(pid);
        const { protocols } = parseProtocolsBitmask(
          programId,
          mask,
          context.glamClient.staging,
        );
        const names = protocols.map((p) => p.name).join(", ");
        await executeTxWithErrorHandling(
          () =>
            context.glamClient.access.disableProtocols(
              programId,
              mask,
              context.txOptions,
            ),
          {
            skip: yes || i > 0,
            message: timelock.confirm(
              [
                `Disable protocols from integration programs:\n${details.join("\n")}?`,
                ...deletedPoliciesLine(deleted),
              ].join("\n"),
            ),
          },
          timelock.outcome(`Disabled ${names} on ${programId}`),
        );
      }
    });

  integration
    .command("disable-all")
    .argument(
      "<integration-program>",
      "Integration program ID",
      (input: string) => validateIntegrationProgram(input),
    )
    .option("-y, --yes", "Skip confirmation")
    .description("Disable all protocols from an integration")
    .action(async (integrationProgram: PublicKey, { yes }) => {
      const state = await context.glamClient.fetchStateAccount();
      const timelock = vaultTimelockOf(state);
      // The emergency update edits the live list only, and succeeds on a
      // program it does not hold.
      const held = (state.integrationAcls as unknown as Acl[]).some((acl) =>
        acl.integrationProgram.equals(integrationProgram),
      );
      if (!held) {
        fail(
          `Integration ${integrationProgram} is not in the vault's integration list, so an emergency disable changes nothing${
            timelock.stagedListHolds("integrationAcls", integrationProgram)
              ? `. A change already staged lists it: \`glam integration disable\` edits the staged list, and \`glam timelock cancel\` drops the staged changes`
              : ""
          }`,
        );
      }
      // The emergency update removes the live entry, every policy with it.
      const deleted = deletedPolicies(
        state.integrationAcls as unknown as Acl[],
        integrationProgram,
        0xffff,
        context.glamClient.staging,
      );
      await executeTxWithErrorHandling(
        () =>
          context.glamClient.access.emergencyAccessUpdate(
            { disabledIntegrations: [integrationProgram] },
            context.txOptions,
          ),
        {
          skip: yes,
          message: [
            timelock.confirmAtOnce(
              `Disable all protocols from integration ${integrationProgram}?`,
            ),
            ...deletedPoliciesLine(deleted),
            ...stagedComesBack(timelock, integrationProgram),
          ].join("\n"),
        },
        (txSig) =>
          `Disabled all protocols from ${integrationProgram}: ${txSig}`,
      );
    });
}
