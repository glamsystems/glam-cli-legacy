# CLI publication

The private controller (`scripts/sdk-release/`) mirrors an approved CLI
snapshot to `release/cli-vX.Y.Z` in the public repository and creates the
immutable tag `vX.Y.Z`. This document, the publishing workflow and its
script belong to the monorepo, under
`scripts/sdk-release/public/glam-cli-legacy/`; the source sync installs them
in the public repository and lists them in `.github/release-companion.json`.

- `.github/workflows/publish.yml` builds and publishes `@glamsystems/glam-cli`
  at the tag with npm trusted publishing, then verifies the installation and
  completes the public GitHub Release. The controller reads the job named
  **Publish CLI**.
- `scripts/release-cli.mjs` holds the publication steps the workflow runs.

The controller reads `.cli-release.json` (version, private source commit,
notes) from the tagged commit and expects the GitHub Release body to end with
`<!-- cli-release: <source commit> <public commit> -->`.
