import { BN } from "@coral-xyz/anchor";
import {
  fromUiAmount,
  MAX_SAFE_INTEGER_BN,
  STRATEGY_DURATION_COUNT,
  U8_MAX,
  U16_MAX,
  U32_MAX,
  U64_MAX_BN,
  U128_MAX_BN,
} from "@glamsystems/glam-sdk";
import { PublicKey } from "@solana/web3.js";
import fs from "fs";

import { fail } from "./errors";

export type ArrayInput = string | readonly string[] | null | undefined;

// The largest values of the two signed widths a program casts an amount to.
export const I64_MAX_BN = new BN(2).pow(new BN(63)).subn(1);
export const I128_MAX_BN = new BN(2).pow(new BN(127)).subn(1);

function labelOrValue(value: unknown, label?: string): string {
  return label ?? String(value);
}

export function parseArrayInput(input: ArrayInput): string[] {
  const rawValues: readonly string[] =
    input === null || input === undefined
      ? []
      : Array.isArray(input)
        ? input
        : [input];

  return rawValues.flatMap((value) =>
    value
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

export function parseRequiredArrayInput(
  input: ArrayInput,
  label: string,
): string[] {
  const parts = parseArrayInput(input);
  if (parts.length === 0) {
    fail(`${label} must contain at least one value`);
  }
  return parts;
}

export function collectArrayValues(
  value: string,
  previous: string[] = [],
): string[] {
  return [...previous, ...parseArrayInput(value)];
}

export function parseInteger(
  value: string,
  label: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    fail(`${label} must be an integer`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(`${label} must be in range [${min}, ${max}]`);
  }
  return parsed;
}

export function parseUnsignedNumber(
  value: string | undefined,
  label = "value",
  max: number = Number.MAX_SAFE_INTEGER,
  defaultValue?: string | number,
): number {
  const raw = value === undefined ? defaultValue : value;
  const trimmed = raw === undefined ? "" : `${raw}`.trim();
  if (!/^\d+$/.test(trimmed)) {
    fail(`${label} must be a non-negative integer`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    fail(`${label} exceeds ${max}`);
  }
  return parsed;
}

export function parseU8(
  value: string | undefined,
  label = "value",
  defaultValue: string | number = 0,
): number {
  return parseUnsignedNumber(value, label, U8_MAX, defaultValue);
}

export function parseU16(
  value: string | undefined,
  label = "value",
  defaultValue: string | number = 0,
): number {
  return parseUnsignedNumber(value, label, U16_MAX, defaultValue);
}

export function parseU32(
  value: string | undefined,
  label = "value",
  defaultValue: string | number = 0,
): number {
  return parseUnsignedNumber(value, label, U32_MAX, defaultValue);
}

export function parseUnsignedBn(value: string, label: string, max?: BN): BN {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    fail(`${label} must be a non-negative integer`);
  }

  const parsed = new BN(trimmed);
  if (max && parsed.gt(max)) {
    fail(`${label} exceeds max value ${max.toString()}`);
  }
  return parsed;
}

export function parseU64(value: string, label: string): BN {
  return parseUnsignedBn(value, label, U64_MAX_BN);
}

export function parseOptionalU64(
  value: string | undefined,
  label: string,
): BN | null {
  return value === undefined ? null : parseU64(value, label);
}

export function parseU128(
  value: string | undefined,
  label: string,
  defaultValue = "0",
): BN {
  return parseUnsignedBn(value ?? defaultValue, label, U128_MAX_BN);
}

export function parseNonNegativeU64(value: string, label: string): BN {
  return parseU64(value, label);
}

export function parseBps(value: string, label = "value"): number {
  return parseU16(value, label);
}

export function parseCbps(value: string, label = "value"): BN {
  return new BN(parseU32(value, label));
}

/**
 * Parse a comma- or space-separated list of Loopscale duration indexes into a
 * deduped list. A strategy has one slot per index 0 to 4, and ext_loopscale
 * allows a duration by its exact index, so a larger one allows nothing.
 */
export function parseDurationIndexes(raw: ArrayInput, label: string): number[] {
  const parts = parseArrayInput(raw);
  if (parts.length === 0) {
    fail(`${label} must contain at least one duration index`);
  }

  const seen = new Set<number>();
  const result: number[] = [];
  for (const part of parts) {
    const index = parseU8(part, label);
    if (index >= STRATEGY_DURATION_COUNT) {
      fail(
        `${label} ${index} names no Loopscale duration: the indexes are 0 (1 day), 1 (1 week), 2 (1 month), 3 (3 months) and 4 (1 year)`,
      );
    }
    if (!seen.has(index)) {
      seen.add(index);
      result.push(index);
    }
  }
  return result;
}

/**
 * A UI amount in base units is a u64 on the wire. A larger one would pass the
 * confirmation and fail only when the instruction is encoded. `alsoTaken` is
 * the one larger value a caller's instruction gives a meaning.
 */
function uiAmountToBaseUnits(
  trimmed: string,
  decimals: number,
  shown: string,
  alsoTaken?: BN,
): BN {
  const parsed = fromUiAmount(trimmed, decimals);
  if (parsed.gt(U64_MAX_BN) && !(alsoTaken && parsed.eq(alsoTaken))) {
    fail(
      `${shown} exceeds the u64 maximum of ${U64_MAX_BN.toString()} base units`,
    );
  }
  return parsed;
}

/**
 * Some amounts leave the SDK as a JavaScript number, which holds an integer
 * exactly up to 2^53 - 1: the amount of a Jupiter quote, and every amount sent
 * to the Loopscale API. For Loopscale the SDK refuses a larger amount only
 * when it builds the request, after the confirmation. For a quote the
 * conversion to a number threw a bn.js assertion.
 */
export function requireSafeIntegerAmount(
  amount: BN,
  label: string,
  taker: string,
): BN {
  if (amount.gt(MAX_SAFE_INTEGER_BN)) {
    fail(
      `${label} exceeds ${MAX_SAFE_INTEGER_BN.toString()} base units, the most the SDK sends to ${taker}`,
    );
  }
  return amount;
}

export function parsePositiveUiAmount(
  value: string,
  decimals: number,
  label?: string,
  alsoTaken?: BN,
): BN {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    fail(`${labelOrValue(value, label)} must be a positive decimal amount`);
  }

  const fractional = trimmed.split(".")[1] ?? "";
  if (fractional.length > decimals) {
    fail(
      `${labelOrValue(value, label)} has more than ${decimals} decimal places`,
    );
  }

  const parsed = uiAmountToBaseUnits(
    trimmed,
    decimals,
    labelOrValue(value, label),
    alsoTaken,
  );
  if (parsed.isZero()) {
    fail(`${labelOrValue(value, label)} must be greater than zero`);
  }
  return parsed;
}

export function parseNonNegativeUiAmount(
  value: string,
  decimals: number,
  label?: string,
): BN {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    fail(`${labelOrValue(value, label)} must be a non-negative decimal amount`);
  }

  const fractional = trimmed.split(".")[1] ?? "";
  if (fractional.length > decimals) {
    fail(
      `${labelOrValue(value, label)} has more than ${decimals} decimal places`,
    );
  }

  return uiAmountToBaseUnits(trimmed, decimals, labelOrValue(value, label));
}

