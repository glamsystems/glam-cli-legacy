import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";

// Publication steps for @glamsystems/glam-cli at an immutable release tag.
// The private controller created the tag and .cli-release.json; this script
// packs, publishes, verifies, and completes the public GitHub Release.
const PACKAGE = "@glamsystems/glam-cli";
// The command the verify job starts. scripts/check-bundle.mjs holds the same
// name, and a test keeps the two equal.
export const COMMAND = "glam-cli";
const MARKER = ".cli-release.json";
const PROOF = "cli-release";
const REGISTRY = "https://registry.npmjs.org";
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
// The publishConfig the mirror's package.json has always carried. The publish
// flags set access too, so npm ignores it.
const PUBLISH_CONFIG = { access: "public" };
// A folder publish runs these scripts and the pack mode runs none of them. The
// build job runs npm run build itself, which is what prepack runs.
const LIFECYCLE = [
  "prepublishOnly",
  "prepack",
  "prepare",
  "postpack",
  "publish",
  "postpublish",
];
const RUN_BY_THE_BUILD_JOB = { prepack: "npm run build" };
const BUNDLE_CHECK = fileURLToPath(
  new URL("./check-bundle.mjs", import.meta.url),
);
// The verify job retries an install that finds no matching version for this
// long: npm's package index can lag the version endpoint by minutes.
export const INSTALL_ATTEMPTS = 20;
export const INSTALL_INTERVAL = 15_000;

// execFileSync returns null when stdout is not piped (stdio: "inherit").
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  })?.trim();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
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
  // The pack mode writes gitHead, so the committed package.json has none.
  if (pkg.gitHead !== undefined) fail("package.json must not carry gitHead");
  // npm applies every publishConfig key that is not also a command line flag.
  if (
    pkg.publishConfig !== undefined &&
    !isDeepStrictEqual(pkg.publishConfig, PUBLISH_CONFIG)
  )
    fail("package.json may carry no publishConfig other than access public");
  for (const script of LIFECYCLE) {
    const value = pkg.scripts?.[script];
    if (value !== undefined && value !== RUN_BY_THE_BUILD_JOB[script])
      fail(
        `A folder publish runs the ${script} script and the pack mode does not. Run it in the build job and admit it in scripts/release-cli.mjs.`,
      );
  }
  if (
    process.env.GITHUB_REF_TYPE !== "tag" ||
    process.env.GITHUB_REF_NAME !== tag
  )
    fail(`This workflow runs only at tag ${tag}`);
  return { pkg, marker, head, tag };
}

export const tarballName = (version) => `glamsystems-glam-cli-${version}.tgz`;

export const sri = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// The regular files of a gzipped tarball by path. This reader is a stricter
// first layer: it refuses every header and record npm pack does not write.
// npm's own listing and manifest reader below are the authority.
export function tarballFiles(gzipped) {
  const tar = gunzipSync(gzipped);
  const files = new Map();
  let pax = null;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) continue;
    const text = (start, length) => {
      const field = header.subarray(start, start + length);
      const end = field.indexOf(0);
      return field.subarray(0, end === -1 ? length : end).toString("utf8");
    };
    const octal = (start, length) => {
      const digits = text(start, length).trim();
      assert.match(digits, /^[0-7]+$/, "The tarball has a malformed header");
      return Number.parseInt(digits, 8);
    };
    let sum = 0;
    for (let index = 0; index < 512; index++)
      sum += index >= 148 && index < 156 ? 32 : header[index];
    assert.equal(octal(148, 8), sum, "The tarball has a damaged header");
    // npm's tar module reads the prefix field only in this POSIX form.
    assert.equal(
      header.subarray(257, 263).toString("latin1"),
      "ustar\0",
      "The tarball has a header that is not POSIX ustar",
    );
    assert.equal(
      header.subarray(263, 265).toString("latin1"),
      "00",
      "The tarball has a ustar header whose version is not 00",
    );
    // npm's tar module reads a prefix of 155 bytes when byte 475 is not 0, and
    // of 130 bytes otherwise. npm pack writes zeros after the prefix.
    const field = header.subarray(345, header[475] === 0 ? 475 : 500);
    const prefixEnd = field.indexOf(0) === -1 ? field.length : field.indexOf(0);
    assert.ok(
      header.subarray(345 + prefixEnd).every((byte) => byte === 0),
      "The tarball has a ustar header with bytes after its prefix that npm pack does not write",
    );
    const type = String.fromCharCode(header[156]);
    const size = pax?.size ?? octal(124, 12);
    // npm's tar module puts the prefix field before a pax path as well.
    const prefix = field.subarray(0, prefixEnd).toString("utf8");
    const name = pax?.path ?? text(0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    const body = tar.subarray(offset, offset + size);
    assert.equal(body.length, size, "The tarball ends inside an entry");
    offset += Math.ceil(size / 512) * 512;
    if (type === "x") {
      assert.equal(pax, null, "The tarball has two extended headers in a row");
      pax = paxRecords(body);
      continue;
    }
    pax = null;
    assert.ok(
      type === "0" || type === "\0",
      `The tarball holds ${path}, which is not a regular file`,
    );
    const parts = path.split("/");
    assert.ok(
      parts.length > 1 &&
        parts[0] === "package" &&
        parts.every((part) => part && part !== "." && part !== ".."),
      `The tarball holds ${path}, which is outside package/`,
    );
    assert.ok(!files.has(path), `The tarball holds ${path} twice`);
    files.set(path, body);
  }
  assert.equal(pax, null, "The tarball ends with an extended header");
  return files;
}

