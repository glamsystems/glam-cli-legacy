# CLI publication

The private controller (`scripts/sdk-release/`) mirrors an approved CLI
snapshot to `release/cli-vX.Y.Z` in the public repository and creates the
immutable tag `vX.Y.Z`. This document, the publishing workflow and its
script belong to the monorepo, under
`scripts/sdk-release/public/glam-cli-legacy/`. The source sync installs them
in the public repository with the monorepo's root `.node-version` and lists
them in `.github/release-companion.json`.

- `.github/workflows/publish.yml` builds, packs and publishes
  `@glamsystems/glam-cli` at the tag with npm trusted publishing, then
  verifies the installation and completes the public GitHub Release. The
  controller reads the run's conclusion and the jobs named **Publish CLI** and
  **Finish CLI release**, so a completed run means every job passed. **Finish
  CLI release** must have passed in the run's latest attempt, and **Publish
  CLI** in that attempt or an earlier one, because **Re-run failed jobs**
  leaves a publish job that passed at its earlier attempt.
- `scripts/release-cli.mjs` holds the modes the workflow runs: `validate`,
  `pack`, `publish`, `verify` and `finish`.
- `scripts/check-bundle.mjs` is the bundle check. The pack mode runs it on the
  tarball it packs, and the private controller runs it in the release
  snapshot and on every pull request that changes the CLI.

The controller reads `.cli-release.json` (version, private source commit,
notes) from the tagged commit and expects the GitHub Release body to end with
`<!-- cli-release: <source commit> <public commit> -->`.

## Jobs

Each job checks out the tag's exact SHA without persisted credentials and sets
up the Node version in `.node-version` without a package cache.
`.node-version` holds the monorepo controller's exact Node version: the
controller writes its own root `.node-version` into every release snapshot. No
job installs another npm, so every job runs the npm bundled with that Node. The
release script runs `npm pack` and `npm publish` as that Node with the bundled
npm's `bin/npm-cli.js`, the npm whose modules its checks load. Only the build
job runs the package's dependencies, and it holds no write permission.

| Job       | Name               | Permissions                                                       | What it runs                                                            |
| --------- | ------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `build`   | Build CLI          | `contents: read`                                                  | `npm ci --ignore-scripts`, `npm run build`, then `release-cli.mjs pack` |
| `publish` | Publish CLI        | `contents: read`, `id-token: write`, environment `npm-production` | `release-cli.mjs publish`                                               |
| `verify`  | Verify CLI         | `contents: read`                                                  | `release-cli.mjs verify`                                                |
| `finish`  | Finish CLI release | `contents: write`                                                 | `release-cli.mjs finish`                                                |

`publish` needs `build`, `verify` needs `build` and `publish`, and `finish`
needs `build` and `verify`. Every job carries the publication condition.

The package's `prepack` script is `npm run build`. A folder publish would run
it, and the pack mode packs with `--ignore-scripts`, so the build job runs
`npm run build` itself before it packs. Every mode refuses a `package.json`
with any other `prepublishOnly`, `prepack`, `prepare`, `postpack`, `publish` or
`postpublish` script, because a folder publish would run it and the pack does
not. The tarball therefore holds what a folder publish would publish, apart
from `gitHead`.

The pack mode writes the release commit into `package.json` as `gitHead`,
packs and restores the committed `package.json`. npm reads `gitHead` from the
folder's git HEAD when it publishes a directory. When it publishes a tarball
it reads `package.json` in a temporary folder under its cache, so the tarball
carries `gitHead` itself. The build job writes the tarball's file name and its
`sha512` integrity to its outputs and uploads the tarball with the pack
manifest as the artifact `release-tarball-<run attempt>`.

The publish job holds the `id-token: write` permission and a read-only
workflow token. It installs nothing from the registry: it runs no `npm ci`, no
build and no install of npm or of the package. It downloads the artifact
outside the checkout and checks the tarball before its first registry request,
in this order:

