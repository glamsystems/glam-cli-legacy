# GLAM CLI

![NPM Version](https://img.shields.io/npm/v/%40glamsystems%2Fglam-cli)

Command-line interface for managing GLAM vaults.

This is the legacy CLI line (`@glamsystems/glam-cli`); its successor is the Kit CLI, `@glam/cli`, once published.

**Note:** This repository is automatically synced from GLAM's private monorepo. Pull requests cannot be accepted here, but we welcome bug reports and feature requests through GitHub Issues.

## Installation

```bash
npm install -g @glamsystems/glam-cli
```

After installation, you can use the CLI with the `glam-cli` command.

## Versioning

Minor releases can include breaking changes, including within 1.x. Patch
releases contain fixes. Breaking changes are identified in the release notes
and in the upgrading section of this file. Pin an exact CLI version and read
those notes before upgrading. An install without a version and
`npm update -g` take the latest release, which can be a breaking minor
release.

```bash
npm install -g @glamsystems/glam-cli@1.3.0
```

## Upgrading from 1.3.0

This section is for anyone who runs a command with the protocol name `CCTP`.
The entries for each command describe a production vault, and "On a staging
vault" says what differs on staging. The two clean-ups at the end are for a
production vault on which a CLI release from 1.1.3 to 1.3.0 was used with the
name.

Two integration programs name a protocol `CCTP`. ext_cctp
(`G1NTcMDYgNLpDwgnrpSZvoSKQuR9NXG7S3DmtNQCDmrK` on production) is the one the
`cctp` commands call. ext_bridge
(`G1NTbnLcjMex9Tjo8ocmNK9S2zBCiGVuxKUUNGhYZztx`) is the one the `bridge`
commands call, and production does not run it. Every release from 1.1.3 to
1.3.0 took the name to mean ext_bridge's protocol on every vault. The name now
means ext_cctp's protocol on a production vault and ext_bridge's on a staging
vault. No other protocol name is shared.

Both programs keep the name, so a listing prints `CCTP` for either one. The
program id printed with it tells them apart.

- `integration enable CCTP` enables ext_cctp's protocol on a production vault.
  1.1.3 to 1.3.0 enabled ext_bridge's there, which the `cctp` commands do not
  use.
- `integration disable CCTP` reads the vault's integration list first. Where
  only ext_bridge enables the protocol, it disables that one and prints a note
  that names the program. Where both programs enable it, it disables
  ext_cctp's and says that ext_bridge's stays. 1.1.3 to 1.3.0 disabled
  ext_bridge's. A disable deletes the stored policy of the protocol it
  disables, which for ext_cctp's is the destination allowlist. The
  confirmation says so.
- `delegate grant --protocol CCTP` takes ext_cctp's permission on a production
  vault, which is `Transfer`. 1.1.3 to 1.3.0 took ext_bridge's there: `Send`,
  `Validate` and `Settle`, and from 1.2.0 also `Pause`. Given one of those, the
  command now names the valid permission and exits with status 1.
- `delegate revoke --protocol CCTP` resolves the name the same way. It takes
  `Transfer` and refuses ext_bridge's permissions. So it cannot take back one
  permission of a grant that 1.1.3 to 1.3.0 made on ext_bridge's protocol. See
  below for the ways to remove such a grant.
- `integration list` prints each integration program's id with the protocols
  enabled on it. An entry that 1.1.3 to 1.3.0 made prints `CCTP` after
  ext_bridge's id. One made since prints `CCTP` after ext_cctp's.
- `delegate list` prints a delegate's permissions under each program's id. A
  grant that 1.1.3 to 1.3.0 made prints as `CCTP: Send`, or with another of
  ext_bridge's permissions, under ext_bridge's id. One made since prints as
  `CCTP: Transfer` under ext_cctp's.

What each `cctp` command needs is on ext_cctp's protocol:

- `cctp bridge-usdc` needs the protocol enabled and a destination that the
  stored policy allows. The vault owner can run it, and so can a delegate with
  the `Transfer` permission.
- `cctp allowlist-destination` and `cctp remove-destination` set the policy.
  They need the protocol enabled, and only the vault owner can run them.
- `cctp view-policy` and `cctp list` only read.
- `cctp receive` sends Circle's receive instruction and no instruction of a
  GLAM program, so it needs nothing enabled on the vault.

`integration enable CCTP` enables the protocol, and
`delegate grant <pubkey> --protocol CCTP Transfer` gives a delegate the
permission.

### On a staging vault

The name `CCTP` means ext_bridge's protocol on a staging vault, as in every
release since 1.1.3. `integration enable`, `delegate grant` and
`delegate revoke` act on ext_bridge's protocol there as before, so
`integration enable CCTP` does not enable the protocol the `cctp` commands
need. An SDK caller names the program instead:
`client.access.enableProtocols(integrationProgram, protocolBitmask)` enables
the protocol, and
`client.access.grantDelegatePermissions(delegate, integrationProgram, protocolBitflag, permissionsBitmask)`
gives a delegate its `Transfer` permission. On staging, ext_cctp is
`gstgcuRwiX2FpmtigowB1TnVi3fPkZC9TEmVnc5sdxW` and ext_bridge is
`gstgxS9yTioViNKdsM4DC33k1TU9un2VCYDQK8fAeSA`.

One command changed. `integration disable CCTP` reads the integration list it
edits. Where that list enables ext_cctp's protocol and not ext_bridge's, the
command now disables ext_cctp's and deletes its destination allowlist. 1.1.3 to
1.3.0 sent the disable to ext_bridge's protocol there, which left ext_cctp's
protocol and its allowlist as they were. Where the list enables both, the
command disables ext_bridge's, as before, and says that ext_cctp's stays. A
second run then disables ext_cctp's. `integration enable CCTP` does not undo a
disable of ext_cctp's protocol, since the name means ext_bridge's there.

In both cases the command prints a note that names the two programs, and its
confirmation names the id of the program it acts on and says when it deletes a
stored policy. Run it without `--yes`.

On a vault with a timelock the command edits the staged list where a staged
change holds one, which `integration list` does not print, and the disable is
staged until `timelock apply`. `timelock cancel` drops every staged change.

### A production vault that lists ext_bridge's protocol

One check holds in every state. `integration disable` asks for confirmation,
and the confirmation names the id of the program it acts on and says when it
deletes a stored policy. Run it without `--yes`, and answer no when it names
ext_cctp's id and that is not what you meant.

On a vault without a timelock, `integration list` shows which of the two ids
has `CCTP` after it:

- Only ext_bridge's. `integration disable CCTP` disables ext_bridge's
  protocol. Then `integration enable CCTP` enables ext_cctp's.
- Both. `integration disable CCTP` would disable ext_cctp's protocol and
  delete its destination allowlist. Run
  `integration disable-all G1NTbnLcjMex9Tjo8ocmNK9S2zBCiGVuxKUUNGhYZztx`, which
  removes ext_bridge's entry and leaves ext_cctp's as it is.

On a vault with a timelock, `integration list` prints the live list, which
`integration enable` and `integration disable` do not change until
`timelock apply`, and `integration disable` edits the staged list where a
staged change holds one. Run each command once and read `timelock view` before
the next. It prints what a staged change adds and removes with the first eight
characters of a program's id: `G1NTbnLc` is ext_bridge's and `G1NTcMDY` is
ext_cctp's. `timelock cancel` drops every staged change.

`integration disable-all` is an emergency update. It changes the live list at
once, it refuses a program that is not on the live list, and a change already
staged that still lists the program brings it back on `timelock apply`.
"Command lines that send something else" under "Upgrading to 1.3.0" has the
entry on emergency updates.

Where the live list holds no entry for ext_bridge, `integration disable-all`
refuses ext_bridge's id, and `integration disable CCTP` acts on ext_cctp's
protocol where the staged list enables both. The refusal says which program
that command would act on. An SDK caller removes the staged entry alone with
`client.access.disableProtocols(integrationProgram, protocolBitmask)`, which
the refusal prints with the id and the mask filled in. Like any staged change,
that call restarts the timelock's wait for everything staged. `timelock cancel`
drops every staged change.

### A grant on ext_bridge's protocol on a production vault

A grant that 1.1.3 to 1.3.0 made by the name gives a delegate permissions on
ext_bridge's protocol. While that protocol is disabled the permissions cannot
be used, because the program checks that the protocol is enabled first. The
delegate stays listed on the vault all the same, and a few instructions accept
any listed delegate. So remove the grant, in one of three ways:

- Run the revoke with one of those releases, where the name still means
  ext_bridge's protocol:
  `npx @glamsystems/glam-cli@1.3.0 delegate revoke <pubkey> --protocol CCTP Send`.
  `npx` runs that one command and leaves the installed release as it is. An
  older release installed with `npm install -g` replaces the current one, and
  its `integration enable CCTP` enables ext_bridge's protocol again. 1.2.0 to
  1.3.0 take all four permission names, and 1.1.3 takes `Send`, `Validate` and
  `Settle`. On a vault with a timelock the revoke is staged like any other.
- An SDK caller names the program itself:
  `client.access.revokeDelegatePermissions(delegate, integrationProgram, protocolBitflag, permissionsBitmask)`.
- `delegate revoke-all <pubkey>` removes the delegate from the vault with every
  permission it holds, on every integration, and with its expiry. Grant again
  what the delegate should keep. It costs more than the other two ways, which
  keep the delegate's entry while it holds another permission:
  - The delegate comes back without an expiry. A grant to a delegate the vault
    does not list makes an entry that never expires, and nothing sets an
    expiry on an existing vault.
  - It is an emergency update, so it applies at once, and a change already
    staged that still lists the delegate brings it back on `timelock apply`.
    On a vault with a timelock the grants made again are staged, so the
    delegate holds nothing until `timelock apply`. Where a change already
    staged lists the delegate, a grant made again is added to that staged
    entry, which keeps whatever it holds on ext_bridge's protocol, so use
    one of the first two ways there.
  - It refuses a delegate that holds an active `CancelTimelock` permission.

## Upgrading to 1.3.0

1.3.0 is a minor release with breaking changes. This section lists what a
script written for 1.2.3 must change. A script that none of the entries names
needs no change.

Base units are an amount times 10 to the power of the decimals of its token.
The u64 maximum is 18446744073709551615 base units, and 2^127 is
170141183460469231731687303715884105728 base units.

### Every command

- A command refuses a positional argument it does not declare
  (`error: too many arguments`) and exits with status 1. 1.2.3 ignored it and
  ran. Remove it.
- A confirmation takes `y`, `ye` or `yes`, and `n` or `no`, in any case. A no,
  an empty line or a line of spaces sends nothing and exits with status 0, as in
  1.2.3. The confirmation asks again on any other answer, so a script that pipes
  another word exits with status 1. A Tab in a piped answer can turn it into a
  yes. 1.2.3 took any answer that began with `y` as a yes, such as `yeah`, and
  any other answer as a no. Pipe `y` or `n`, or pass `--yes`.
- A confirmation that gets no answer sends nothing and exits with status 1, as
  in 1.2.3. Its message on stderr is new and names `--yes`, where 1.2.3
  printed `readline was closed`. An answer needs its line end: `printf y`
  without a newline counts as no answer in both versions, so pipe `echo y`. A
  script that runs without a terminal passes `--yes`.
- The confirmation is written to stderr, or to stdout when stderr is
  redirected and stdout is the terminal. 1.2.3 wrote it to stdout, so a script
  that captured stdout also captured the question. A captured stdout now holds
  only what the command prints.
- `priority_fee.micro_lamports` in the config file must be a whole number of 0
  or more, written as a JSON number. 1.2.3 also took a string such as
  `"50000"` and a fraction. Every command now refuses such a file.

### Commands that need a change

- `marginfi borrow`, `marginfi repay`, `marginfi kamino-deposit` and
  `marginfi kamino-withdraw` ask for a confirmation before they send. 1.2.3
  sent at once. Add `--yes`.
- `loopscale-borrow borrow-principal` no longer has `--weight-matrix`. 1.2.3
  accepted the option and never applied it. Remove it.
- `loopscale-borrow borrow-principal` refuses a term that Loopscale strategies
  do not lend, such as `--duration 30`. The terms are one day
  (`--duration 1 --duration-type 0`), one week
  (`--duration 1 --duration-type 1`), one month
  (`--duration 1 --duration-type 2`), three months
  (`--duration 3 --duration-type 2`) and one year
  (`--duration 1 --duration-type 4`). `--duration-type` defaults to 0. 1.2.3
  borrowed at the first term whose rate matched the quote, which could be
  another term.
- `loopscale-borrow borrow-principal` on a loan that already has a borrow of
  the principal refuses `--duration`, `--duration-type` and
  `--strategy-duration-index` unless they name the term of that borrow
  exactly. 1.2.3 ignored them there. Leave them out.
- `loopscale-borrow borrow-principal` refuses `--duration`, `--duration-type`
  and `--external-yield-source` together with `--strategy`, and
  `--strategy-duration-index` without `--strategy`. 1.2.3 ignored them.
  Remove them.
- `loopscale-borrow allowlist-market` and `loopscale-lend allowlist-market`
  take only the indexes 0 to 4 in `--durations`. 1.2.3 stored any index.
- `phoenix place-market` refuses `--price-ticks`, which 1.2.3 ignored. Give a
  limit in ticks with `--price-limit <ticks> --price-limit-ticks`. It also
  refuses `--price-limit-ticks` without `--price-limit`.
- `phoenix place-market` rounds `--min-base-units` up to whole base lots,
  where 1.2.3 rounded it down, and refuses a minimum that is then above the
  size of the order, which is rounded down. A size and a minimum that are
  equal and not a whole number of base lots are refused. Give both in whole
  base lots, or use `--base-lots` with `--min-base-lots`.
- `phoenix place-market` refuses `--min-base-lots` together with
  `--min-base-units`. 1.2.3 used `--min-base-lots`. Pass one of them.
- `phoenix deposit` and `phoenix withdraw` refuse a `--trader-pda-index` or a
  `--subaccount-index` other than 0. 1.2.3 ignored both options and moved
  funds of trader 0, subaccount 0.
- `cctp receive` refuses `--tx-hash` together with `--nonce`. 1.2.3 used the
  nonce. Pass one of them.
- `delegate revoke-all`, `integration disable-all`,
  `transfer remove-destination` and `cctp remove-destination` exit with status
  1 and a message on stderr that says the delegate, the integration or the
  destination is not there. 1.2.3 sent a transaction that changed nothing and
  exited with status 0. Any other failure also exits with status 1, so a
  script that repeats one of these commands reads the message to tell already
  done from failed. When a change already staged lists the delegate or the
  integration, the message of `delegate revoke-all` and
  `integration disable-all` says so, and `glam-cli timelock apply` adds it.
- `delegate revoke-all` refuses a delegate that holds an active CancelTimelock
  permission, before the confirmation and with `--yes` too. 1.2.3 sent the
  revoke. A program with that permission refuses the revoke, and the production
  program, which has no such permission, removes the delegate. Revoke the
  permission first with
  `delegate revoke <delegate> --protocol SystemProgram CancelTimelock`, which on
  a vault with a timelock waits for the timelock and `glam-cli timelock apply`.
- On a vault with a timelock, a command that refuses an entry that is already on
  its list, or one that is not, now checks the staged change for it. Adding an
  entry that the staged change already adds, or removing one that it already
  removes, exits with status 1. 1.2.3 sent the edit and exited with status 0.
  Leave out an edit that the staged change already makes. `delegate revoke-all`
  and `integration disable-all` are the exception: they check the live list.
- `vault create` reads the vault file strictly. An integer field must be a
  whole number of 0 or more. 1.2.3 sent a negative number as its magnitude and
  cut a fraction. `mint.feeStructure` must give every fee object and every fee
  field, with 0 for no fee and `hurdleType` as `hard` or `soft`. 1.2.3 sent a
  missing fee as 0. `mint.defaultAccountStateFrozen` and
  `mint.notifyAndSettle.permissionlessFulfillment` must be JSON `true` or
  `false`. 1.2.3 read them by truthiness, so the string `"false"` counted as
  true.
- `vault update-owner` refuses a `--name` longer than 32 bytes of UTF-8. 1.2.3
  cut it short. Shorten it.
- `vault close-token-accounts` refuses token mints together with `--empty`.
  1.2.3 ignored the mints. Pass one or the other.
- `vault remove-token` and `vault remove-borrowable-token` read the mint
  account of the token when the removal leaves it on neither list, to warn
  when the vault still holds it. They exit with status 1 and
  `Failed to fetch mint account for <mint>` when the cluster has no such
  account, before the confirmation and with `--yes` too. This affects a token
  of the Jupiter verified list that the cluster does not have, such as a
  mainnet token on devnet. 1.2.3 read no mint account and sent the removal.
- `alt create` exits with status 1 before it sends when the vault has more
  than the 256 addresses a lookup table holds, and `alt extend` when the new
  addresses would take the table past 256. 1.2.3 sent the batches one at a
  time, so the batches before the one that failed had landed, and with
  `alt create` the table too. After the refusal the vault's tables are as they
  were, so a script that resumed from a partly created or extended table has
  nothing to resume.
- `token-acl create-list` stores the list under the lowercase mode. 1.2.3
  stored `--mode Allow` as typed. For a list that 1.3.0 creates, use lowercase
  modes in every `token-acl` command and in `token-acl thaw --seed`. Name a
  list that 1.2.3 made with capitals by `--mode` exactly as typed, or by the
  new `--list <address>`. `token-acl thaw` takes neither option, so pass it
  the original seed, such as `--seed Allow`. Lowercasing that seed selects
  another list.
- `token-acl setup-gate` exits with status 1 when a list given in
  `--additional-lists` does not exist. 1.2.3 skipped it with a warning. Create
  the list first.
- `kamino-farms unstake` refuses an amount above the stake of the vault and
  names the most it can unstake. 1.2.3 sent such an amount as shares at a
  fixed rate, and the farm unstaked those shares or the whole stake, whichever
  was less, so part of the stake could stay. Pass the amount the refusal names.
  Shares worth less than one base unit of the farm token can stay staked. When
  the whole stake is worth less than that, the refusal names 0, and the command
  refuses an amount of 0, so it cannot unstake that stake.
- `kamino-lend borrow` refuses the u64 maximum as an amount. 1.2.3 sent it,
  and Kamino Lending reads it as the most the obligation can borrow. Give the
  amount to borrow.
- `rpi submit` and `neutral deposit` refuse an amount in exponent notation,
  such as `1e3`. `rpi submit` also refuses `0x10` and `1_000`.
  `neutral deposit` also refuses `.5`, `1.`, a leading `+`, text after the
  number and more decimals than its token has. 1.2.3 read `1,000` as `1`
  there. Write `1000`, `16`, `0.5` and `1`.
- `rpi submit-wormhole` refuses `--max-signatures-per-post 0`, which 1.2.3
  read as 13.
- `rpi submit` refuses a `--timestamp` that is after the clock of the cluster
  when the command reads it. 1.2.3 sent it, and the program took it when the
  cluster had reached that time by the time the transaction ran. Leave
  `--timestamp` out to stamp the observation with the clock of the cluster.
- `rpi validate` reads the pending observation before the confirmation and again
  before it sends, with `--yes` too. When a submit replaced it between the two
  reads, the command sends nothing and exits with status 1, with a message on
  stderr that says the pending observation changed. 1.2.3 validated whatever
  observation was pending when its transaction ran. Run `rpi validate` again and
  review the observation that is pending now. The confirmation of `rpi validate`
  shows it, and `--yes` skips the confirmation. A submit that lands after the
  second read and before the validation is not caught.
- Without `--base58`, `cctp allowlist-destination`, `cctp remove-destination`
  and `cctp bridge-usdc` refuse a destination address that is not 40 or 64
  hexadecimal digits, with or without a `0x` prefix. 1.2.3 read most such text
  as another recipient. It refused only text that came to more than 32 bytes.
- An option or an argument that takes bytes as hex or base64 refuses text that
  is neither. These are `--options` and `--compose-msg` of
  `bridge oft send-usdt`, `<signed-vaa>` of `rpi submit-wormhole`,
  `--emitter-address` of `rpi upsert-wormhole-config`, the address options of
  `rpi upsert-hyperliquid-config` and the `<transfer-id>` of `bridge settle`
  and `bridge oft derive-aux-account`. 1.2.3 read such text, other than an empty
  `--options`, as whatever bytes it could decode from it, and refused it only
  when it decoded to no bytes or to bytes that did not fit the command. For
  example, 1.2.3 took a `<transfer-id>` of `0x`, 64 hexadecimal digits and a
  stray `z` as its first 32 bytes, which is refused now. Unpadded base64 of an
  odd length that holds only hexadecimal digits, such as `abc`, is refused too.
  Pad it or write it as hex. The `<position>` of the `rpi` commands still reads
  other text as an id of up to 32 bytes.
- The `exponent` and `orca` commands take `isSigner` and `isWritable` in
  `--remaining-accounts` only as JSON `true` or `false`, or left out. 1.2.3
  read them by truthiness, so `1` marked the account and so did the string
  `"false"`.
- `--remaining-accounts-info` of the `orca` commands takes the `length` of a
  slice only as a JSON whole number from 0 to 255. 1.2.3 took the string
  `"2"` as 2, cut `1.5` to 1 and sent a missing `length` as 0.
- `exponent buy-pt` refuses `--mint-sy-rem-accounts-until` without
  `--remaining-accounts`, and `exponent sell-pt` refuses
  `--redeem-sy-rem-accounts-until` without it. 1.2.3 ignored them. Remove
  them.
- These options refuse an empty value, which 1.2.3 took, in most cases as the
  option left out: `--freshness-secs`, `--external-shares`,
  `--max-signatures-per-post`, `--guardian-set`,
  `--wormhole-core-bridge-program` and `--wormhole-verify-vaa-shim-program` of
  the `rpi` commands, `--min-amount` and `--options` of
  `bridge oft send-usdt`, `--destination-caller` of
  `bridge cctp allow-route`, `--origination-cap` of
  `loopscale-lend create-strategy`, `--remaining-accounts` of the `exponent`
  and `orca` commands, `--remaining-accounts-info` of the `orca` commands,
  `--price-limit`, `--min-base-lots`, `--min-base-units` and `--quote-lots` of
  `phoenix place-market`, `--min-out` and `--max-shares` of the `jupiter-earn`
  commands and `--max-accounts` of `jupiter-swap swap` and
  `jupiter-swap swap-v2`. Leave the option out, for example in bash with
  `${MIN_AMOUNT:+--min-amount "$MIN_AMOUNT"}`. `exponent buy-pt` and
  `exponent sell-pt` are the exception: 1.2.3 read an empty
  `--remaining-accounts` as no accounts, which is `[]` now.
- `--source-mint` of `bridge cctp allow-route` and `bridge cctp update-route` no
  longer reads an empty value as the option left out, as 1.2.3 did. It looks the
  empty text up as a symbol in the Jupiter verified list. It exits with status 1
  unless the list holds a token with an empty symbol, and otherwise uses the
  mint of that token. Leave the option out.

### Command lines that send something else

The same command line is accepted and now sends something else. 1.2.3 misread
most of these inputs. A script that relied on the 1.2.3 result takes the step
its entry names.

- `manage update-min-redemption` reads its amount in shares. 1.2.3 scaled it
  by the decimals of the base asset. On a vault whose share mint and base
  asset have different decimals, set the minimum again.
- `kamino-farms unstake` sends the shares that pay the amount at the rate of
  the farm. 1.2.3 assumed one fixed rate.
- `phoenix place-limit` and `phoenix place-market` round the price of an ask
  up to the tick, where 1.2.3 rounded it down. On a market whose base lot is
  more than one unit, such as PUMP, a price keeps its digits past the sixth
  decimal, which 1.2.3 dropped. Pass `--price-ticks` to `place-limit` or
  `--price-limit-ticks` to `place-market` for an exact tick.
- `rpi submit`, `neutral deposit` and `neutral withdraw` send every digit of
  an amount. 1.2.3 rounded an amount of more than about 15 significant
  digits, or 20 for `rpi submit`.
- `rpi submit` without `--timestamp` stamps the observation with the clock of
  the cluster, where 1.2.3 used the clock of the host.
- `jupiter-swap allowlist-token` keeps a stored max slippage of 0. 1.2.3
  raised it to 50. Run `jupiter-swap set-max-slippage 50` to set it.
- `vault update-owner`, `vault extend` and `manage claim-fees` set their
  priority fee and stop on a failed simulation, as the other commands do.
  1.2.3 paid a fixed 10000 micro-lamports per compute unit on them on every
  cluster, whatever the config said. It sent them after a failed simulation,
  and then with no priority fee. They now pay 1000000 micro-lamports per
  compute unit when `cluster` in the config file is `devnet` or `localnet`,
  whatever `priority_fee` says. On any other cluster they pay the priority fee
  of the config, and none when it sets neither `priority_fee.micro_lamports`
  nor `priority_fee.helius_api_key`. Pass `-S` to send after a failed
  simulation. Such a send pays no priority fee, as in 1.2.3.
- An option or an argument that takes bytes as hex or base64 reads a `0X` prefix
  and hex with spaces as hex. 1.2.3 read such text as base64, or after a `0x`
  prefix as the hex before the first space, and used those other bytes where it
  did not refuse them.
- On a vault with a timelock, most changes wait as a staged change until
  `glam-cli timelock apply`. A command that edits a list or a policy starts from
  the staged change. In the commands that send a whole list or a whole policy,
  such as `vault allowlist-token` and `jupiter-swap allowlist-token`, 1.2.3
  started from the live value and dropped the staged change of that list or
  policy. `integration enable`, `integration disable`, `delegate grant` and
  `delegate revoke` already started from the staged change in 1.2.3.
  `rpi upsert-position`, `rpi upsert-wormhole-position` and
  `rpi remove-position` still replace a staged change of the RPI policy. The two
  upserts now say so in their confirmation. `manage update-min-subscription` and
  `manage update-min-redemption` still start from the live mint policy, so
  staging either one drops every staged change of that policy, such as a minimum
  that the other command staged, or a lockup period, maximum cap, allowlist or
  blocklist staged another way. `bridge cctp update-route` and
  `bridge oft update-route` start from the live route, as in 1.2.3. When the
  live and staged copies of the route differ, they send nothing and exit with
  status 1 unless `--base` names the copy to start from. Pass `--base pending`
  to edit the staged copy, which a route that only a staged set holds needs
  too. The emergency updates `vault enable`, `vault disable`, `manage pause`
  and `manage unpause` apply at once, as in 1.2.3.
- `delegate revoke-all` and `integration disable-all` are emergency updates too.
  As in 1.2.3, they change the live list at once and leave a staged change as it
  is. A staged change of the delegate or integration list keeps a copy of that
  whole list, and a staged policy change keeps a copy of the integration list.
  `glam-cli timelock apply` puts the copy in place, and a removed delegate or
  integration that it still lists comes back. The two commands now say so in
  their confirmation, which `--yes` skips. Before `glam-cli timelock apply`, run
  `glam-cli timelock view`, which shows such an entry under `Added delegates` or
  `Added integrations`. Drop every staged change with
  `glam-cli timelock cancel`, or edit the staged list with
  `glam-cli delegate revoke` or `glam-cli integration disable` until it no
  longer lists the entry.

### Output

- On a vault with a timelock, a command that stages a change prints the
  success line below, where `<done>` is what the command did. The signature is
  still the text after the last colon and space. Run the command the line
  names as `glam-cli timelock apply`.

  ```text
  <done>, once `glam timelock apply` applies the staged change after the timelock: <signature>
  ```

- The `allow-route`, `update-route` and `remove-route` commands of
  `bridge cctp` and `bridge oft` and `rpi remove-position` keep their 1.2.3
  success lines, also when they stage a change.
- These success lines changed: `Paused redemption and subscription` and
  `Unpaused redemption and subscription` for `manage pause redemption` and
  `manage unpause redemption`,
  `Updated minimum redemption amount to <amount> shares` for
  `manage update-min-redemption`, `Unstaked <amount> <symbol> (<mint>)` for
  `lst unstake`, `Withdrew <amount> mSOL into a stake account` for
  `marinade withdraw-stake`, `Limits of borrow market <market> removed` for
  `loopscale-borrow remove-market`,
  `Limits of lending market <market> removed` for
  `loopscale-lend remove-market`, `RPI position <label> upserted` for
  `rpi upsert-position` and `rpi upsert-wormhole-position` and
  `Withdrew the maximum withdrawable <symbol> collateral` for
  `kamino-lend withdraw` of the u64 maximum. With `--deactivate` the lines of
  `lst unstake` and `marinade withdraw-stake` go on with
  `and deactivated the new stake account` and `and deactivated it`.
- `cctp view-policy` prints a recipient that is not an EVM address in full, as
  64 hexadecimal digits.
- A vault name prints its control characters as `\uXXXX`.
- A send that fails prints its failure line first, then
  `Sent <signature>: check its status on chain before sending again.` on
  stderr for each transaction it sent, and a line that begins with
  `Signed <signature>` for each one it signed that may have gone out. When the
  wallet signed and no signature is known, the line begins with
  `The wallet signed a transaction that may have been sent`. After a signature
  the failure line does not advise to try again. `phoenix onboard` prints its
  own failure lines.
- A `jupiter-swap` swap that fails prints its message without the `Error: `
  prefix. It suggests `--only-direct-routes` only when nothing was signed or
  sent.
- A whole number larger than its field, an amount larger than its command takes
  and many values that the program of the command refuses are refused before the
  confirmation. 1.2.3 in most cases asked first and failed after it. Most
  amounts go up to the u64 maximum. `jupiter-borrow withdraw` and
  `jupiter-borrow repay` also take 2^127 base units to withdraw all collateral
  or repay all debt, as in 1.2.3. `neutral withdraw` takes shares up to the u128
  maximum. `rpi submit` takes an amount in the i128 range, and an `orca`
  liquidity amount goes up to the i128 maximum.
- Every confirmation ends with the fee payer and the priority fee, and many
  name what they send.

## Documentation

Please visit [GLAM CLI Documentation](https://docs.glam.systems/v1/cli/) for more information.
