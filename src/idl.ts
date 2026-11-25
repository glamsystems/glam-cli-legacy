import zlib from "zlib";

import { PublicKey } from "@solana/web3.js";
import { type GlamClient } from "@glamsystems/glam-sdk";

/**
 * The Program Metadata program. Programs migrated to anchor v1 close their legacy
 * `anchor:idl` account and publish the IDL through a canonical metadata PDA instead,
 * derived as `[program, seed]` under this program, where the seed is the string "idl"
 * zero-padded to 16 bytes.
 */
export const PROGRAM_METADATA_PROGRAM_ID = new PublicKey(
  "ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S",
);

/**
 * Decompressed-IDL size cap, matching anchor's own limit. Both on-chain channels carry
 * zlib/gzip payloads from accounts an RPC hands us; without an output cap a crafted
 * payload could exhaust memory in the synchronous inflate.
 */
const MAX_IDL_BYTES = 16 * 1024 * 1024;

/**
 * Anchor's legacy IDL-account discriminator: the standard hash convention under the
 * `internal:` namespace (`IdlAccount` is `#[account("internal")]`), i.e.
 * sha256("internal:IdlAccount")[..8]. Verified against the live glam_protocol IDL
 * account. Anchor's own legacy reader skips these bytes unchecked; enforcing them here
 * is strictly more defensive, and a mismatch degrades to null and the program-metadata
 * fallback.
 */
const LEGACY_IDL_DISCRIMINATOR = Buffer.from([
  24, 70, 98, 191, 58, 144, 123, 158,
]);

const IDL_SEED = (() => {
  const seed = Buffer.alloc(16);
  seed.write("idl");
  return seed;
})();

/**
 * SemVer-aware comparison: negative when a < b, positive when a > b, 0 when equal.
 * Lexical string comparison is wrong for versions ("1.9.0" > "1.10.0"); this compares
 * dotted numeric parts, and treats a prerelease as older than its release
 * ("1.2.3-beta" < "1.2.3"), comparing prerelease identifiers per SemVer when both have
 * one. Build metadata (a "+..." suffix) never affects precedence, and only the FIRST
 * hyphen starts the prerelease, so "alpha-beta" stays a single hyphenated identifier.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [string, string | undefined] => {
    const noBuild = v.includes("+") ? v.slice(0, v.indexOf("+")) : v;
    const dash = noBuild.indexOf("-");
    return dash < 0
      ? [noBuild, undefined]
      : [noBuild.slice(0, dash), noBuild.slice(dash + 1)];
  };
  const [aMain, aPre] = split(a);
  const [bMain, bPre] = split(b);
  const aParts = aMain.split(".").map(Number);
  const bParts = bMain.split(".").map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const l = aParts[i] ?? 0;
    const r = bParts[i] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) {
      return a < b ? -1 : a > b ? 1 : 0; // non-numeric part: fall back to lexical
    }
    if (l !== r) {
      return l - r;
    }
  }
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1; // release > prerelease
  if (!bPre) return -1;
  const aIds = aPre.split(".");
  const bIds = bPre.split(".");
  for (let i = 0; i < Math.max(aIds.length, bIds.length); i++) {
    const l = aIds[i];
    const r = bIds[i];
    if (l === undefined) return -1; // shorter prerelease is older
    if (r === undefined) return 1;
    const ln = Number(l);
    const rn = Number(r);
    const lNum = !Number.isNaN(ln) && /^\d+$/.test(l);
    const rNum = !Number.isNaN(rn) && /^\d+$/.test(r);
    if (lNum && rNum) {
      if (ln !== rn) return ln - rn;
    } else if (lNum !== rNum) {
      return lNum ? -1 : 1; // numeric identifiers sort before alphanumeric
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

export const metadataIdlPda = (program: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [program.toBuffer(), IDL_SEED],
    PROGRAM_METADATA_PROGRAM_ID,
  )[0];

/**
 * Decodes the legacy anchor IDL account's payload: authority (32) at offset 8, then
 * u32 data length and a zlib stream.
 */
export function decodeLegacyIdl(data: Buffer): any | null {
  if (data.length < 44) {
    return null;
  }
  if (!data.subarray(0, 8).equals(LEGACY_IDL_DISCRIMINATOR)) {
    return null;
  }
  const dataLength = data.readUInt32LE(40);
  if (dataLength === 0 || dataLength > data.length - 44) {
    return null;
  }
  const decompressed = zlib.inflateSync(data.subarray(44, 44 + dataLength), {
    maxOutputLength: MAX_IDL_BYTES,
  });
  return JSON.parse(decompressed.toString("utf8"));
}

