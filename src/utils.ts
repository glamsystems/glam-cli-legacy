import { AnchorError, BN, utils as anchorUtils } from "@coral-xyz/anchor";
import {
  ClusterNetwork,
  type GlamClient,
  stringToChars,
  type PriorityLevel,
  StateAccountType,
  type TxOptions,
  getProgramAndBitflagByProtocolName,
  getProtocolsAndPermissions,
  getGlamProtocolProgramId,
  parseTxError as sdkParseTxError,
  type TokenListItem,
  fetchMintAndTokenProgram,
  getPriorityFeeEstimate,
} from "@glamsystems/glam-sdk";
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { type InitMintParams } from "anchor/src/client/mint";
import { type InitStateParams } from "anchor/src/client/state";
import { type Command } from "commander";
import fs from "fs";
import inquirer from "inquirer";
import os from "os";
import path from "path";

import { fail } from "./errors";
import { parseArrayInput } from "./parsing";

export interface CliContext {
  cliConfig: CliConfig;
  glamClient: GlamClient;
  txOptions: TxOptions;
}

export class CliConfig {
  cluster: ClusterNetwork;
  json_rpc_url: string;
  tx_rpc_url: string;
  websocket_disabled: boolean;
  keypair_path: string; // deprecated, use wallet instead
  wallet: string; // "/path/to/keypair" or "usb://ledger"
  ledger_derivation_path?: string;
  glam_staging?: boolean;
  priority_fee?: {
    micro_lamports?: number;
    level?: PriorityLevel;
    helius_api_key?: string;
  };
  glam_state?: string;
  jupiter_api_key?: string;

  private static instance: CliConfig | null = null;
  private configPath: string;

  constructor(config: Partial<CliConfig> = {}, configPath?: string) {
    this.cluster = ClusterNetwork.fromStr(config.cluster || "mainnet-beta");
    this.json_rpc_url = config.json_rpc_url || "";
    this.tx_rpc_url = config.tx_rpc_url || "";
    this.websocket_disabled = config.websocket_disabled || false;
    this.keypair_path = config.keypair_path || "";
    this.wallet = config.wallet || config.keypair_path || "";
    this.ledger_derivation_path = config.ledger_derivation_path;
    this.glam_staging = config.glam_staging;
    this.priority_fee = config.priority_fee;
    this.glam_state = config.glam_state;
    this.jupiter_api_key = config.jupiter_api_key;

    this.configPath = resolveConfigPath(configPath);
  }

  useLedger(): boolean {
    return this.wallet.startsWith("usb://");
  }

  get glamState(): PublicKey {
    if (!this.glam_state) {
      throw new Error("GLAM state not set");
    }

    return new PublicKey(this.glam_state);
  }

  set glamState(state: PublicKey | null) {
    const config = fs.readFileSync(this.configPath, "utf8");
    const updated = { ...JSON.parse(config), glam_state: state?.toBase58() };
    fs.writeFileSync(this.configPath, JSON.stringify(updated, null, 2), "utf8");

    CliConfig.reset();
    CliConfig.get(this.configPath);
  }

  static get(configPath?: string, override?: Partial<CliConfig>): CliConfig {
    const resolvedConfigPath = resolveConfigPath(configPath);
    if (!this.instance || this.instance.configPath !== resolvedConfigPath) {
      this.instance = CliConfig.load(resolvedConfigPath, override);
    }
    return this.instance;
  }

  static reset() {
    this.instance = null;
  }

  static load(configPath?: string, override?: Partial<CliConfig>): CliConfig {
    const resolvedConfigPath = resolveConfigPath(configPath);
    try {
      const config = fs.readFileSync(resolvedConfigPath, "utf8");
      const parsedConfig = JSON.parse(config);
      const definedOverride = Object.fromEntries(
        Object.entries(override ?? {}).filter(([, v]) => v !== undefined),
      );
      const cliConfig = new CliConfig(
        { ...parsedConfig, ...definedOverride },
        resolvedConfigPath,
      );

      if (!cliConfig.json_rpc_url) {
        throw new Error("Missing json_rpc_url in config.json");
      }

      if (!cliConfig.wallet && !cliConfig.keypair_path) {
        throw new Error("Missing wallet or keypair_path in config.json");
      }

      // The SDK sets this as the compute unit price of every send.
      const microLamports = cliConfig.priority_fee?.micro_lamports;
      if (
        microLamports != null &&
        !(Number.isSafeInteger(microLamports) && microLamports >= 0)
      ) {
        throw new Error(
          `priority_fee.micro_lamports must be a non-negative integer of micro-lamports per compute unit, not ${JSON.stringify(microLamports)}`,
        );
      }

      if (cliConfig.tx_rpc_url) {
        process.env.TX_RPC = cliConfig.tx_rpc_url;
      }

      if (cliConfig.websocket_disabled) {
        process.env.WEBSOCKET_DISABLED = "1";
      }

      if (cliConfig.glam_staging) {
        process.env.GLAM_STAGING = "1";
      }

      if (cliConfig.jupiter_api_key) {
        process.env.JUPITER_API_KEY = cliConfig.jupiter_api_key;
      }

      process.env.ANCHOR_PROVIDER_URL = cliConfig.json_rpc_url;
      if (!cliConfig.useLedger()) {
        process.env.ANCHOR_WALLET = cliConfig.wallet || cliConfig.keypair_path;
      }
      process.env.HELIUS_API_KEY = cliConfig.priority_fee?.helius_api_key;

      return cliConfig;
    } catch (err) {
      console.error(
        `Could not load glam cli config at ${resolvedConfigPath}:`,
        (err as any).message,
      );
      throw err;
    }
  }
}

