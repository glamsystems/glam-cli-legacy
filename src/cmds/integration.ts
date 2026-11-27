import {
  formatBits,
  getProgramAndBitflagByProtocolName,
  getProtocolsAndPermissions,
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

/** A protocol by the integration program that hosts it and its bit. */
type HostedProtocol = { program: PublicKey; bitflag: number };

/** Every protocol that carries a name. Two programs name a protocol "CCTP". */
function protocolsNamed(name: string, staging: boolean): HostedProtocol[] {
  return Object.entries(getProtocolsAndPermissions(staging)).flatMap(
    ([programId, protocols]) =>
      Object.entries(protocols)
        .filter(([, protocol]) => protocol.name === name)
        .map(([bitflag]) => ({
          program: new PublicKey(programId),
          bitflag: parseInt(bitflag, 2),
        })),
  );
}

/**
 * Whether a list enables a protocol, as glam_protocol reads it: any entry
 * for the program that holds the protocol's bit.
 */
function enables(acls: Acl[], { program, bitflag }: HostedProtocol): boolean {
  return acls.some(
    (acl) =>
      acl.integrationProgram.equals(program) &&
      (acl.protocolsBitmask & bitflag) !== 0,
  );
}

/**
 * The protocols `integration disable` removes for the names given, grouped
 * per integration program, and what to tell the user about them.
 *
 * A name one program carries means that program's protocol. A name two
 * programs carry means the one the list to edit enables: the deployment's
 * own where the list enables it, and the other where the list enables only
 * that. CLI 1.3.0 enabled ext_bridge's protocol for the name CCTP on a
 * production vault, and disabling ext_cctp's there changes nothing.
 */
function protocolsToDisable(
  names: string[],
  staging: boolean,
  acls: Acl[],
): { groups: Record<string, number>; notes: string[] } {
  const lookup = getProgramAndBitflagByProtocolName(staging);
  const groups: Record<string, number> = {};
  const notes: string[] = [];

  for (const name of names) {
    const [programIdStr, bitflagStr] = lookup[name];
    const byDeployment: HostedProtocol = {
      program: new PublicKey(programIdStr),
      bitflag: parseInt(bitflagStr, 2),
    };
    const enabledElsewhere = protocolsNamed(name, staging).filter(
      (protocol) =>
        !protocol.program.equals(byDeployment.program) &&
        enables(acls, protocol),
    );

    let target = byDeployment;
    if (enabledElsewhere.length > 0) {
      const elsewhere = enabledElsewhere
        .map(({ program }) => program.toBase58())
        .join(", ");
      if (enables(acls, byDeployment)) {
        notes.push(
          `Note: ${name} is also enabled on ${elsewhere}. This disables it on ${byDeployment.program} only. Run the command again to disable it there too.`,
        );
      } else {
        [target] = enabledElsewhere;
        notes.push(
          `Note: ${name} is enabled on ${target.program}, not on ${byDeployment.program}. This disables it on ${target.program}.`,
        );
      }
    }

    const programId = target.program.toBase58();
    groups[programId] = (groups[programId] || 0) | target.bitflag;
  }

  return { groups, notes };
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

/**
 * What to do about a program that only the staged list holds, which an
 * emergency disable does not reach. `integration disable` picks its program
 * from the names it is given, so the hint asks what that command would act on
 * and names it only where that is this program's whole staged entry.
 */
function stagedOnlyHint(
  timelock: VaultTimelock,
  program: PublicKey,
  staging: boolean,
): string {
  const cancel = "`glam timelock cancel` drops the staged changes";
  const acls = timelock.aclsToEdit();
  const mask = acls
    .filter((acl) => acl.integrationProgram.equals(program))
    .reduce((bits, acl) => bits | acl.protocolsBitmask, 0);
  if (mask === 0) {
    return `A change already staged lists it, and ${cancel}`;
  }

  const id = program.toBase58();
  const lookup = getProgramAndBitflagByProtocolName(staging);
  const names = parseProtocolsBitmask(program, mask, staging).protocols.map(
    ({ name }) => name,
  );
  const command = `\`glam integration disable ${names.join(" ")}\``;
  const groups = names.every((name) => lookup[name])
    ? protocolsToDisable(names, staging, acls).groups
    : {};
  const targets = Object.keys(groups);
  if (targets.length === 1 && groups[id] === mask) {
    return `A change already staged lists it: ${command} removes it from the staged list, and ${cancel}`;
  }

  const others = targets.filter((target) => target !== id);
  return [
    "A change already staged lists it.",
    ...(others.length > 0
      ? [`${command} would act on ${targets.join(", ")} there.`]
      : []),
    `An SDK caller removes it from the staged list alone with \`client.access.disableProtocols(new PublicKey("${id}"), 0b${formatBits(mask)})\`, which restarts the timelock's wait for what is already staged, and ${cancel}`,
  ].join(" ");
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
      const staging = context.glamClient.staging;
      const requested = parseArrayInput(protocols).map((name) =>
        resolveProtocolName(name, staging),
      );

      // The program to edit is read from the list the change applies to.
      const timelock = await readVaultTimelock(context);
      const acls = timelock.aclsToEdit();
      const { groups, notes } = protocolsToDisable(requested, staging, acls);
      notes.forEach((note) => console.log(note));

      const details = Object.entries(groups).map(([pid, mask]) => {
        const { protocols } = parseProtocolsBitmask(
          new PublicKey(pid),
          mask,
          context.glamClient.staging,
        );
        const names = protocols.map((p) => p.name).join(", ");
        return `${pid} -> ${names}`;
      });

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
              ? `. ${stagedOnlyHint(timelock, integrationProgram, context.glamClient.staging)}`
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