// The path and size records of a pax extended header, whose lengths count
// bytes. npm's tar module drops a record whose length is not its decimal
// byte count, so this reader refuses one.
function paxRecords(body) {
  const records = {};
  for (let rest = body; rest.length > 0; ) {
    const space = rest.indexOf(0x20);
    const digits = rest.subarray(0, Math.max(space, 0)).toString("latin1");
    const length = /^[1-9][0-9]*$/.test(digits) ? Number(digits) : 0;
    const record = rest.subarray(space + 1, length);
    const equals = record.indexOf(0x3d);
    assert.ok(
      space > 0 &&
        length > space &&
        length <= rest.length &&
        equals > 0 &&
        rest[length - 1] === 0x0a &&
        rest.subarray(0, length - 1).indexOf(0x0a) === -1 &&
        Buffer.from(record.toString("utf8")).equals(record),
      "The tarball has a malformed extended header",
    );
    const key = record.subarray(0, equals).toString("utf8");
    const value = record
      .subarray(equals + 1, record.length - 1)
      .toString("utf8");
    // npm's tar module splits records at a newline and ends a value at a NUL.
    assert.ok(
      !/[\n\0]/.test(value),
      "The tarball has a malformed extended header",
    );
    if (key === "path") records.path = value;
    if (key === "size") {
      assert.match(
        value,
        /^\d+$/,
        "The tarball has a malformed extended header",
      );
      records.size = Number(value);
    }
    rest = rest.subarray(length);
  }
  return records;
}

// The package.json this reader finds must be this commit's with gitHead added.
export function assertTarballManifest(files, pkg, commit) {
  const packed = files.get("package/package.json");
  assert.ok(packed, "The tarball has no package/package.json");
  assert.ok(
    isDeepStrictEqual(JSON.parse(packed.toString("utf8")), {
      ...pkg,
      gitHead: commit,
    }),
    "The tarball's package.json is not this commit's package.json with gitHead added",
  );
}

// The npm that publishes. No job installs npm, so it is the one bundled with
// this Node, and the checks below load npm's own modules from it.
export const NPM_ROOT = resolve(
  dirname(process.execPath),
  "..",
  "lib",
  "node_modules",
  "npm",
);
const fromNpm = (name) => createRequire(join(NPM_ROOT, "package.json"))(name);
// Pack and publish run this npm as this Node, so they are the npm checked here.
export const NPM_CLI = join(NPM_ROOT, "bin", "npm-cli.js");