const defaultConfigPath = () =>
  path.join(os.homedir(), ".config/glam/", "config.json");

export const resolveConfigPath = (configPath?: string) =>
  configPath || process.env.GLAM_CONFIG || defaultConfigPath();

export const parseTxError = (error: any) => {
  if (error instanceof AnchorError) {
    return error.error.errorMessage;
  }

  return sdkParseTxError(error);
};

export function inferStagingFromStateOwner(owner: PublicKey): boolean | null {
  if (owner.equals(getGlamProtocolProgramId(true))) {
    return true;
  }
  if (owner.equals(getGlamProtocolProgramId(false))) {
    return false;
  }
  return null;
}

export function resolveStagingFromStateOwner(
  owner: PublicKey,
  configuredStaging?: boolean,
): boolean {
  const inferredStaging = inferStagingFromStateOwner(owner);
  if (inferredStaging === null) {
    throw new Error(
      `Configured GLAM state is owned by ${owner.toBase58()}, not a known GLAM protocol program`,
    );
  }

  if (
    configuredStaging !== undefined &&
    configuredStaging !== inferredStaging
  ) {
    throw new Error(
      `Config glam_staging=${configuredStaging} does not match GLAM state owner ${owner.toBase58()} (${inferredStaging ? "staging" : "production"})`,
    );
  }

  return inferredStaging;
}

/** Where the compute unit price of every send comes from. */
export type PriorityFeeSource =
  | { kind: "fixed"; microLamports: number; from: "cluster" | "config" }
  | { kind: "helius"; apiKey: string; level?: PriorityLevel }
  | { kind: "none" };

export function priorityFeeSource(cliConfig: CliConfig): PriorityFeeSource {
  if (cliConfig.cluster === "localnet" || cliConfig.cluster === "devnet") {
    return { kind: "fixed", microLamports: 1_000_000, from: "cluster" };
  }
  const { micro_lamports, helius_api_key, level } =
    cliConfig.priority_fee || {};
  if (micro_lamports != null) {
    return { kind: "fixed", microLamports: micro_lamports, from: "config" };
  }
  return helius_api_key
    ? { kind: "helius", apiKey: helius_api_key, level }
    : { kind: "none" };
}

/** The compute unit price a send pays when Helius's estimate fails. */
export const HELIUS_FALLBACK_MICRO_LAMPORTS = 10_000;

/**
 * The compute unit price of one send. The SDK falls back to a default of its
 * own when the estimate throws; the CLI catches the failure itself, so that
 * the price it pays is the one its confirmation names.
 */
export async function priorityFeeMicroLamports(
  source: PriorityFeeSource,
  tx: VersionedTransaction,
  estimate: typeof getPriorityFeeEstimate = getPriorityFeeEstimate,
): Promise<number> {
  switch (source.kind) {
    case "fixed":
      return source.microLamports;
    case "helius":
      try {
        return await estimate({
          heliusApiKey: source.apiKey,
          tx,
          priorityLevel: source.level,
        });
      } catch {
        return HELIUS_FALLBACK_MICRO_LAMPORTS;
      }
    case "none":
      return 0;
  }
}

/** Who pays the fees of a send, and the compute unit price it pays. */
export function describeFees(
  source: PriorityFeeSource,
  feePayer: PublicKey,
  cluster: string,
): string {
  let price: string;
  if (source.kind === "fixed") {
    const from =
      source.from === "config"
        ? "priority_fee.micro_lamports in the CLI config"
        : `the CLI's price on ${cluster}`;
    price = `${source.microLamports} micro-lamports per compute unit requested (${from})`;
  } else if (source.kind === "helius") {
    const estimate =
      source.level && source.level !== "Recommended"
        ? `${source.level} estimate`
        : "recommended estimate";
    price = `Helius's ${estimate} per compute unit requested, with no cap, or ${HELIUS_FALLBACK_MICRO_LAMPORTS} micro-lamports per compute unit requested when the estimate fails`;
  } else {
    price = "none";
  }
  return `Fee payer: ${feePayer}. Priority fee: ${price}.`;
}

