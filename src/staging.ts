import { type PublicKey } from "@solana/web3.js";

import { type CliContext } from "./utils";

type Field = { name: object; value: object };

const fieldName = (field: Field) => Object.keys(field.name)[0];
const fieldValue = (field: Field) =>
  (Object.values(field.value)[0] as { val: unknown }).val;

export type Acl = {
  integrationProgram: PublicKey;
  protocolsBitmask: number;
  protocolPolicies?: { protocolBitflag: number; data: Buffer | Uint8Array }[];
};

type DelegateEntry = { pubkey: PublicKey };

function policyData(
  acls: Acl[] | undefined,
  program: PublicKey,
  protocol: number,
): Buffer | null {
  const data = acls
    ?.find((acl) => acl.integrationProgram.equals(program))
    ?.protocolPolicies?.find(
      (policy) => Number(policy.protocolBitflag) === protocol,
    )?.data;
  return data ? Buffer.from(data) : null;
}

const UNITS: [number, string][] = [
  [86_400, "day"],
  [3_600, "hour"],
  [60, "minute"],
  [1, "second"],
];

/** Seconds as the confirmations show them: "86400 seconds (1 day)". */
export function describeDuration(seconds: number): string {
  const parts: string[] = [];
  let rest = seconds;
  for (const [size, unit] of UNITS) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
      rest -= count * size;
    }
  }
  const plain = `${seconds} second${seconds === 1 ? "" : "s"}`;
  return seconds < 60 ? plain : `${plain} (${parts.join(" ")})`;
}

/** An edit's starting point: the staged copy while one is staged, else the live value. */
export interface EditBase<T> {
  value: T;
  /** The value is the staged copy, and it differs from the live one. */
  stagedApart: boolean;
}

/**
 * What the vault's timelock does to an owner change. While its duration is above 0,
 * glam_protocol stages every state, ACL, policy and mint change instead of making it, and
 * each staged change moves the time `timelock apply` waits for to the moment it lands plus
 * the duration, for everything staged. Emergency updates apply at once.
 */
export class VaultTimelock {
  constructor(
    readonly duration: number,
    private readonly stagedState: Field[],
    private readonly stagedMint: Field[],
    private readonly liveAcls: Acl[],
  ) {}

  get active(): boolean {
    return this.duration > 0;
  }

  /** What is staged now, named as `glam timelock view` names it. */
  get staged(): string[] {
    return [...this.stagedState, ...this.stagedMint].map(fieldName);
  }

  /** The confirmation of a change the timelock stages, with what staging it does. */
  confirm(message: string): string {
    if (!this.active) {
      return message;
    }
    const lines = [
      message,
      `Vault timelock: ${describeDuration(this.duration)}. The change is staged, not made: \`glam timelock apply\` makes it once ${this.duration} seconds have passed after it lands.`,
    ];
    if (this.staged.length > 0) {
      lines.push(
        `Staging it restarts that wait for what is already staged: ${this.staged.join(", ")}.`,
      );
    }
    return lines.join("\n");
  }

  /** The confirmation of an emergency update, which no timelock delays. */
  confirmAtOnce(message: string): string {
    return this.active
      ? `${message}\nThis applies at once: the vault timelock of ${describeDuration(this.duration)} does not delay it.`
      : message;
  }

  /** The success line, which says when a staged change takes effect. */
  outcome(done: string): (txSig: string) => string {
    return (txSig) =>
      this.active
        ? `${done}, once \`glam timelock apply\` applies the staged change after the timelock: ${txSig}`
        : `${done}: ${txSig}`;
  }

  private stagedField(name: string): Field | undefined {
    return this.stagedState.find((field) => fieldName(field) === name);
  }

  /**
   * The list update_state replaces. glam_protocol replaces the staged list with the one sent,
   * so an edit starts from the staged list while one is staged, or it drops the staged change.
   */
  list(
    name: "assets" | "borrowable",
    live: PublicKey[],
  ): EditBase<PublicKey[]> {
    const staged = this.active ? this.stagedField(name) : undefined;
    if (!staged) {
      return { value: live, stagedApart: false };
    }
    const value = (fieldValue(staged) as PublicKey[]) ?? [];
    const same =
      value.length === live.length &&
      value.every((key) => live.some((other) => other.equals(key)));
    return { value, stagedApart: !same };
  }

  /**
   * The integration list enable_disable_protocols edits: the staged copy
   * while one is staged, else the live list.
   */
  aclsToEdit(): Acl[] {
    const staged = this.active
      ? this.stagedField("integrationAcls")
      : undefined;
    return staged ? ((fieldValue(staged) as Acl[]) ?? []) : this.liveAcls;
  }

  /**
   * Whether a staged copy still lists an integration or a delegate that an
   * emergency update removes. The emergency update edits the live lists only,
   * and `timelock apply` puts the staged lists in their place.
   */
  stagedListHolds(
    kind: "integrationAcls" | "delegateAcls",
    key: PublicKey,
  ): boolean {
    const staged = this.stagedField(kind);
    if (!staged) {
      return false;
    }
    const entries = (fieldValue(staged) as (Acl | DelegateEntry)[]) ?? [];
    return entries.some((entry) =>
      ("integrationProgram" in entry
        ? entry.integrationProgram
        : entry.pubkey
      ).equals(key),
    );
  }

  /**
   * The protocol policy set_protocol_policy replaces. Under a timelock glam_protocol stages a
   * copy of the whole integration list with the first staged change and edits that copy from
   * then on, so an edit starts from the policy in the copy, which can be none. The live policy
   * is read only when no copy is staged, so a staged policy is edited even while the live one
   * does not decode.
   */
  async policy<T>(
    live: () => Promise<T | null>,
    program: () => PublicKey,
    protocol: number,
    decode: (data: Buffer) => T,
  ): Promise<EditBase<T | null>> {
    const staged = this.active
      ? this.stagedField("integrationAcls")
      : undefined;
    if (!staged) {
      return { value: await live(), stagedApart: false };
    }
    const id = program();
    const stagedData = policyData(fieldValue(staged) as Acl[], id, protocol);
    const liveData = policyData(this.liveAcls, id, protocol);
    const same =
      stagedData === null || liveData === null
        ? stagedData === liveData
        : stagedData.equals(liveData);
    return {
      value: stagedData ? decode(stagedData) : null,
      stagedApart: !same,
    };
  }
}

type StateRead = Awaited<
  ReturnType<CliContext["glamClient"]["fetchStateAccount"]>
>;

/** The timelock of a state account already read. */
export function vaultTimelockOf(state: StateRead): VaultTimelock {
  const params = (state.params ?? []) as unknown as Field[][];
  return new VaultTimelock(
    state.timelockDuration,
    params[2] ?? [],
    params[3] ?? [],
    (state.integrationAcls ?? []) as unknown as Acl[],
  );
}

export async function readVaultTimelock(
  context: CliContext,
): Promise<VaultTimelock> {
  return vaultTimelockOf(await context.glamClient.fetchStateAccount());
}

/** The line an edit adds when it starts from a staged copy that differs from the live value. */
export function editsStagedLine(what: string): string {
  return `This edits ${what} as a change already staged leaves it, not the live one.`;
}