// The entries as npm's tar module lists them. Each is a regular file or a
// directory under package/, listed once, and the module warns of nothing.
export async function assertNpmEntries(gzipped) {
  const refusals = [];
  const seen = new Set();
  const parser = fromNpm("tar").t({
    strict: true,
    onwarn: (code, message) =>
      refusals.push(`npm reads a damaged tarball: ${code} ${message}`),
    onentry: (entry) => {
      const directory = entry.type === "Directory";
      const path = directory ? entry.path.replace(/\/$/, "") : entry.path;
      const parts = path.split("/");
      if (!directory && entry.type !== "File" && entry.type !== "OldFile")
        refusals.push(
          `npm reads ${path} as ${entry.type}, which is not a regular file or a directory`,
        );
      else if (
        !(
          parts.length > 1 &&
          parts[0] === "package" &&
          parts.every((part) => part && part !== "." && part !== "..")
        )
      )
        refusals.push(`npm reads ${path}, which is outside package/`);
      else if (seen.has(path)) refusals.push(`npm reads ${path} twice`);
      seen.add(path);
    },
  });
  await new Promise((done) => {
    parser.on("error", (error) => {
      refusals.push(`npm cannot read the tarball: ${error.message}`);
      done();
    });
    parser.on("end", done);
    parser.end(gzipped);
  });
  if (refusals.length) throw new Error(refusals.join("\n"));
}

// What npm sends of a manifest, without the readme and pacote's own records of
// the file. JSON drops the symbols that npm's reader adds.
const comparable = (manifest) => {
  const { readme, readmeFilename, _integrity, _resolved, _from, ...rest } =
    JSON.parse(JSON.stringify(manifest));
  return rest;
};

// The manifest npm publish reads, with the call publish.js makes, against this
// commit's package.json with gitHead added, both normalized by npm.
export async function assertNpmManifest(tarball, pkg, commit) {
  const scratch = await mkdtemp(join(tmpdir(), "glam-cli-manifest-"));
  try {
    const read = await fromNpm("pacote").manifest(`file:${tarball}`, {
      fullMetadata: true,
      fullReadJson: true,
      cache: join(scratch, "cache"),
    });
    // A directory with the package.json alone, so no other file adds a field.
    const alone = join(scratch, "expected");
    await mkdir(alone);
    await writeFile(
      join(alone, "package.json"),
      JSON.stringify({ ...pkg, gitHead: commit }),
    );
    const expected = await fromNpm("@npmcli/package-json").prepare(alone);
    assert.ok(
      isDeepStrictEqual(comparable(read), comparable(expected.content)),
      "npm reads a package.json from the tarball that is not this commit's package.json with gitHead added",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// This reader first, then npm's own tar module and manifest reader.
export async function assertPublishable(tarball, bytes, pkg, commit) {
  assertTarballManifest(tarballFiles(bytes), pkg, commit);
  await assertNpmEntries(bytes);
  await assertNpmManifest(tarball, pkg, commit);
}

// npm publish of a tarball runs no lifecycle script. npm drops each
// publishConfig key that is also a flag here. For a scoped package npm prefers
// the scope's registry over --registry, so both are flags.
export const publishArgs = (tarball) => [
  "publish",
  tarball,
  "--ignore-scripts",
  "--access",
  "public",
  "--provenance",
  "--tag",
  "latest",
  `--registry=${REGISTRY}`,
  `--@glamsystems:registry=${REGISTRY}/`,
];

function reportedIntegrity() {
  const integrity = process.env.RELEASE_INTEGRITY ?? "";
  if (!INTEGRITY.test(integrity))
    fail("RELEASE_INTEGRITY is not a sha512 integrity");
  return integrity;
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

// Starts the build and installs the packed tarball as a user would, and
// refuses a tarball whose user install loads other packages than this tree.
// The check runs package code, so its environment carries only what npm and
// node need: no GITHUB_OUTPUT and no other workflow file.
function checkBundle(tarball) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        ["PATH", "HOME", "TMPDIR"].includes(name) ||
        name.startsWith("npm_config_"),
    ),
  );
  const result = spawnSync(process.execPath, [BUNDLE_CHECK, tarball], {
    env,
    stdio: "inherit",
  });
  if (result.status !== 0)
    fail(
      `${basename(tarball)} failed the bundle check. This run published nothing.`,
    );
}

// The build job, after npm ci and npm run build. npm reads gitHead from the
// folder's git HEAD when it publishes a directory, and from package.json when
// it publishes a tarball.
async function pack() {
  const { pkg, head } = context();
  const destination = process.env.RELEASE_PACK_DIR ?? "";
  if (!isAbsolute(destination))
    fail("RELEASE_PACK_DIR must be an absolute path");
  if (!process.env.GITHUB_OUTPUT) fail("GITHUB_OUTPUT is required");
  mkdirSync(destination, { recursive: true });
  const original = readFileSync("package.json", "utf8");
  let packed;
  try {
    writeFileSync(
      "package.json",
      `${JSON.stringify({ ...pkg, gitHead: head }, null, 2)}\n`,
    );
    packed = JSON.parse(
      run(process.execPath, [
        NPM_CLI,
        "pack",
        "--ignore-scripts",
        "--json",
        `--pack-destination=${destination}`,
      ]),
    )[0];
  } finally {
    writeFileSync("package.json", original);
  }
  const name = tarballName(pkg.version);
  if (
    packed.name !== PACKAGE ||
    packed.version !== pkg.version ||
    packed.filename !== name
  )
    fail(`npm pack wrote ${packed.filename}, expected ${name}`);
  const bytes = readFileSync(join(destination, name));
  const integrity = sri(bytes);
  if (packed.integrity !== integrity)
    fail("npm pack reported an integrity that its tarball does not have");
  await assertPublishable(join(destination, name), bytes, pkg, head);
  writeFileSync(
    join(destination, "release-pack.json"),
    `${JSON.stringify(packed, null, 2)}\n`,
  );
  checkBundle(join(destination, name));
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `tarball=${name}\nintegrity=${integrity}\n`,
  );
  console.log(`Packed ${name} ${integrity}`);
}

