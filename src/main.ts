import {
  charsToString,
  getPriorityFeeEstimate,
  GlamClient,
} from "@glamsystems/glam-sdk";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  type VersionedTransaction,
} from "@solana/web3.js";
import { Command } from "commander";

// One version source: the package manifest, read at build time. The bump
// script and release tooling change package.json only.
const { version: cliVersion } = require("../package.json") as {
  version: string;
};

import {
  CliConfig,
  markStagingOnlyCommand,
  resolveStagingFromStateOwner,
  type CliContext,
} from "./utils";
import { DEFAULT_DERIVATION_PATH, LedgerWallet } from "./ledger";
import { installLstCommands } from "./cmds/lst";
import { installMarinadeCommands } from "./cmds/marinade";
import { installKaminoLendCommands } from "./cmds/kamino-lend";
import { installKaminoVaultsCommands } from "./cmds/kamino-vaults";
import { installKaminoFarmsCommands } from "./cmds/kamino-farms";
import { installIntegrationCommands } from "./cmds/integration";
import { installDelegateCommands } from "./cmds/delegate";
import { installJupiterSwapCommands } from "./cmds/jupiter";
import { installJupiterEarnCommands } from "./cmds/jupiter-earn";
import { installJupiterBorrowCommands } from "./cmds/jupiter-borrow";
import { installInvestCommands } from "./cmds/invest";
import { installAltCommands } from "./cmds/alt";
import { installStakeCommands } from "./cmds/stake";
import { installVaultCommands } from "./cmds/vault";
import { idlCheck } from "./idl";
import { installManageCommands } from "./cmds/manage";
import { installCctpCommands } from "./cmds/cctp";
import { installBridgeCommands } from "./cmds/bridge";
import { installRpiCommands } from "./cmds/rpi";
import { installTransferCommands } from "./cmds/transfer";
import { installTimelockCommands } from "./cmds/timelock";
import { installTokenAclCommands } from "./cmds/token-acl";
import { installLoopscaleBorrowCommands } from "./cmds/loopscale-borrow";
import { installLoopscaleLendCommands } from "./cmds/loopscale-lend";
import { installLoopscaleVaultCommands } from "./cmds/loopscale-vault";
import { installPhoenixCommands } from "./cmds/phoenix";
import { installOrcaCommands } from "./cmds/orca";
import { installNeutralCommands } from "./cmds/neutral";
import { installMarginfiCommands } from "./cmds/marginfi";
import { installExponentCommands } from "./cmds/exponent";

const context = {} as CliContext;

