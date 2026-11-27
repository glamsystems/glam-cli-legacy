import { BN } from "@coral-xyz/anchor";
import {
  CCTP_PROTOCOL,
  CctpPolicy,
  GLAM_MINT_PROTOCOL,
  JUPITER_SWAP_PROTOCOL,
  JupiterSwapPolicy,
  KAMINO_LENDING_PROTOCOL,
  KAMINO_VAULTS_PROTOCOL,
  KaminoLendingPolicy,
  KaminoVaultsPolicy,
  MintPolicy,
  SPL_TOKEN_PROTOCOL,
  SYSTEM_PROTOCOL,
  TransferPolicy,
  formatBits,
  getExtCctpProgramId,
  getExtKaminoProgramId,
  getExtSplProgramId,
  getGlamMintProgramId,
  getGlamProtocolProgramId,
  type ProtocolPolicyChange,
} from "@glamsystems/glam-sdk";
import { type Connection, type PublicKey } from "@solana/web3.js";

import { shownDestination } from "./cmds/cctp";

/** A stored policy's fields by name, as `timelock view` compares them. */
type PolicyFields = Record<string, unknown>;

/**
 * How this view reads one policy. `fits` says whether the bytes hold exactly
 * what the layout declares, and reads no entry to say it.
 */
type PolicyReader = {
  fits: (data: Buffer) => boolean;
  fields: (data: Buffer) => PolicyFields;
};

const fieldsOf = (policy: object): PolicyFields => ({ ...policy });

const KEY_BYTES = 32;
/** A CCTP destination: a u32 domain and an address. */
const DESTINATION_BYTES = 4 + KEY_BYTES;

/**
 * Walks a stored policy's layout over its bytes without decoding an entry.
 * It throws when a part does not fit what is left.
 */
class StoredLayout {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  /** The bytes no part has taken. */
  get left(): number {
    return this.data.length - this.offset;
  }

  fixed(length: number): this {
    this.take(length);
    return this;
  }

  /** A u32 count, then that many entries of `entryBytes` each. */
  list(entryBytes: number): this {
    const count = this.data.readUInt32LE(this.take(4));
    this.take(count * entryBytes);
    return this;
  }

  /** A Borsh option tag, then the list when the tag is 1. */
  optionalList(entryBytes: number): this {
    const tag = this.data[this.take(1)];
    if (tag > 1) {
      throw new RangeError(`option tag ${tag}`);
    }
    return tag === 1 ? this.list(entryBytes) : this;
  }

  private take(length: number): number {
    if (length > this.left) {
      throw new RangeError(`${length} bytes declared, ${this.left} left`);
    }
    const start = this.offset;
    this.offset += length;
    return start;
  }
}

/** A layout the bytes hold exactly, as Borsh's `try_from_slice` requires. */
const holds =
  (
    walk: (layout: StoredLayout) => StoredLayout,
    left: number[] = [0],
  ): PolicyReader["fits"] =>
  (data) => {
    try {
      return left.includes(walk(new StoredLayout(data)).left);
    } catch {
      return false;
    }
  };

/**
 * The policies this view reads field by field, by integration program and
 * protocol bit. Any other policy is compared by its stored bytes.
 */
function policyReaders(
  staging: boolean,
  auditedMint: boolean,
): Map<string, PolicyReader> {
  const transfer: PolicyReader = {
    fits: holds((layout) => layout.list(KEY_BYTES)),
    fields: (data) => fieldsOf(TransferPolicy.decode(data)),
  };
  const readers: [PublicKey, number, PolicyReader][] = [
    [
      getGlamMintProgramId(staging),
      GLAM_MINT_PROTOCOL,
      {
        // lockupPeriod, maxCap, minSubscription and minRedemption, then the
        // eight bytes after them.
        fits: holds((layout) =>
          layout
            .fixed(4 + 8 + 8 + 8 + 8)
            .optionalList(KEY_BYTES)
            .optionalList(KEY_BYTES),
        ),
        fields: (data) => {
          const { reserved: _reserved, ...fields } = MintPolicy.decode(data);
          if (!auditedMint) {
            return fields;
          }
          // The audited glam_mint reserves all eight bytes after
          // minRedemption. Any other reads the first as pauseOnOverdue.
          const { pauseOnOverdue: _unread, ...read } = fields;
          return read;
        },
      },
    ],
    [getGlamProtocolProgramId(staging), SYSTEM_PROTOCOL, transfer],
    [
      getGlamProtocolProgramId(staging),
      JUPITER_SWAP_PROTOCOL,
      {
        // maxSlippageBps and the allowlist, then maxDeviationBps. The program
        // reads a deviation that is missing or cut to one byte as zero.
        fits: holds(
          (layout) => layout.fixed(2).optionalList(KEY_BYTES),
          [0, 1, 2],
        ),
        fields: (data) => fieldsOf(JupiterSwapPolicy.decode(data)),
      },
    ],
    [getExtSplProgramId(staging), SPL_TOKEN_PROTOCOL, transfer],
    [
      getExtKaminoProgramId(staging),
      KAMINO_LENDING_PROTOCOL,
      {
        fits: holds((layout) => layout.list(KEY_BYTES).list(KEY_BYTES)),
        fields: (data) => fieldsOf(KaminoLendingPolicy.decode(data)),
      },
    ],
    [
      getExtKaminoProgramId(staging),
      KAMINO_VAULTS_PROTOCOL,
      {
        fits: holds((layout) => layout.list(KEY_BYTES)),
        fields: (data) => fieldsOf(KaminoVaultsPolicy.decode(data)),
      },
    ],
    [
      getExtCctpProgramId(staging),
      CCTP_PROTOCOL,
      {
        fits: holds((layout) => layout.list(DESTINATION_BYTES)),
        fields: (data) => ({
          // Shown as `cctp view-policy` shows them.
          allowedDestinations: CctpPolicy.decode(data).allowedDestinations.map(
            ({ domain, address }) => `${domain}: ${shownDestination(address)}`,
          ),
        }),
      },
    ],
  ];
  return new Map(
    readers.map(([program, protocol, reader]) => [
      `${program.toBase58()}:${protocol}`,
      reader,
    ]),
  );
}