// Set once the CLI knows its config; every confirmation ends with it. Read
// at the question, so a command that sends nothing never reads the signer.
let feeTerms: (() => string) | undefined;

export function setConfirmationFeeTerms(terms: (() => string) | undefined) {
  feeTerms = terms;
}

export async function confirmOperation(message: string) {
  const input = process.stdin;
  // An input that ends leaves the question open, and the prompt would settle
  // only when the process exits. End it here instead.
  const unanswered = new AbortController();
  const onEnd = () => unanswered.abort();
  if (input.readableEnded) {
    onEnd();
  } else {
    input.once("end", onEnd);
  }
  try {
    // Asked on stderr, so stdout carries only what the command itself prints.
    // When stderr is redirected and stdout is the terminal, the question goes
    // there, where the user can see it.
    const output =
      !process.stderr.isTTY && process.stdout.isTTY
        ? process.stdout
        : process.stderr;
    const prompt = inquirer.createPromptModule({
      output,
      signal: unanswered.signal,
    });
    const confirmation = await prompt([
      {
        type: "confirm",
        name: "proceed",
        message: feeTerms ? `${message}\n${feeTerms()}` : message,
        default: false,
      },
    ]);
    if (!confirmation.proceed) {
      console.log("Aborted.");
      process.exit(0);
    }
  } catch (err) {
    const name = (err as any).name;
    const closed =
      name === "ExitPromptError" ||
      (err as any).message?.includes("force closed");
    // Only a terminal can cancel. On any other input a prompt that ends
    // unanswered is a failed run, so a script that left out --yes does not
    // read success.
    if (name === "AbortPromptError" || (closed && !input.isTTY)) {
      console.error(
        "The confirmation got no answer. Nothing was sent. Answer y or n, or pass --yes to skip the confirmation.",
      );
      process.exit(1);
    }
    // Ctrl+C at the prompt
    if (closed) {
      console.log("\nOperation cancelled.");
      process.exit(0);
    }
    throw err;
  } finally {
    input.removeListener("end", onEnd);
  }
}

/**
 * Parses a JSON object containing state initialization parameters.
 *
 * `json.state` must contain the following properties:
 * - `accountType`: The type of the state account.
 * - `name`: The name of the state account.
 * - `baseAssetMint`: The base asset mint of the vault.
 */
export function parseStateJson(json: any): InitStateParams {
  if (!json.state) {
    throw new Error("Invalid JSON file: must contain 'state' property");
  }
  const { state } = json;
  ["accountType", "name", "baseAssetMint"].forEach((field) => {
    if (state?.[field] === undefined) {
      throw new Error(
        `Account type ${state.accountType} missing required state field: ${field}`,
      );
    }
  });

  return {
    accountType: StateAccountType.from(state.accountType),
    name: stringToChars(state.name),
    baseAssetMint: new PublicKey(state.baseAssetMint),
    enabled: state.enabled !== false,
    assets: state.assets?.map((asset: string) => new PublicKey(asset)) || null,
    portfolioManagerName: state.portfolioManagerName
      ? stringToChars(state.portfolioManagerName)
      : null,
  };
}

const U16_MAX_BN = new BN(0xffff);
const U32_MAX_BN = new BN(0xffffffff);
const U64_MAX = new BN(2).pow(new BN(64)).subn(1);

/**
 * An unsigned integer field of the vault file: a whole JSON number, or a
 * decimal string for a value a JSON number cannot hold exactly. The encoder
 * wrote a negative u64 as its magnitude and cut a fraction, and refused a u16
 * or u32 out of range only after the confirmation.
 */
function jsonUnsigned(value: unknown, label: string, max: BN): BN {
  let parsed: BN | null = null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    parsed = new BN(value);
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    parsed = new BN(value.trim());
  }
  if (parsed === null) {
    throw new Error(
      typeof value === "number" && Number.isInteger(value) && value > 0
        ? `${label} is past 2^53; write it as a decimal string`
        : `${label} must be a non-negative integer`,
    );
  }
  if (parsed.gt(max)) {
    throw new Error(`${label} exceeds ${max.toString()}`);
  }
  return parsed;
}