// The tarball the build job packed, checked against what that job reported
// and against this checkout. It is read here and never unpacked.
async function checkedTarball(pkg, head) {
  const integrity = reportedIntegrity();
  if (!process.env.RELEASE_TARBALL) fail("RELEASE_TARBALL is required");
  const tarball = resolve(process.env.RELEASE_TARBALL);
  // Real paths, so a symbolic link in either path cannot hide the checkout.
  const inside = relative(realpathSync(process.cwd()), realpathSync(tarball));
  if (basename(tarball) !== tarballName(pkg.version))
    fail("RELEASE_TARBALL does not name this release's tarball");
  if (!(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)))
    fail("RELEASE_TARBALL must be outside the checkout");
  const bytes = readFileSync(tarball);
  if (sri(bytes) !== integrity)
    fail("The tarball differs from the one the build job reported");
  await assertPublishable(tarball, bytes, pkg, head);
  return { tarball, integrity };
}

// The publish job. It runs no dependency code and publishes only the checked
// tarball, from an empty directory, so npm finds no package files beside it.
async function publish() {
  const { pkg, head } = context();
  const { tarball, integrity } = await checkedTarball(pkg, head);
  const existing = await registry(pkg.version);
  if (existing) {
    if (existing.gitHead !== head)
      fail(
        `${PACKAGE}@${pkg.version} is already published from ${existing.gitHead}; this commit is ${head}`,
      );
    if (existing.dist?.integrity !== integrity)
      fail(
        `${PACKAGE}@${pkg.version} on npm differs from the tarball the build job packed`,
      );
    console.log(
      `${PACKAGE}@${pkg.version} already published from this commit; skipping publish`,
    );
    return;
  }
  const empty = mkdtempSync(join(tmpdir(), "glam-cli-publish-"));
  run(process.execPath, [NPM_CLI, ...publishArgs(tarball)], {
    cwd: empty,
    stdio: "inherit",
  });
}

// npm keeps processing a publish for some minutes before the version is
// visible, so verification polls the registry before it judges.
export async function waitForPackage({
  lookup,
  version,
  delay = sleep,
  attempts = 20,
}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const metadata = await lookup(version);
    if (metadata) return metadata;
    if (attempt < attempts) await delay(15_000);
  }
  throw new Error(`${PACKAGE}@${version} is not on npm`);
}