export function parsePositiveInteger(value: string, label?: string): number {
  const parsed = parseUnsignedNumber(value, labelOrValue(value, label));
  if (parsed <= 0) {
    fail(`${labelOrValue(value, label)} must be a positive integer`);
  }
  return parsed;
}

export function parseNonNegativeInteger(value: string, label?: string): number {
  return parseUnsignedNumber(value, labelOrValue(value, label));
}

export function parsePositiveBn(value: string, label?: string, max?: BN): BN {
  const parsed = parseUnsignedBn(value, labelOrValue(value, label), max);
  if (parsed.isZero()) {
    fail(`${labelOrValue(value, label)} must be a positive big integer`);
  }
  return parsed;
}

export function validatePublicKey(value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    console.error("Not a valid pubkey:", value);
    process.exit(1);
  }
}

export function collectPublicKeys(
  value: string,
  previous: PublicKey[] = [],
): PublicKey[] {
  return [...previous, ...parseArrayInput(value).map(validatePublicKey)];
}

export function validateFileExists(path: string): string {
  if (!fs.existsSync(path)) {
    console.error(`File ${path} does not exist`);
    process.exit(1);
  }
  return path;
}

export function validateInvestorAction(
  action: string,
): "subscription" | "redemption" {
  if (action !== "subscription" && action !== "redemption") {
    console.error(`Invalid action. Allowed values: subscription, redemption`);
    process.exit(1);
  }
  return action;
}

export function validateBooleanInput(input: string): boolean {
  const normalized = input.toLowerCase().trim();
  const truthyValues = ["true", "1", "yes", "y", "on", "enable"];
  const falsyValues = ["false", "0", "no", "n", "off", "disable"];

  if (truthyValues.includes(normalized)) return true;
  if (falsyValues.includes(normalized)) return false;

  throw new Error(
    `Invalid boolean value: "${input}". Use: true/false, yes/no, 1/0, enable/disable`,
  );
}

const HEX_DIGITS = /^[0-9a-fA-F]*$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Bytes written as hex, an even number of digits with or without `0x`, or as
 * base64, standard or URL-safe, padded or not. Whitespace inside is dropped,
 * as a pasted value can wrap. Node's decoders stop at an odd hex digit or a
 * stray character, and read any other text as base64, so a slip in either
 * form was sent as other bytes. A string of hex digits alone is hex.
 */
export function parseHexOrBase64Bytes(value: string, label: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  const refusal = new Error(
    `${label} must be hex (an even number of hex digits, 0x optional) or base64`,
  );
  const prefixed = /^0[xX]/.test(compact);
  const digits = prefixed ? compact.slice(2) : compact;
  if (prefixed || HEX_DIGITS.test(digits)) {
    if (digits.length === 0 || digits.length % 2 !== 0) {
      throw refusal;
    }
    if (!HEX_DIGITS.test(digits)) {
      throw refusal;
    }
    return Buffer.from(digits, "hex");
  }

  const encoding = BASE64.test(compact)
    ? "base64"
    : BASE64_URL.test(compact)
      ? "base64url"
      : null;
  if (encoding === null) {
    throw refusal;
  }
  const bytes = Buffer.from(compact, encoding);
  // Node drops the bits a last character holds past the bytes; text that
  // does not encode back to itself is not the bytes it decodes to.
  const unpadded = (text: string) => text.replace(/=+$/, "");
  if (
    bytes.length === 0 ||
    unpadded(bytes.toString(encoding)) !== unpadded(compact)
  ) {
    throw refusal;
  }
  return bytes;
}

export function parseOptionalHexOrBase64Bytes(
  value: string | undefined,
  label: string,
): Buffer | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value.toLowerCase() === "none") {
    return null;
  }

  return parseHexOrBase64Bytes(value, label);
}

export function parseFixedBytes(
  value: string,
  label: string,
  expectedLength: number,
): Buffer {
  const bytes = parseHexOrBase64Bytes(value, label);
  if (bytes.length !== expectedLength) {
    throw new Error(`${label} must decode to exactly ${expectedLength} bytes`);
  }
  return bytes;
}