1. The tarball's `sha512` equals the integrity the build job reported.
2. The script's own tar reader is a stricter first layer, and npm's listing
   and manifest below are the authority. It accepts only POSIX ustar headers
   with version `00` and with nothing after the prefix field that `npm pack`
   does not write. It reads the prefix field as npm's tar module does, 155
   bytes when byte 475 is not 0 and 130 bytes otherwise. It refuses a pax
   record that holds a newline or a NUL, and one whose length is not plain
   decimal digits equal to the record's byte count, such as `1e2` or `0x64`.
   It refuses a second entry under one path, an entry outside `package/` and
   any entry that is not a regular file. Its `package/package.json` must
   equal this commit's `package.json` with `gitHead` added.
3. The `tar` module of the npm bundled with the job's Node lists the tarball.
   It must warn of nothing, and each entry must be a regular file or a
   directory under `package/`, listed once.
4. The `pacote` module of that npm reads the manifest with the call
   `npm publish` makes for a tarball, `pacote.manifest` with `fullMetadata`
   and `fullReadJson`. Normalized by npm, it must equal this commit's
   `package.json` with `gitHead` added, read alone in an empty directory. Only
   the readme and pacote's own records of the file may differ. A field the
   build job added, such as `publishConfig`, fails, and so does a file that
   makes npm add a field, such as a `binding.gyp`.

The pack mode runs the same checks on the tarball it packed, and then the
bundle check on that tarball. The bundle check refuses unless all of these
hold:

1. `package.json`'s `bin` is the one command `glam-cli`, started from `main.js`
   or `./main.js`. `main.js` starts with `#!/usr/bin/env node`, and
   `node main.js --version` exits 0 and prints exactly the version in
   `package.json` on stdout. A warning on stderr does not count.
2. `main.js` is searched as text, not as syntax. The search sees each place
   where the word `require` or `import`, with any text before it, is followed by
   optional space, an optional `?.` and an opening parenthesis. Text in a string
   or a comment counts like code. Each place is one of three kinds. A literal is
   a place followed by optional space, a quote, a module name, the same quote,
   optional space and a closing parenthesis. A module name is one or more ASCII
   letters, digits and the characters `@ / . _ : -`, so no place stands inside a
   literal.
   Another string is a place followed by optional space and a quote that does
   not start a literal, and it is refused for both words. Every other place is
   computed. A computed `require(` is refused, and a computed `import(` passes,
   because the bundle has one. Each literal names a Node builtin, a key of
   `dependencies` or `optionalDependencies`, or a guarded optional load. A
   guarded optional load is named in the check's list with its reason and the
   package that loads it inside try/catch, and every installed copy of that
   package marks it `optional: true` in `peerDependenciesMeta`. Today the list
   is `utf-8-validate`, which `ws` loads, and `encoding`, which `node-fetch`
   loads. A path or a URL is refused, because the published package holds
   `main.js` and no such file. A literal is refused when a segment between its
   slashes is only dots, or is `node_modules` in any case with or without dots
   after it, since such a segment can leave the package the literal names and
   load a package that `package.json` does not declare. A plain subpath still
   counts as its package.
3. The tarball, installed with `--ignore-scripts` into a fresh project in a
   temporary folder, gives the command `glam-cli` in `node_modules/.bin`. The
   command starts with `--version` from a folder with no `cli/` subfolder and
   prints the version. Each declared package from the search and each key of
   `optionalDependencies` resolves from the installed package to the same
   package name and version as from the checkout, or is absent in both. The
   name is the one in the resolved `package.json`, so an alias counts by its
   real package.

The pack mode starts the check with only `PATH`, `HOME`, `TMPDIR` and npm's
own settings in its environment. The package code the check starts therefore
does not get the path of the step's output file or of any other workflow
file. The check writes nothing in the checkout.