function jsonBool(value: unknown, label: string): boolean {
  // The string "false" is truthy, and the encoder wrote it as true.
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be true or false`);
  }
  return value;
}

/** An enum field, by its IDL variant name in any case. */
function jsonVariant(
  value: unknown,
  label: string,
  variants: string[],
): Record<string, object> {
  const variant =
    typeof value === "string"
      ? variants.find((name) => name.toLowerCase() === value.toLowerCase())
      : undefined;
  if (!variant) {
    throw new Error(`${label} must be one of: ${variants.join(", ")}`);
  }
  return { [variant]: {} };
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function entryExitFees(value: unknown, label: string) {
  const fees = jsonObject(value, label);
  return {
    subscriptionFeeBps: jsonUnsigned(
      fees.subscriptionFeeBps,
      `${label}.subscriptionFeeBps`,
      U16_MAX_BN,
    ).toNumber(),
    redemptionFeeBps: jsonUnsigned(
      fees.redemptionFeeBps,
      `${label}.redemptionFeeBps`,
      U16_MAX_BN,
    ).toNumber(),
  };
}

/**
 * Parses a JSON object containing mint initialization parameters.
 *
 * `json.mint` must contain the following properties:
 * - `name`: The name of the mint.
 * - `symbol`: The symbol of the mint.
 * - `uri`: The URI of the mint.
 */
export function parseMintJson(
  json: any,
  accountType: StateAccountType,
): InitMintParams {
  if (accountType === StateAccountType.VAULT) {
    throw new Error(
      "Invalid JSON file: mint config is not supported for state account type `vault`",
    );
  }
  if (!json?.mint) {
    throw new Error(
      "Invalid JSON file: must contain 'mint' property for tokenized vault",
    );
  }

  const { mint } = json;
  ["name", "symbol", "uri"].forEach((field) => {
    if (mint?.[field] === undefined) {
      throw new Error(
        `Account type ${accountType} missing required mint field: ${field}`,
      );
    }
  });
  const baseAssetMint = json?.state?.baseAssetMint;
  if (!baseAssetMint) {
    throw new Error(
      "Invalid JSON file: missing required state field `baseAssetMint`",
    );
  }

  // A field left out or set to 0 is sent as none, as before.
  const optionalU64 = (field: string) =>
    mint[field] ? jsonUnsigned(mint[field], `mint.${field}`, U64_MAX) : null;
  const period = (settle: Record<string, unknown>, field: string) =>
    jsonUnsigned(settle[field] ?? 0, `mint.notifyAndSettle.${field}`, U64_MAX);

  let feeStructure: InitMintParams["feeStructure"] = null;
  if (mint.feeStructure) {
    const fees = jsonObject(mint.feeStructure, "mint.feeStructure");
    const management = jsonObject(
      fees.management,
      "mint.feeStructure.management",
    );
    const performance = jsonObject(
      fees.performance,
      "mint.feeStructure.performance",
    );
    feeStructure = {
      vault: entryExitFees(fees.vault, "mint.feeStructure.vault"),
      manager: entryExitFees(fees.manager, "mint.feeStructure.manager"),
      management: {
        feeBps: jsonUnsigned(
          management.feeBps,
          "mint.feeStructure.management.feeBps",
          U16_MAX_BN,
        ).toNumber(),
      },
      performance: {
        feeBps: jsonUnsigned(
          performance.feeBps,
          "mint.feeStructure.performance.feeBps",
          U16_MAX_BN,
        ).toNumber(),
        hurdleRateBps: jsonUnsigned(
          performance.hurdleRateBps,
          "mint.feeStructure.performance.hurdleRateBps",
          U16_MAX_BN,
        ).toNumber(),
        hurdleType: jsonVariant(
          performance.hurdleType,
          "mint.feeStructure.performance.hurdleType",
          ["hard", "soft"],
        ),
      },
      // The program keeps the protocol's own fees whatever is sent here.
      protocol: { baseFeeBps: 0, flowFeeBps: 0 },
    } as unknown as InitMintParams["feeStructure"];
  }

  let notifyAndSettle: InitMintParams["notifyAndSettle"] = null;
  if (mint.notifyAndSettle) {
    const settle = jsonObject(mint.notifyAndSettle, "mint.notifyAndSettle");
    notifyAndSettle = {
      model: jsonVariant(settle.model, "mint.notifyAndSettle.model", [
        "continuous",
        "periodic",
      ]),
      permissionlessFulfillment: jsonBool(
        settle.permissionlessFulfillment ?? false,
        "mint.notifyAndSettle.permissionlessFulfillment",
      ),
      subscribeNoticePeriodType: jsonVariant(
        settle.subscribeNoticePeriodType,
        "mint.notifyAndSettle.subscribeNoticePeriodType",
        ["hard", "soft"],
      ),
      subscribeNoticePeriod: period(settle, "subscribeNoticePeriod"),
      subscribeSettlementPeriod: period(settle, "subscribeSettlementPeriod"),
      subscribeCancellationWindow: period(
        settle,
        "subscribeCancellationWindow",
      ),
      redeemNoticePeriodType: jsonVariant(
        settle.redeemNoticePeriodType,
        "mint.notifyAndSettle.redeemNoticePeriodType",
        ["hard", "soft"],
      ),
      redeemNoticePeriod: period(settle, "redeemNoticePeriod"),
      redeemSettlementPeriod: period(settle, "redeemSettlementPeriod"),
      redeemCancellationWindow: period(settle, "redeemCancellationWindow"),
      timeUnit: jsonVariant(settle.timeUnit, "mint.notifyAndSettle.timeUnit", [
        "second",
        "slot",
      ]),
      padding: [0, 0, 0],
    } as unknown as InitMintParams["notifyAndSettle"];
  }

  return {
    accountType,
    name: stringToChars(mint.name),
    symbol: mint.symbol,
    uri: mint.uri,
    baseAssetMint: new PublicKey(baseAssetMint),
    maxCap: optionalU64("maxCap"),
    minSubscription: optionalU64("minSubscription"),
    minRedemption: optionalU64("minRedemption"),
    lockupPeriod: mint.lockupPeriod
      ? jsonUnsigned(
          mint.lockupPeriod,
          "mint.lockupPeriod",
          U32_MAX_BN,
        ).toNumber()
      : null,
    permanentDelegate: mint.permanentDelegate
      ? new PublicKey(mint.permanentDelegate)
      : null,
    defaultAccountStateFrozen: jsonBool(
      mint.defaultAccountStateFrozen ?? false,
      "mint.defaultAccountStateFrozen",
    ),
    feeStructure,
    notifyAndSettle,
  };
}

type StagingOnlyContext = Pick<CliContext, "cliConfig" | "glamClient">;

export function assertStagingOnlyVault(context?: StagingOnlyContext) {
  const activeVault = context?.cliConfig?.glam_state;
  if (activeVault && context?.glamClient?.staging === false) {
    fail(
      `Staging-only command cannot be used with non-staging vault ${activeVault}. Switch to a staging vault or set a different glam_state in the CLI config.`,
    );
  }
}

/**
 * Mark a command as using a staging-only integration. Prefixes the description
 * with `[Staging only]` and rejects commands against non-staging active vaults.
 */
export function markStagingOnlyCommand(
  command: Command,
  label: string,
  context?: StagingOnlyContext,
): Command {
  return command
    .description(`[Staging only] ${label}`)
    .hook("preSubcommand", async () => {
      assertStagingOnlyVault(context);
    });
}

export function parsePositiveInteger(value: string, label?: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    fail(`${label ?? value} must be a positive integer`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label ?? value} must be a positive integer`);
  }
  return parsed;
}

