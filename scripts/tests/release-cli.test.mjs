import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runs scripts/release-cli.mjs as publish.yml does, one step per process, with
// git and npm replaced by recording fakes on PATH and fetch replaced by a
// preloaded stand-in for the npm registry and the GitHub API. The fakes print
// to the stdout they inherit, as npm publish and npm install do.
const SCRIPT = fileURLToPath(new URL("../release-cli.mjs", import.meta.url));
const PACKAGE = "@glamsystems/glam-cli";
const VERSION = "1.2.0";
const TAG = `v${VERSION}`;
const HEAD = "a".repeat(40);
const SOURCE = "b".repeat(40);
const INTEGRITY = "sha512-test-cli-package-integrity";
const REPOSITORY = "glamsystems/glam-cli-legacy";

const FAKE_GIT = `#!/bin/sh
echo "git $*" >> "$FAKE_STATE/commands"
case "$1" in
  rev-parse|rev-list) echo "$FAKE_HEAD" ;;
  *) echo "unexpected git $*" >&2; exit 2 ;;
esac
`;

const FAKE_NPM = `#!/bin/sh
echo "npm $*" >> "$FAKE_STATE/commands"
case "$1" in
  pack) printf '[{"integrity":"%s"}]\\n' "$FAKE_INTEGRITY" ;;
  publish) touch "$FAKE_STATE/published"; echo "+ $FAKE_PACKAGE@$FAKE_VERSION" ;;
  install)
    mkdir -p "node_modules/$FAKE_PACKAGE"
    printf '{"name":"%s","version":"%s"}\\n' "$FAKE_PACKAGE" "$FAKE_VERSION" \\
      > "node_modules/$FAKE_PACKAGE/package.json"
    echo "added 1 package" ;;
  audit) echo "1 package has a verified registry signature" ;;
  *) echo "unexpected npm $*" >&2; exit 2 ;;
esac
`;

const FAKE_FETCH = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const state = process.env.FAKE_STATE;
const metadata = JSON.parse(process.env.FAKE_METADATA);
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  const { pathname } = new URL(url);
  appendFileSync(join(state, "requests"), method + " " + pathname + "\\n");
  if (pathname.endsWith("/" + metadata.version) && url.startsWith("https://registry.npmjs.org/"))
    return existsSync(join(state, "published"))
      ? Response.json(metadata)
      : new Response("", { status: 404 });
  const release = join(state, "release.json");
  if (method === "GET" && pathname.endsWith("/releases/tags/" + process.env.GITHUB_REF_NAME))
    return existsSync(release)
      ? Response.json(JSON.parse(readFileSync(release, "utf8")))
      : new Response("", { status: 404 });
  if (method === "POST" && pathname.endsWith("/releases")) {
    const body = { ...JSON.parse(init.body), html_url: "https://github.invalid/release" };
    writeFileSync(release, JSON.stringify(body));
    return Response.json(body, { status: 201 });
  }
  return new Response("", { status: 500 });
};
`;

function releaseScenario({ published = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "glam-cli-release-test-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const work = join(root, "work");
  for (const directory of [bin, state, work]) mkdirSync(directory);
  writeFileSync(join(bin, "git"), FAKE_GIT);
  writeFileSync(join(bin, "npm"), FAKE_NPM);
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  writeFileSync(join(root, "fetch.mjs"), FAKE_FETCH);
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ name: PACKAGE, version: VERSION }),
  );
  writeFileSync(
    join(work, ".cli-release.json"),
    JSON.stringify({
      schemaVersion: 1,
      package: PACKAGE,
      version: VERSION,
      source: { repository: "glamsystems/glam", commit: SOURCE },
      notes: "## CLI 1.2.0\n\nApproved changes.",
    }),
  );
  if (published) writeFileSync(join(state, "published"), "");
  const env = {
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: root,
    TMPDIR: root,
    FAKE_STATE: state,
    FAKE_HEAD: HEAD,
    FAKE_INTEGRITY: INTEGRITY,
    FAKE_PACKAGE: PACKAGE,
    FAKE_VERSION: VERSION,
    FAKE_METADATA: JSON.stringify({
      name: PACKAGE,
      version: VERSION,
      gitHead: HEAD,
      dist: {
        integrity: INTEGRITY,
        signatures: [{ keyid: "test-registry-key" }],
        attestations: { url: "https://registry.npmjs.org/-/npm/v1/test" },
      },
    }),
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: TAG,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_TOKEN: "test-token",
  };
  const step = (name) => {
    const result = spawnSync(
      process.execPath,
      ["--import", join(root, "fetch.mjs"), SCRIPT, name],
      { cwd: work, env, encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `release-cli.mjs ${name} exited ${result.status}:\n${result.stderr}`,
    );
    return result.stdout;
  };
  const lines = (file) =>
    existsSync(join(state, file))
      ? readFileSync(join(state, file), "utf8").trim().split("\n")
      : [];
  return {
    step,
    commands: () => lines("commands").filter((line) => line.startsWith("npm")),
    requests: () => lines("requests"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a first publication publishes, verifies the installation and completes the GitHub Release", (t) => {
  const run = releaseScenario();
  t.after(run.cleanup);
  run.step("validate");
  // npm publish prints to the job log; its output is not captured.
  assert.match(run.step("publish"), new RegExp(`\\+ ${PACKAGE}@${VERSION}`));
  run.step("verify");
  assert.match(
    run.step("release"),
    new RegExp(`GitHub Release ${TAG} complete`),
  );
  assert.deepEqual(run.commands(), [
    "npm publish --access public --provenance --tag latest",
    `npm install --ignore-scripts --no-audit --no-fund ${PACKAGE}@${VERSION}`,
    "npm audit signatures",
  ]);
  assert.deepEqual(
    run.requests().filter((line) => line.startsWith("POST")),
    [`POST /repos/${REPOSITORY}/releases`],
  );
});

test("a retry after the publication landed skips publishing and completes verification", (t) => {
  const run = releaseScenario({ published: true });
  t.after(run.cleanup);
  assert.match(run.step("publish"), /already published from this commit/);
  run.step("verify");
  run.step("release");
  assert.deepEqual(run.commands(), [
    "npm pack --dry-run --json",
    `npm install --ignore-scripts --no-audit --no-fund ${PACKAGE}@${VERSION}`,
    "npm audit signatures",
  ]);
});