/**
 * Decodes a program-metadata account's payload into IDL JSON, or returns null when the
 * account does not parse as a metadata entry for `expectedProgram`.
 *
 * Metadata account layout: discriminator (1: 0 empty, 1 buffer, 2 metadata), program
 * (32), authority (32), mutable (1), canonical (1), seed (16), encoding (1),
 * compression (1), format (1: 0 none, 1 json, 2 yaml, 3 toml), data source (1: 0
 * direct, 1 url, 2 external), data length (u32 LE), 5 bytes padding, then the payload.
 *
 * Enforced (matching what the write path publishes and what anchor's own reader
 * validates): metadata discriminator, embedded program id, the canonical flag with the
 * "idl" seed this PDA is derived from, json format, and a direct data source — a url or
 * external source carries a pointer, not the document, and must not be parsed as one.
 */
export function decodeMetadataIdl(
  data: Buffer,
  expectedProgram: PublicKey,
): any | null {
  if (data.length < 96) {
    return null;
  }
  if (data[0] !== 2) {
    return null; // not a metadata account (0 empty, 1 buffer)
  }
  const program = new PublicKey(data.subarray(1, 33));
  if (!program.equals(expectedProgram)) {
    return null;
  }
  if (data[66] !== 1 || !data.subarray(67, 83).equals(IDL_SEED)) {
    return null; // not the canonical "idl" entry this PDA derivation promises
  }
  const encoding = data[83]; // 0 none, 1 utf8, 2 base58, 3 base64
  const compression = data[84]; // 0 none, 1 gzip, 2 zlib
  const format = data[85];
  const dataSource = data[86];
  if (encoding > 3 || compression > 2 || format !== 1 || dataSource !== 0) {
    return null;
  }
  const dataLength = data.readUInt32LE(87);
  if (dataLength === 0 || dataLength > data.length - 96) {
    return null;
  }
  const payload = data.subarray(96, 96 + dataLength);

  const decompressed =
    compression === 1
      ? zlib.gunzipSync(payload, { maxOutputLength: MAX_IDL_BYTES })
      : compression === 2
        ? zlib.inflateSync(payload, { maxOutputLength: MAX_IDL_BYTES })
        : payload;
  const text =
    encoding === 3
      ? Buffer.from(decompressed.toString("utf8"), "base64").toString("utf8")
      : encoding === 2
        ? (() => {
            throw new Error("base58-encoded IDL payloads are not supported");
          })()
        : decompressed.toString("utf8");
  return JSON.parse(text);
}

/** Reads the IDL JSON from the legacy anchor IDL account, or null if absent/invalid. */
const fetchLegacyIdl = async (glamClient: GlamClient): Promise<any | null> => {
  const programId = glamClient.protocolProgram.programId;
  const base = PublicKey.findProgramAddressSync([], programId)[0];
  const idlPda = await PublicKey.createWithSeed(base, "anchor:idl", programId);

  const accountInfo =
    await glamClient.provider.connection.getAccountInfo(idlPda);
  if (!accountInfo || !accountInfo.owner.equals(programId)) {
    return null;
  }
  return decodeLegacyIdl(accountInfo.data);
};

/** Reads the IDL JSON from the canonical program-metadata account, or null. */
const fetchMetadataIdl = async (
  glamClient: GlamClient,
): Promise<any | null> => {
  const programId = glamClient.protocolProgram.programId;
  const accountInfo = await glamClient.provider.connection.getAccountInfo(
    metadataIdlPda(programId),
  );
  if (!accountInfo || !accountInfo.owner.equals(PROGRAM_METADATA_PROGRAM_ID)) {
    return null;
  }
  return decodeMetadataIdl(accountInfo.data, programId);
};

export const idlCheck = async (glamClient: GlamClient) => {
  // Both on-chain channels are consulted: the legacy anchor account is authoritative on
  // anchor 0.31, program-metadata after the v1 migration — and an upgrade cannot close
  // the legacy account itself, so a stale legacy copy must not shadow a newer canonical
  // one. The freshest version either channel publishes drives the warning.
  let newest: string | undefined;
  for (const fetcher of [fetchLegacyIdl, fetchMetadataIdl]) {
    try {
      const version = (await fetcher(glamClient))?.metadata?.version;
      if (
        typeof version === "string" &&
        (!newest || compareVersions(version, newest) > 0)
      ) {
        newest = version;
      }
    } catch {
      // A malformed or unreachable on-chain IDL must not break the CLI; the check is
      // advisory.
    }
  }
  if (!newest) {
    return;
  }

  const cliIdlVersion = glamClient.protocolProgram.idl.metadata.version;
  if (compareVersions(cliIdlVersion, newest) < 0) {
    console.warn(
      "CLI is using an older version of the GLAM Protocol IDL. If you experience issues, please update the CLI to the latest version.",
    );
  }
};