function shown(value: unknown): string {
  if (value === null || value === undefined) {
    return "none";
  }
  if (BN.isBN(value)) {
    return value.toString();
  }
  if (typeof (value as { toBase58?: unknown }).toBase58 === "function") {
    return (value as PublicKey).toBase58();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (Array.isArray(value)) {
    return `[${value.map(shown).join(", ")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .map(([name, entry]) => `${name}: ${shown(entry)}`)
      .join(", ")}}`;
  }
  return String(value);
}

/** One line per field that differs; a list's entries as `+` and `-`. */
function fieldChanges(before: PolicyFields, after: PolicyFields): string[] {
  const lines: string[] = [];
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  for (const name of names) {
    const [from, to] = [before[name], after[name]];
    if (Array.isArray(from) && Array.isArray(to)) {
      const [old, next] = [from.map(shown), to.map(shown)];
      const added = next.filter((entry) => !old.includes(entry));
      const removed = old.filter((entry) => !next.includes(entry));
      lines.push(
        ...added.map((entry) => `${name}: + ${entry}`),
        ...removed.map((entry) => `${name}: - ${entry}`),
      );
    } else if (shown(from) !== shown(to)) {
      lines.push(`${name}: ${shown(from)} → ${shown(to)}`);
    }
  }
  return lines;
}

/**
 * A policy's fields, or null for one this view names by its stored sizes: a
 * policy it has no reader for, and one whose bytes do not hold its layout.
 * The SDK's decoders read as many entries as a list declares, whatever the
 * bytes hold: a truncated policy decodes to addresses it does not store, and
 * a large count to a list that does not fit in memory. So nothing is decoded
 * before the layout fits.
 */
function read(reader: PolicyReader | undefined, data: Buffer | null) {
  if (!reader || !data || !reader.fits(data)) {
    return null;
  }
  try {
    return reader.fields(data);
  } catch {
    return null;
  }
}

const bytes = (data: Buffer) =>
  `${data.length} byte${data.length === 1 ? "" : "s"}`;

/**
 * mainnet-beta's genesis hash, which `scripts/deploy_staging.sh` holds as
 * MAINNET_GENESIS.
 */
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/**
 * Whether the vault's glam_mint is the audited deployment: the mint of a
 * vault that is not staging, on mainnet-beta. A localnet runs the current
 * mint under the same id. The cluster is the one the RPC serves, read as its
 * genesis hash, and only where a staged change holds a mint policy, the one
 * policy whose reading depends on it.
 */
export async function runsAuditedMint(
  changes: ProtocolPolicyChange[],
  staging: boolean,
  connection: Pick<Connection, "getGenesisHash">,
): Promise<boolean> {
  if (staging) {
    return false;
  }
  const mint = getGlamMintProgramId(staging);
  const readsMintPolicy = changes.some(
    ({ integrationProgram, protocolBitflag, staged }) =>
      staged !== null &&
      integrationProgram.equals(mint) &&
      protocolBitflag === GLAM_MINT_PROTOCOL,
  );
  return (
    readsMintPolicy &&
    (await connection.getGenesisHash()) === MAINNET_GENESIS_HASH
  );
}

/**
 * What a staged integration list does to the stored policies, for
 * `timelock view`: a heading for each policy it adds, drops or replaces, and
 * under it the fields that differ. A policy this view has no reader for, or
 * whose bytes do not hold its layout, is named with its stored sizes.
 * `auditedMint` says whether the vault's glam_mint is the audited deployment,
 * as `runsAuditedMint` reads it.
 */
export function stagedPolicyLines(
  changes: ProtocolPolicyChange[],
  staging: boolean,
  auditedMint: boolean,
): string[] {
  const readers = policyReaders(staging, auditedMint);
  return changes.flatMap((change) => {
    const { integrationProgram, protocolBitflag, current, staged } = change;
    const protocol =
      change.protocolName === "Unknown"
        ? `protocol bit ${formatBits(protocolBitflag)}`
        : change.protocolName;
    const on = `${integrationProgram.toBase58().slice(0, 8)}...`;
    if (!staged) {
      return [`[-] ${protocol} policy on ${on}: removed`];
    }

    const reader = readers.get(
      `${integrationProgram.toBase58()}:${protocolBitflag}`,
    );
    const after = read(reader, staged);
    const before = current ? read(reader, current) : {};
    const mark = current ? "[~]" : "[+]";
    if (!after || !before) {
      const sizes = current
        ? `${bytes(current)} → ${bytes(staged)}`
        : bytes(staged);
      return [`${mark} ${protocol} policy on ${on}: ${sizes}`];
    }

    const fields = fieldChanges(before, after);
    return fields.length > 0
      ? [
          `${mark} ${protocol} policy on ${on}`,
          ...fields.map((line) => `    ${line}`),
        ]
      : [`${mark} ${protocol} policy on ${on}: stored bytes differ`];
  });
}