export function parseNonNegativeInteger(value: string, label?: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    fail(`${label ?? value} must be a non-negative integer`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${label ?? value} must be a safe non-negative integer`);
  }
  return parsed;
}

export function validatePublicKey(value: string) {
  try {
    return new PublicKey(value);
  } catch {
    console.error("Not a valid pubkey:", value);
    process.exit(1);
  }
}

export function collectPublicKeys(value: string, previous: PublicKey[] = []) {
  return [...previous, validatePublicKey(value)];
}

export function validateFileExists(path: string) {
  if (!fs.existsSync(path)) {
    console.error(`File ${path} does not exist`);
    process.exit(1);
  }
  return path;
}

export function validateInvestorAction(action: string) {
  if (action !== "subscription" && action !== "redemption") {
    console.error(`Invalid action. Allowed values: subscription, redemption`);
    process.exit(1);
  }
  return action;
}

export function validateBooleanInput(input: string) {
  const normalized = input.toLowerCase().trim();
  const truthyValues = ["true", "1", "yes", "y", "on", "enable"];
  const falsyValues = ["false", "0", "no", "n", "off", "disable"];

  if (truthyValues.includes(normalized)) return true;
  if (falsyValues.includes(normalized)) return false;

  throw new Error(
    `Invalid boolean value: "${input}". Use: true/false, yes/no, 1/0, enable/disable`,
  );
}

/**
 * Execute a transaction with standardized error handling
 * @param txFn - Async function that returns a transaction signature
 * @param confirmOptions - Options for confirmation prompt
 * @param successMessage - Success message string or function that takes txSig and returns string
 */
// Each signature the SDK sends during one executeTxWithErrorHandling call.
const sentSignatures: string[] = [];

// Each transaction the wallet signed during the call: its id, or null while
// its first signature is unset. The SDK's send signs right before it sends, so
// a signed transaction may have gone out whatever the error says of it. A
// check or a co-signer between the two can stop it, and no error says which.
const walletSigned: (string | null)[] = [];
const recordedWallets = new WeakSet<object>();

type SigningWallet = { signTransaction?: (tx: any) => Promise<any> };

/** A signed transaction's id, its first signature in base58, once it is set. */
function signedTransactionId(tx: unknown): string | null {
  const signature: Uint8Array | null | undefined =
    typeof (tx as Transaction | null)?.partialSign === "function"
      ? (tx as Transaction).signature
      : (tx as VersionedTransaction | null)?.signatures?.[0];
  return signature && signature.some((byte) => byte !== 0)
    ? anchorUtils.bytes.bs58.encode(signature)
    : null;
}

/**
 * Records each transaction the client sends, and each one its wallet signs.
 * The SDK sends without preflight, so a send whose confirmation then fails
 * may still land, and a retry would send it again. A send whose answer the
 * RPC lost reaches no listener: a newer SDK's error carries its id, and the
 * wallet's signature is the record under an SDK that attaches none.
 */
export function recordSentSignatures(glamClient: {
  onSentListeners: Set<(sig: string) => void>;
  wallet?: SigningWallet;
}) {
  glamClient.onSentListeners.add((sig) => sentSignatures.push(sig));

  let wallet: SigningWallet | undefined;
  try {
    wallet = glamClient.wallet;
  } catch {
    // A client whose provider has no wallet signs nothing.
  }
  // Clients built on one provider share its wallet, which is wrapped once.
  if (
    typeof wallet?.signTransaction !== "function" ||
    recordedWallets.has(wallet)
  ) {
    return;
  }
  recordedWallets.add(wallet);
  const sign = wallet.signTransaction.bind(wallet);
  wallet.signTransaction = async (tx) => {
    const signed = await sign(tx);
    walletSigned.push(signedTransactionId(signed));
    return signed;
  };
}

// The longest line printed of an error's own message. An RPC transport error
// carries the whole response body, which can be an HTML page.
const OWN_MESSAGE_LIMIT = 200;

/** The first line of `message` that is not blank, cut at OWN_MESSAGE_LIMIT. */
function firstLine(message: string): string {
  const line =
    message
      .split(/\r?\n/)
      .map((each) => each.trim())
      .find((each) => each !== "") ?? "";
  return line.length > OWN_MESSAGE_LIMIT
    ? `${line.slice(0, OWN_MESSAGE_LIMIT)}...`
    : line;
}

/**
 * What an error says of itself, in one line. web3.js throws an RPC's refusal
 * of a send as a SendTransactionError: the first line of its message names no
 * cause, and the RPC's answer is its `transactionMessage`.
 */
function ownLine(error: unknown): string {
  const { transactionMessage, message } = (error ?? {}) as {
    transactionMessage?: unknown;
    message?: unknown;
  };
  for (const text of [transactionMessage, message]) {
    const line = typeof text === "string" ? firstLine(text) : "";
    if (line !== "") {
      return line;
    }
  }
  return firstLine(String(error));
}

/**
 * What a failure prints. The SDK's parser ends a rate limit, an unavailable
 * RPC and a timeout with advice to try again. After a signature that advice
 * would send a second transaction, so the one line the error says of itself
 * is printed in its place. Any other failure prints as the parser reads it.
 */
function failureLine(error: unknown, signed: boolean): string {
  const parsed = parseTxError(error);
  return signed && /try again/i.test(parsed) ? ownLine(error) : parsed;
}

const CHECK_FIRST = "check its status on chain before sending again.";

export async function executeTxWithErrorHandling(
  txFn: () => Promise<string>,
  confirmOptions: {
    skip: boolean;
    message?: string;
  },
  successMessage: string | ((txSig: string) => string),
  // Printed under the error when the failure signed and sent nothing: a
  // transaction that went out may still land, and gets no advice to run the
  // command again.
  unsentAdvice?: string,
): Promise<void> {
  if (!confirmOptions.skip) {
    await confirmOperation(confirmOptions.message || "Confirm operation?");
  }

  sentSignatures.length = 0;
  walletSigned.length = 0;
  try {
    const txSig = await txFn();
    const message =
      typeof successMessage === "function"
        ? successMessage(txSig)
        : `${successMessage} ${txSig}`;
    console.log(message);
  } catch (e) {
    // A newer SDK's error names the transaction it signed and the RPC did not
    // acknowledge: its answer was lost, or named another transaction.
    const named = (e as { unacknowledgedSignature?: unknown } | null)
      ?.unacknowledgedSignature;
    // Each signed id that no listener heard: the error's, then the wallet's.
    const unacknowledged = [
      ...new Set([
        ...(typeof named === "string" ? [named] : []),
        ...walletSigned.filter((id): id is string => id !== null),
      ]),
    ].filter((id) => !sentSignatures.includes(id));
    const signed =
      sentSignatures.length > 0 ||
      unacknowledged.length > 0 ||
      walletSigned.length > 0;

    console.error(failureLine(e, signed));
    if (unsentAdvice && !signed) {
      console.error(unsentAdvice);
    }
    for (const sig of sentSignatures) {
      console.error(`Sent ${sig}: ${CHECK_FIRST}`);
    }
    // Only the id the error names was handed to an RPC's send.
    for (const sig of unacknowledged) {
      console.error(
        sig === named
          ? `Signed ${sig}, which the RPC did not acknowledge: ${CHECK_FIRST}`
          : `Signed ${sig}, which may have been sent: ${CHECK_FIRST}`,
      );
    }
    // The wallet signed, and what it returned carries no id to name.
    if (signed && sentSignatures.length === 0 && unacknowledged.length === 0) {
      console.error(
        "The wallet signed a transaction that may have been sent: check the signer's recent transactions on chain before sending again.",
      );
    }
    process.exit(1);
  }
}

/**
 * The cluster's clock as the programs read it: the Clock sysvar's slot and
 * unix timestamp, the latter an i64 the programs here take as positive. A
 * host clock that runs apart from it refused what the program would take.
 * `readAgainst` names what the time is read for.
 */
export async function clusterClock(
  context: CliContext,
  readAgainst: string,
): Promise<{ slot: BN; unixTimestamp: BN }> {
  const clock =
    await context.glamClient.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!clock || clock.data.length < 40) {
    fail(
      `The RPC returned no Clock sysvar, which ${readAgainst} is read against`,
    );
  }
  return {
    slot: new BN(clock.data.subarray(0, 8), "le"),
    unixTimestamp: new BN(clock.data.subarray(32, 40), "le"),
  };
}

/**
 * Text the CLI did not write, such as a vault name read from the chain or a
 * file, with each control character written as \uXXXX. The SDK reads a name byte by byte, so it can hold ESC
 * and CSI sequences that move the cursor and rewrite the addresses a prompt
 * prints beside it.
 */
export function printableText(text: string): string {
  let printable = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    printable +=
      code < 0x20 || (code >= 0x7f && code <= 0x9f)
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : char;
  }
  return printable;
}

/** A base-unit amount in UI units of `decimals`, exact at any size. */
export function formatUiAmount(amount: BN, decimals: number): string {
  const scale = new BN(10).pow(new BN(decimals));
  const whole = amount.div(scale).toString();
  const fraction = amount
    .mod(scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Print a formatted table with auto-sized columns.
 * Each row is an array of strings; the first row is treated as the header.
 */
export function printTable(headers: string[], rows: string[][]) {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || "").length)),
  );

  const formatRow = (items: string[]) =>
    items.map((item, i) => item.padEnd(colWidths[i])).join("  ");

  console.log(formatRow(headers));
  console.log(colWidths.map((w) => "-".repeat(w)).join("  "));
  rows.forEach((row) => console.log(formatRow(row)));
}

export function printPubkeyList(label: string, list: PublicKey[]) {
  if (list.length === 0) {
    console.log(`${label}: []`);
    return;
  }
  console.log(`${label}:`);
  for (let i = 0; i < list.length; i++) {
    console.log(`[${i}] ${list[i]}`);
  }
}

export function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Resolve a single protocol name with fuzzy matching:
 * 1. Exact match
 * 2. Case-insensitive match
 * 3. Levenshtein suggestion (distance <= 3)
 *
 * Returns the canonical protocol name or exits with an error.
 */
export function resolveProtocolName(name: string, staging: boolean): string {
  const lookup = getProgramAndBitflagByProtocolName(staging);
  const validNames = Object.keys(lookup);

  // 1. Exact match
  if (lookup[name]) {
    return name;
  }

  // 2. Case-insensitive match
  const ciIndex = new Map<string, string>();
  for (const valid of validNames) {
    ciIndex.set(valid.toLowerCase(), valid);
  }
  const ciMatch = ciIndex.get(name.toLowerCase());
  if (ciMatch) {
    console.log(`Note: using '${ciMatch}' for '${name}'`);
    return ciMatch;
  }

  // 3. Levenshtein suggestion
  let bestName = "";
  let bestDist = Infinity;
  const nameLower = name.toLowerCase();
  for (const valid of validNames) {
    const dist = levenshtein(nameLower, valid.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      bestName = valid;
    }
  }
  const suggestion =
    bestDist <= 3 ? `  Did you mean '${bestName}' instead of '${name}'?` : "";

  console.error(`Unknown protocol name: ${name}`);
  if (suggestion) console.error(suggestion);
  console.error(`Valid protocol names: ${validNames.join(", ")}`);
  process.exit(1);
}

/**
 * Resolve permission names for a given (already-resolved) protocol with fuzzy matching.
 * Returns an array of canonical permission names or exits with an error.
 */
export function resolvePermissionNames(
  protocolName: string,
  inputNames: string[],
  staging: boolean,
): string[] {
  const normalizedInputNames = parseArrayInput(inputNames);
  const protocolConfig =
    getProgramAndBitflagByProtocolName(staging)[protocolName];
  if (!protocolConfig) {
    console.error(`Unknown protocol name: ${protocolName}`);
    process.exit(1);
  }

  const [programIdStr, bitflagStr] = protocolConfig;
  const protocolPermissions =
    getProtocolsAndPermissions(staging)[programIdStr]?.[bitflagStr];
  if (!protocolPermissions) {
    console.error(
      `Protocol mapping not found for protocol name ${protocolName}`,
    );
    process.exit(1);
  }

  const validNames = Object.values(protocolPermissions.permissions);
  const ciIndex = new Map<string, string>();
  for (const valid of validNames) {
    ciIndex.set(valid.toLowerCase(), valid);
  }

  const resolved: string[] = [];
  const unknown: string[] = [];
  const suggestions: string[] = [];

  for (const name of normalizedInputNames) {
    // 1. Exact match
    if (validNames.includes(name)) {
      resolved.push(name);
      continue;
    }

    // 2. Case-insensitive match
    const ciMatch = ciIndex.get(name.toLowerCase());
    if (ciMatch) {
      console.log(`Note: using '${ciMatch}' for '${name}'`);
      resolved.push(ciMatch);
      continue;
    }

    // 3. Levenshtein suggestion
    let bestName = "";
    let bestDist = Infinity;
    const nameLower = name.toLowerCase();
    for (const valid of validNames) {
      const dist = levenshtein(nameLower, valid.toLowerCase());
      if (dist < bestDist) {
        bestDist = dist;
        bestName = valid;
      }
    }
    if (bestDist <= 3) {
      suggestions.push(`  Did you mean '${bestName}' instead of '${name}'?`);
    }
    unknown.push(name);
  }

  if (unknown.length) {
    console.error(
      `Unknown permission name(s) for ${protocolName}: ${unknown.join(", ")}`,
    );
    for (const s of suggestions) {
      console.error(s);
    }
    console.error(
      `Valid permissions for ${protocolName}: ${validNames.join(", ")}`,
    );
    process.exit(1);
  }

  return resolved;
}

/**
 * Resolves a token mint/symbol into a TokenListItem with metadata.
 *
 * @param glamClient
 * @param mintOrSymbol
 * @returns
 */
export async function resolveTokenMint(
  glamClient: GlamClient,
  mintOrSymbol: string, // mint address or symbol
): Promise<TokenListItem> {
  try {
    const tokenList = await glamClient.jupiterSwap.jupApi.fetchTokensList();
    const tokenInfo =
      tokenList.getByMint(mintOrSymbol) || tokenList.getBySymbol(mintOrSymbol);
    if (tokenInfo) {
      return tokenInfo;
    }
  } catch {}

  // Not in the verified token list — if `value` is a valid mint address,
  // fall back to fetching decimals on-chain.
  try {
    const mintPubkey = new PublicKey(mintOrSymbol);
    const { mint } = await fetchMintAndTokenProgram(
      glamClient.connection,
      mintPubkey,
    );
    return {
      address: mintPubkey.toBase58(),
      name: mintPubkey.toBase58(),
      symbol: mintPubkey.toBase58(),
      decimals: mint.decimals,
      logoURI: "",
      tags: [],
      usdPrice: 0,
      slot: 0,
    };
  } catch {
    console.error(`Cannot resolve token: ${mintOrSymbol}`);
    process.exit(1);
  }
}

export async function resolveTokenPublicKey(
  glamClient: GlamClient,
  value: string,
): Promise<PublicKey> {
  const token = await resolveTokenMint(glamClient, value);
  return new PublicKey(token.address);
}

export async function resolveTokenList(
  glamClient: GlamClient,
  raw: string,
): Promise<PublicKey[]> {
  const parts = parseArrayInput(raw);
  if (parts.length === 0) {
    fail("Must contain at least one token mint or symbol");
  }

  const seen = new Set<string>();
  const result: PublicKey[] = [];
  for (const part of parts) {
    const mint = await resolveTokenPublicKey(glamClient, part);
    if (!seen.has(mint.toBase58())) {
      seen.add(mint.toBase58());
      result.push(mint);
    }
  }
  return result;
}
