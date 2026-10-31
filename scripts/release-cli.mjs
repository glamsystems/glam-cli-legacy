import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Publication steps for @glamsystems/glam-cli at an immutable release tag.
// The private controller created the tag and .cli-release.json; this script
// publishes, verifies, and completes the public GitHub Release.
const PACKAGE = "@glamsystems/glam-cli";
const MARKER = ".cli-release.json";
const PROOF = "cli-release";

// execFileSync returns null when stdout is not piped (stdio: "inherit").
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  })?.trim();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

function context() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const marker = JSON.parse(readFileSync(MARKER, "utf8"));
  const head = run("git", ["rev-parse", "HEAD"]);
  const tag = `v${pkg.version}`;
  if (pkg.name !== PACKAGE)
    fail(`package.json names ${pkg.name}, expected ${PACKAGE}`);
  if (
    marker.schemaVersion !== 1 ||
    marker.package !== PACKAGE ||
    marker.version !== pkg.version
  )
    fail(`${MARKER} does not describe ${PACKAGE}@${pkg.version}`);
  if (!/^[a-f0-9]{40}$/.test(marker.source?.commit ?? ""))
    fail(`${MARKER} has no exact private source commit`);
  if (
    process.env.GITHUB_REF_TYPE !== "tag" ||
    process.env.GITHUB_REF_NAME !== tag
  )
    fail(`This workflow runs only at tag ${tag}`);
  return { pkg, marker, head, tag };
}

async function registry(version) {
  const response = await fetch(
    `https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}/${version}`,
    { headers: { "cache-control": "no-cache" } },
  );
  if (response.status === 404) return null;
  if (!response.ok) fail(`npm registry lookup failed: HTTP ${response.status}`);
  return response.json();
}

function validate() {
  const { tag, head } = context();
  const tagged = run("git", ["rev-list", "-n", "1", tag]);
  if (tagged !== head)
    fail(`Tag ${tag} resolves to ${tagged}, not the checked-out ${head}`);
}

async function publish() {
  const { pkg, head } = context();
  const existing = await registry(pkg.version);
  if (existing) {
    if (existing.gitHead !== head)
      fail(
        `${PACKAGE}@${pkg.version} is already published from ${existing.gitHead}; this commit is ${head}`,
      );
    const built = JSON.parse(run("npm", ["pack", "--dry-run", "--json"]))[0];
    if (built.integrity !== existing.dist.integrity)
      fail(
        `${PACKAGE}@${pkg.version} on npm differs from the package built here`,
      );
    console.log(
      `${PACKAGE}@${pkg.version} already published from this commit; skipping publish`,
    );
    return;
  }
  run(
    "npm",
    ["publish", "--access", "public", "--provenance", "--tag", "latest"],
    {
      stdio: "inherit",
    },
  );
}

async function verify() {
  const { pkg, head } = context();
  const metadata = await registry(pkg.version);
  if (!metadata) fail(`${PACKAGE}@${pkg.version} is not on npm`);
  if (
    metadata.gitHead !== head ||
    !metadata.dist?.integrity?.startsWith("sha512-") ||
    !metadata.dist?.signatures?.length ||
    !metadata.dist?.attestations?.url
  )
    fail("npm package identity/provenance does not match this release commit");
  const sandbox = mkdtempSync(join(tmpdir(), "glam-cli-verify-"));
  writeFileSync(
    join(sandbox, "package.json"),
    JSON.stringify({ name: "verify", private: true }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `${PACKAGE}@${pkg.version}`,
    ],
    {
      cwd: sandbox,
      stdio: "inherit",
    },
  );
  run("npm", ["audit", "signatures"], { cwd: sandbox, stdio: "inherit" });
  const installed = run(
    "node",
    ["-e", `console.log(require('${PACKAGE}/package.json').version)`],
    {
      cwd: sandbox,
    },
  );
  if (installed !== pkg.version)
    fail(`Installed ${installed}, expected ${pkg.version}`);
}

async function release() {
  const { marker, head, tag } = context();
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN is required to complete the GitHub Release");
  const repo = process.env.GITHUB_REPOSITORY;
  const body = `${marker.notes.trim()}\n\n<!-- ${PROOF}: ${marker.source.commit} ${head} -->`;
  const api = async (route, init = {}) => {
    const response = await fetch(
      `https://api.github.com/repos/${repo}${route}`,
      {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          ...init.headers,
        },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok)
      fail(`GitHub ${init.method ?? "GET"} ${route}: HTTP ${response.status}`);
    return response.json();
  };
  let existing = await api(`/releases/tags/${tag}`);
  if (!existing) {
    existing = await api("/releases", {
      method: "POST",
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: head,
        name: tag,
        body,
        draft: false,
        prerelease: false,
        make_latest: "true",
      }),
    });
  }
  if (
    existing.tag_name !== tag ||
    existing.draft ||
    existing.prerelease ||
    existing.target_commitish !== head ||
    existing.body?.trim() !== body
  )
    fail(`Existing GitHub Release ${tag} does not match this publication`);
  console.log(`GitHub Release ${tag} complete: ${existing.html_url}`);
}

const steps = { validate, publish, verify, release };
const step = steps[process.argv[2]];
if (!step)
  fail(
    "Usage: node scripts/release-cli.mjs validate | publish | verify | release",
  );
await step();