The search sees only those places. These are examples, not a full list. It does
not see `require` or `import` held in another name or called through `call`,
`apply` or `bind`, a module loaded through `createRequire`, what an `import(`
that is not followed by a quote loads, or a call written with an escape in its
name or a comment before its parenthesis. The optional dependencies are compared
because the build loads them through a `createRequire` wrapper.

When the bundle check refuses, the job reports no tarball and nothing is
published. A rerun at the same tag refuses the same way, because the tag
freezes the source, the lockfile and `package.json`. The release cannot
complete at this tag. For a fault in what the bundle loads, correct the CLI in
the monorepo, for example by declaring the package the bundle loads. A fault
in `bin` is in this repository's own `package.json`, whose `bin` the sync
keeps as it is, so a change to the CLI in the monorepo does not correct it. In
both cases decide the recovery of this release in the monorepo.

Every mode also
refuses a `package.json` that carries a `publishConfig` other than
`{ "access": "public" }`, which the mirror has always carried. Only a registry
HTTP 404 permits a publish, which runs from an empty directory:

```bash
npm publish <tarball> --ignore-scripts --access public --provenance --tag latest --registry=https://registry.npmjs.org --@glamsystems:registry=https://registry.npmjs.org/
```

npm runs no lifecycle script for a tarball and still exchanges the job's OIDC
token for a publishing token. npm drops each `publishConfig` key that is also
one of these flags and applies the others. For a scoped package npm prefers
the scope's registry over `--registry`, and the token exchange goes to that
registry, so the command sets both.

An existing version is accepted only when its `gitHead` is this commit and its
integrity equals the tarball's. The verify job waits for the version and checks
its identity, signature and provenance. It installs the version with
`--ignore-scripts` and `--prefer-online`. npm's package index can lag the
version endpoint by minutes. So while the install fails with `ETARGET`, the job
tries again every 15 seconds, 20 times in all, and then stops and says so. Any
other install error ends the job at once. The installed tarball's integrity
must equal the reported one. The job then runs `npm audit signatures`, loads
the installed version and starts the installed `glam-cli --version`, which
must print the version on stdout. The finish job
runs no npm. It checks the registry identity through `fetch` and then completes the
GitHub Release.

The build job's dependencies can change the files they build. They hold the
job's Actions runtime token, so they can write artifacts and caches of the run.
They cannot obtain the npm publishing identity or write to this repository.

## Recovery

Do not move the tag or bump the version to retry a run.

- A failed verify or finish job can be rerun alone with **Re-run failed jobs**.
  Each reads only the build job's reported integrity and the registry, so it
  rebuilds nothing.
- **Re-run failed jobs** after a failed build job runs the build job again,
  with every job that needs it, in the new attempt.
- A failed publish job cannot be rerun alone. The artifact name carries the
  run attempt, so a publish job that reruns alone fails at the artifact
  download. Use **Re-run all jobs**, or dispatch `publish.yml` at the
  same tag.

A rerun of all jobs packs again. When the version is already on npm, the
publish job accepts it only when its `gitHead` is this commit and the rebuilt
tarball has the published digest, and never publishes it again. The tag
freezes the source and the lockfile, and `.node-version` pins the exact Node
and its npm. The pin makes a byte identical rebuild possible. A rebuild that
differs cannot complete at this tag. The published version then stays as it is
on npm. Find what changed the build, then approve a new patch version in the
monorepo and release that.

The tests in `scripts/tests/release-cli.test.mjs` and
`scripts/tests/check-bundle.test.mjs` run with the Node version in
`.node-version` and load npm's own modules from the npm bundled with it:

```bash
node --test scripts/tests/release-cli.test.mjs scripts/tests/check-bundle.test.mjs
```

To run the bundle check by hand, run it from the repository root after
`npm ci --ignore-scripts` and `npm run build`. It needs the registry for the
user install:

```bash
node scripts/check-bundle.mjs
```