// The registry's record of this version, which must name this commit, carry
// the tarball the build job packed, and hold a signature and provenance.
async function published(pkg, head, integrity) {
  const metadata = await waitForPackage({
    lookup: registry,
    version: pkg.version,
  }).catch((error) => fail(error.message));
  if (
    metadata.gitHead !== head ||
    metadata.dist?.integrity !== integrity ||
    !metadata.dist?.signatures?.length ||
    !metadata.dist?.attestations?.url
  )
    fail("npm package identity/provenance does not match this release commit");
  return metadata;
}

// Installs the published version, again while npm reports ETARGET: the
// version endpoint can show a publish minutes before the package index that
// npm install reads. Any other failure ends at once.
export async function installPublished({
  install,
  version,
  delay = sleep,
  attempts = INSTALL_ATTEMPTS,
  interval = INSTALL_INTERVAL,
}) {
  for (let attempt = 1; ; attempt++) {
    const { status, stderr } = install();
    if (status === 0) return attempt;
    if (!/\bETARGET\b/.test(stderr ?? ""))
      throw new Error(
        `npm install ${PACKAGE}@${version} failed with an error other than ETARGET, so it is not retried. Read the npm output above.`,
      );
    if (attempt === attempts)
      throw new Error(
        `npm install still found no ${PACKAGE}@${version} after ${attempts} attempts over ${Math.round(((attempts - 1) * interval) / 60_000)} minutes, though the registry's version endpoint lists it. Run the verify job again once npm view ${PACKAGE}@${version} prints the version.`,
      );
    console.error(
      `npm install found no ${PACKAGE}@${version} yet (ETARGET). Attempt ${attempt} of ${attempts}, retrying in ${interval / 1000} seconds.`,
    );
    await delay(interval);
  }
}

// The verify job, with read access only: it installs and loads the package.
async function verify() {
  const { pkg, head } = context();
  const integrity = reportedIntegrity();
  await published(pkg, head, integrity);
  const sandbox = mkdtempSync(join(tmpdir(), "glam-cli-verify-"));
  writeFileSync(
    join(sandbox, "package.json"),
    JSON.stringify({ name: "verify", private: true }),
  );
  await installPublished({
    version: pkg.version,
    install: () => {
      const result = spawnSync(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--prefer-online",
          `${PACKAGE}@${pkg.version}`,
        ],
        {
          cwd: sandbox,
          encoding: "utf8",
          stdio: ["ignore", "inherit", "pipe"],
        },
      );
      process.stderr.write(result.stderr ?? "");
      return result;
    },
  }).catch((error) => fail(error.message));
  const lock = JSON.parse(
    readFileSync(join(sandbox, "package-lock.json"), "utf8"),
  );
  if (lock.packages?.[`node_modules/${PACKAGE}`]?.integrity !== integrity)
    fail("The installed tarball is not the one the build job packed");
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
  // The installed command, started as a user starts it, from a folder with no
  // cli/ subfolder. stderr may carry a warning, so only stdout is compared.
  const command = join(sandbox, "node_modules", ".bin", COMMAND);
  if (!existsSync(command))
    fail(
      `The installed package has no ${COMMAND} command in node_modules/.bin`,
    );
  const started = spawnSync(command, ["--version"], {
    cwd: sandbox,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (started.status !== 0)
    fail(
      `The installed ${COMMAND} --version exited ${started.status ?? started.error?.message}`,
    );
  if (started.stdout.trim() !== pkg.version)
    fail(
      `The installed ${COMMAND} --version printed ${JSON.stringify(started.stdout.trim())}, expected ${pkg.version}`,
    );
}

// The finish job. It checks the registry through fetch and runs no npm.
async function finish() {
  const { pkg, marker, head, tag } = context();
  await published(pkg, head, reportedIntegrity());
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const steps = { validate, pack, publish, verify, finish };
  const step = steps[process.argv[2]];
  if (!step)
    fail(
      "Usage: node scripts/release-cli.mjs validate | pack | publish | verify | finish",
    );
  await step();
}