// Graceful shutdown handling
function setupGracefulShutdown() {
  process.on("SIGINT", () => {
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    process.exit(0);
  });

  process.on("uncaughtException", (error) => {
    printCliError(error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    printCliError(reason);
    process.exit(1);
  });
}

function printCliError(error: unknown) {
  if (error instanceof Error) {
    console.error(`${error.message}`);
    return;
  }

  console.error(`${String(error)}`);
}

async function initialize(
  configPath?: string,
  skipSimulation = false,
  staging?: boolean,
  wallet?: string,
  ledgerDerivationPath?: string,
) {
  const cliConfig = CliConfig.get(configPath, {
    glam_staging: staging,
    wallet,
    ledger_derivation_path: ledgerDerivationPath,
  });
  const { cluster, glam_state } = cliConfig;

  let useStaging = cliConfig.glam_staging;
  let statePda: PublicKey | undefined;

  if (glam_state && glam_state !== "") {
    statePda = new PublicKey(glam_state);
    const account = await new Connection(cliConfig.json_rpc_url, {
      commitment: "confirmed",
    }).getAccountInfo(statePda);
    if (!account) {
      throw new Error(`GLAM state account not found: ${statePda.toBase58()}`);
    }
    useStaging = resolveStagingFromStateOwner(account.owner, useStaging);
  }

  if (useStaging !== undefined) {
    process.env.GLAM_STAGING = useStaging ? "1" : "0";
  }

  let provider: AnchorProvider | undefined;
  if (cliConfig.useLedger()) {
    const ledgerWallet = new LedgerWallet(cliConfig.ledger_derivation_path);
    await ledgerWallet.connect();
    const connection = new Connection(cliConfig.json_rpc_url, {
      commitment: "confirmed",
    });
    provider = new AnchorProvider(connection, ledgerWallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
  }

  context.glamClient = new GlamClient({
    provider, // if undefined, GlamClient builds one from ANCHOR_WALLET env
    cluster,
    statePda,
    useStaging,
    // The Ledger app is not verified to sign a version 1 message.
    transactionVersion: cliConfig.useLedger() ? 0 : undefined,
  });

  context.cliConfig = cliConfig;
  context.txOptions = {
    simulate: !skipSimulation,
    getPriorityFeeMicroLamports: async (tx: VersionedTransaction) => {
      if (
        context.cliConfig.cluster === "localnet" ||
        context.cliConfig.cluster === "devnet"
      ) {
        return 1_000_000;
      }

      const { micro_lamports, helius_api_key, level } =
        context.cliConfig.priority_fee || {};

      // If micro_lamports is provided, use it
      if (micro_lamports === 0 || micro_lamports) {
        return micro_lamports;
      }

      // If helius_api_key is not provided, return 0
      return helius_api_key
        ? await getPriorityFeeEstimate({
            heliusApiKey: helius_api_key,
            tx,
            priorityLevel: level,
          })
        : 0;
    },
  };
}

setupGracefulShutdown();

const program = new Command();
program.addHelpCommand(false);
program
  .name("glam-cli")
  .description("CLI for interacting with the GLAM Protocol")
  .option("-C, --config <path>", "Path to config file")
  .option("-S, --skip-simulation", "Skip simulation", false)
  .option("--staging", "Use staging environment")
  .option("--wallet <wallet>", "Keypair file path or USB path (usb://ledger)")
  .option(
    "--ledger-derivation-path <path>",
    `Ledger derivation path (default: ${DEFAULT_DERIVATION_PATH})`,
  )
  .hook("preSubcommand", async (thisCommand: Command) => {
    const { config, skipSimulation, staging, wallet, ledgerDerivationPath } =
      thisCommand.opts();

    await initialize(
      config,
      skipSimulation,
      staging,
      wallet,
      ledgerDerivationPath,
    );
    await idlCheck(context.glamClient);
  })
  .version(cliVersion);

program
  .command("env")
  .description("Display current environment setup")
  .action(async () => {
    const { cliConfig, glamClient } = context;
    console.log(
      "GLAM Protocol program:",
      glamClient.protocolProgram.programId.toBase58(),
    );
    console.log("Staging:", glamClient.staging);
    console.log("Wallet connected:", glamClient.signer.toBase58());
    console.log("RPC endpoint:", glamClient.connection.rpcEndpoint);
    console.log("Priority fee:", cliConfig.priority_fee);
    console.log(
      "Jupiter API key:",
      cliConfig.jupiter_api_key || "not configured",
    );

    if (cliConfig.glam_state) {
      console.log(`GLAM state: ${glamClient.statePda}`);
      console.log(`Vault PDA: ${glamClient.vaultPda}`);

      const stateAccount = await glamClient.fetchStateAccount();
      if (!stateAccount) {
        console.log("Invalid GLAM state account.");
      } else {
        console.log("Vault name:", charsToString(stateAccount.name));
      }
    } else {
      console.log("No active GLAM vault configured.");
    }
  });

const vault = program
  .command("vault")
  .description("Create, close, manage vault");
installVaultCommands(vault, context);

const transfer = program
  .command("transfer")
  .description("Transfer vault assets out");
installTransferCommands(transfer, context);

const delegate = program.command("delegate").description("Manage delegates");
installDelegateCommands(delegate, context);

const integration = program
  .command("integration")
  .description("Manage integrations");
installIntegrationCommands(integration, context);

const jupiterSwap = program
  .command("jupiter-swap")
  .alias("jupiter")
  .description("Jupiter swap");
installJupiterSwapCommands(jupiterSwap, context);

const klend = program.command("kamino-lend").description("Kamino lending");
installKaminoLendCommands(klend, context);

const kvaults = program.command("kamino-vaults").description("Kamino vaults");
installKaminoVaultsCommands(kvaults, context);

const kfarms = program.command("kamino-farms").description("Kamino farms");
installKaminoFarmsCommands(kfarms, context);

const invest = program
  .command("invest")
  .description("Tokenized vault investor operations");
installInvestCommands(invest, context);

const manage = program
  .command("manage")
  .description("Tokenized vault manager operations");
installManageCommands(manage, context);

const alt = program.command("alt").description("Manage address lookup tables");
installAltCommands(alt, context);

const timelock = program.command("timelock").description("Timelock operations");
installTimelockCommands(timelock, context);

const cctp = program.command("cctp").description("CCTP operations");
installCctpCommands(cctp, context);

const neutral = program.command("neutral").description("Neutral bundles");
installNeutralCommands(neutral, context);

type StagingOnlyCommandInstaller = (
  command: Command,
  context: CliContext,
) => void;

const stagingOnly = [
  ["bridge", "Bridge operations", installBridgeCommands],
  ["rpi", "Manage registered positions", installRpiCommands],
  ["token-acl", "Token ACL (sRFC-37)", installTokenAclCommands],
  ["jupiter-earn", "Jupiter Earn", installJupiterEarnCommands],
  ["jupiter-borrow", "Jupiter Borrow", installJupiterBorrowCommands],
  ["loopscale-borrow", "Loopscale borrow", installLoopscaleBorrowCommands],
  ["loopscale-lend", "Loopscale lend", installLoopscaleLendCommands],
  ["loopscale-vault", "Loopscale vault", installLoopscaleVaultCommands],
  ["phoenix", "Phoenix perps", installPhoenixCommands],
  ["orca", "Orca whirlpools", installOrcaCommands],
  ["exponent", "Exponent Core", installExponentCommands],
  ["marinade", "Marinade liquid staking", installMarinadeCommands],
  ["lst", "Liquid staking (SPL and Sanctum)", installLstCommands],
  ["stake", "Solana native staking", installStakeCommands],
  ["marginfi", "Marginfi lending", installMarginfiCommands],
] satisfies [string, string, StagingOnlyCommandInstaller][];

stagingOnly.forEach(([key, description, installFn]) => {
  const cmd = markStagingOnlyCommand(
    program.command(key),
    description,
    context,
  );
  installFn(cmd, context);
});

//
// Run the CLI in development mode as follows:
// npx nx run cli:dev -- --args="cmd [arg]"
//
// For example:
// npx nx run cli:dev -- --args="list -a"
//
const argv =
  process.env.NODE_ENV === "development"
    ? [
        process.argv[0], // Node.js binary path
        process.argv[1], // Script path
        ...process.argv[2].split(" "), // Split the concatenated arguments
      ]
    : process.argv;

program.parseAsync(argv).catch((error) => {
  printCliError(error);
  process.exit(1);
});
