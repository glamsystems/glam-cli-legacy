import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { gzipSync } from "node:zlib";
import { COMMAND as CHECKED_COMMAND } from "../check-bundle.mjs";
import {
  COMMAND,
  INSTALL_ATTEMPTS,
  INSTALL_INTERVAL,
  NPM_CLI,
  NPM_ROOT,
  assertNpmEntries,
  assertNpmManifest,
  installPublished,
  publishArgs,
  sri,
  tarballFiles,
  tarballName,
  waitForPackage,
} from "../release-cli.mjs";

// Runs scripts/release-cli.mjs as publish.yml does, one mode per process, with
// git and npm replaced by recording fakes on PATH and fetch replaced by a
// preloaded stand-in for the npm registry and the GitHub API. npm pack runs the
// real npm, offline. The fakes print to the stdout they inherit, as npm
// publish and npm install do.
const SCRIPT = fileURLToPath(new URL("../release-cli.mjs", import.meta.url));
const PACKAGE = "@glamsystems/glam-cli";
const VERSION = "1.2.0";
const TAG = `v${VERSION}`;
const HEAD = "a".repeat(40);
const SOURCE = "b".repeat(40);
const REPOSITORY = "glamsystems/glam-cli-legacy";
const REAL_NPM = join(dirname(process.execPath), "npm");

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
  pack) exec "$REAL_NPM" "$@" ;;
  publish)
    printf '%s %s\\n' "$PWD" "$(ls -A)" >> "$FAKE_STATE/publish-directory"
    touch "$FAKE_STATE/published"; echo "+ $FAKE_PACKAGE@$FAKE_VERSION" ;;
  install)
    # The bundle check installs the packed tarball, which the real npm does offline.
    case "$*" in *.tgz) exec "$REAL_NPM" "$@" ;; esac
    echo attempt >> "$FAKE_STATE/install-attempts"
    if [ -n "$FAKE_INSTALL_ERROR" ]; then
      echo "npm error code $FAKE_INSTALL_ERROR" >&2; exit 1
    fi
    mkdir -p "node_modules/$FAKE_PACKAGE" node_modules/.bin
    printf '{"name":"%s","version":"%s"}\\n' "$FAKE_PACKAGE" "$FAKE_VERSION" \\
      > "node_modules/$FAKE_PACKAGE/package.json"
    printf '#!/usr/bin/env node\\nconsole.log(process.env.FAKE_INSTALLED_VERSION ?? process.env.FAKE_VERSION);\\n' \\
      > "node_modules/$FAKE_PACKAGE/main.js"
    chmod +x "node_modules/$FAKE_PACKAGE/main.js"
    if [ -z "$FAKE_NO_COMMAND" ]; then
      ln -s "../$FAKE_PACKAGE/main.js" node_modules/.bin/glam-cli
    fi
    printf '{"packages":{"node_modules/%s":{"integrity":"%s"}}}\\n' "$FAKE_PACKAGE" \\
      "\${FAKE_LOCK_INTEGRITY:-$RELEASE_INTEGRITY}" > package-lock.json
    echo "added 1 package" ;;
  audit) echo "1 package has a verified registry signature" ;;
  *) echo "unexpected npm $*" >&2; exit 2 ;;
esac
`;

const FAKE_FETCH = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const state = process.env.FAKE_STATE;
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
// npm run as this Node goes to the npm stand-in on PATH, and is recorded.
const forward = childProcess.execFileSync;
childProcess.execFileSync = (file, args = [], options) => {
  if (file === process.execPath && args[0]?.endsWith("/bin/npm-cli.js")) {
    appendFileSync(join(state, "npm-cli"), file + " " + args[0] + "\\n");
    return forward("npm", args.slice(1), options);
  }
  return forward(file, args, options);
};
syncBuiltinESMExports();
const recorded = JSON.parse(process.env.FAKE_METADATA);
const metadata = {
  ...recorded,
  gitHead: process.env.FAKE_REGISTRY_HEAD ?? recorded.gitHead,
  dist: {
    ...recorded.dist,
    integrity: process.env.FAKE_REGISTRY_INTEGRITY ?? process.env.RELEASE_INTEGRITY,
  },
};
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

// The package as the public mirror holds it after the sync and the merge.
// npm derives a missing description from the readme, so it has one.
const MANIFEST = {
  name: PACKAGE,
  version: VERSION,
  description: "GLAM CLI",
  main: "./main.js",
  bin: { "glam-cli": "./main.js" },
  repository: { type: "git", url: `https://github.com/${REPOSITORY}.git` },
  scripts: { build: "node scripts/build.mjs", prepack: "npm run build" },
  files: ["README.md", "LICENSE", "main.js", "templates/**/*.json"],
  publishConfig: { access: "public" },
};

function releaseScenario({ published = false, manifest = MANIFEST } = {}) {
  const root = mkdtempSync(join(tmpdir(), "glam-cli-release-test-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const work = join(root, "work");
  for (const directory of [bin, state, work, join(work, "templates")])
    mkdirSync(directory);
  for (const loader of ["ws", "node-fetch"])
    mkdirSync(join(work, "node_modules", loader), { recursive: true });
  writeFileSync(join(bin, "git"), FAKE_GIT);
  // The bundle check passes npm only PATH, HOME, TMPDIR and npm's own
  // settings, so the fake carries its state folder and the real npm itself.
  writeFileSync(
    join(bin, "npm"),
    FAKE_NPM.replace(
      "#!/bin/sh\n",
      `#!/bin/sh\n: "\${FAKE_STATE:=${state}}" "\${REAL_NPM:=${REAL_NPM}}"\n`,
    ),
  );
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  writeFileSync(join(root, "fetch.mjs"), FAKE_FETCH);
  for (const [path, content] of Object.entries({
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    // The bundle check starts it and leaves a mark if a workflow file reaches
    // it. It reads package.json through fs, since the check refuses a path
    // given to require.
    "main.js": `#!/usr/bin/env node
if (process.env.GITHUB_OUTPUT) require("node:fs").appendFileSync(process.env.GITHUB_OUTPUT, "leaked=1\\n");
if (process.argv[2] === "--version") console.log(JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "package.json"), "utf8")).version);
`,
    // The bundle check reads the loaders of its guarded optional loads.
    "node_modules/ws/package.json": JSON.stringify({
      name: "ws",
      version: "7.5.11",
      peerDependenciesMeta: { "utf-8-validate": { optional: true } },
    }),
    "node_modules/node-fetch/package.json": JSON.stringify({
      name: "node-fetch",
      version: "2.7.0",
      peerDependenciesMeta: { encoding: { optional: true } },
    }),
    "README.md": "# CLI\n",
    LICENSE: "Apache-2.0\n",
    "templates/vault.json": "{}\n",
    ".cli-release.json": JSON.stringify({
      schemaVersion: 1,
      package: PACKAGE,
      version: VERSION,
      source: { repository: "glamsystems/glam", commit: SOURCE },
      notes: "## CLI 1.2.0\n\nApproved changes.",
    }),
  }))
    writeFileSync(join(work, path), content);
  if (published) writeFileSync(join(state, "published"), "");
  const env = {
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: root,
    TMPDIR: root,
    REAL_NPM,
    npm_config_cache: join(root, ".npm-cache"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    FAKE_STATE: state,
    FAKE_HEAD: HEAD,
    FAKE_PACKAGE: PACKAGE,
    FAKE_VERSION: VERSION,
    FAKE_METADATA: JSON.stringify({
      name: PACKAGE,
      version: VERSION,
      gitHead: HEAD,
      dist: {
        signatures: [{ keyid: "test-registry-key" }],
        attestations: { url: "https://registry.npmjs.org/-/npm/v1/test" },
      },
    }),
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: TAG,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_TOKEN: "test-token",
    GITHUB_OUTPUT: join(root, "output"),
    RELEASE_PACK_DIR: join(root, "pack"),
  };
  const attempt = (name, extra = {}) =>
    spawnSync(
      process.execPath,
      ["--import", join(root, "fetch.mjs"), SCRIPT, name],
      { cwd: work, env: { ...env, ...extra }, encoding: "utf8" },
    );
  const step = (name, extra) => {
    const result = attempt(name, extra);
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
  // The pack mode's outputs, as the publish job receives them.
  const packed = () => {
    const outputs = Object.fromEntries(
      readFileSync(env.GITHUB_OUTPUT, "utf8")
        .trim()
        .split("\n")
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    return {
      RELEASE_TARBALL: join(env.RELEASE_PACK_DIR, outputs.tarball),
      RELEASE_INTEGRITY: outputs.integrity,
    };
  };
  return {
    root,
    work,
    step,
    attempt,
    packed,
    commands: () => lines("commands").filter((line) => line.startsWith("npm")),
    requests: () => lines("requests"),
    publishDirectory: () => lines("publish-directory"),
    npmCli: () => lines("npm-cli"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const packCommand = (run) =>
  `npm pack --ignore-scripts --json --pack-destination=${join(run.root, "pack")}`;
// The pack mode's npm commands: the pack and the bundle check's user install.
const packCommands = (run) => [
  packCommand(run),
  `npm install --ignore-scripts --no-audit --no-fund ${join(run.root, "pack", tarballName(VERSION))}`,
];
const INSTALL = `npm install --ignore-scripts --no-audit --no-fund --prefer-online ${PACKAGE}@${VERSION}`;

test("a first publication packs, publishes the tarball, verifies the installation and completes the GitHub Release", (t) => {
  const run = releaseScenario();
  t.after(run.cleanup);
  run.step("validate");
  assert.match(
    run.step("pack"),
    /Packed glamsystems-glam-cli-1\.2\.0\.tgz sha512-/,
  );
  const packed = run.packed();
  // npm publish prints to the job log; its output is not captured.
  assert.match(
    run.step("publish", packed),
    new RegExp(`\\+ ${PACKAGE}@${VERSION}`),
  );
  const [directory] = run.publishDirectory();
  // An empty directory outside the checkout.
  assert.match(directory, /\/glam-cli-publish-[^\s/]+$/);
  // Pack and publish ran the npm whose modules the checks load.
  assert.deepEqual(run.npmCli(), [
    `${process.execPath} ${NPM_CLI}`,
    `${process.execPath} ${NPM_CLI}`,
  ]);
  run.step("verify", packed);
  const beforeFinish = run.commands();
  assert.match(
    run.step("finish", packed),
    new RegExp(`GitHub Release ${TAG} complete`),
  );
  assert.deepEqual(run.commands(), beforeFinish);
  assert.deepEqual(run.commands(), [
    ...packCommands(run),
    `npm ${publishArgs(packed.RELEASE_TARBALL).join(" ")}`,
    INSTALL,
    "npm audit signatures",
  ]);
  assert.deepEqual(
    run.requests().filter((line) => line.startsWith("POST")),
    [`POST /repos/${REPOSITORY}/releases`],
  );
});

test("the pack mode writes gitHead into the tarball and leaves the checkout's package.json as committed", (t) => {
  const run = releaseScenario();
  t.after(run.cleanup);
  run.step("pack");
  const { RELEASE_TARBALL, RELEASE_INTEGRITY } = run.packed();
  const bytes = readFileSync(RELEASE_TARBALL);
  assert.equal(RELEASE_INTEGRITY, sri(bytes));
  const files = tarballFiles(bytes);
  assert.deepEqual(JSON.parse(files.get("package/package.json")), {
    ...MANIFEST,
    gitHead: HEAD,
  });
  // The tarball holds what the folder publish packed: the files list and package.json.
  assert.deepEqual([...files.keys()].sort(), [
    "package/LICENSE",
    "package/README.md",
    "package/main.js",
    "package/package.json",
    "package/templates/vault.json",
  ]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(run.work, "package.json"), "utf8")),
    MANIFEST,
  );
});

test("a retry after the publication landed skips publishing and completes verification", (t) => {
  const run = releaseScenario({ published: true });
  t.after(run.cleanup);
  run.step("pack");
  const packed = run.packed();
  assert.match(
    run.step("publish", packed),
    /already published from this commit/,
  );
  run.step("verify", packed);
  run.step("finish", packed);
  assert.deepEqual(run.commands(), [
    ...packCommands(run),
    INSTALL,
    "npm audit signatures",
  ]);
});

for (const [description, registry, message] of [
  [
    "another tarball",
    { FAKE_REGISTRY_INTEGRITY: sri(Buffer.from("another tarball")) },
    /on npm differs from the tarball the build job packed/,
  ],
  [
    "another commit",
    { FAKE_REGISTRY_HEAD: "c".repeat(40) },
    /is already published from c{40}; this commit is a{40}/,
  ],
])
  test(`a retry refuses an existing version from ${description} and publishes nothing`, (t) => {
    const run = releaseScenario({ published: true });
    t.after(run.cleanup);
    run.step("pack");
    const result = run.attempt("publish", { ...run.packed(), ...registry });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
    assert.deepEqual(run.commands(), packCommands(run));
  });

// A POSIX ustar entry, or a pax header when type is "x". magic is the eight
// bytes of magic and version, prefix the ustar prefix field and linkpath the
// link target.
function tarEntry(
  path,
  content,
  type = "0",
  { magic = "ustar\u000000", prefix = "", linkpath = "" } = {},
) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write(linkpath, 157);
  header.write(magic, 257, "latin1");
  header.write(prefix, 345);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function paxHeader(key, value) {
  const tail = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(tail);
  length += String(length + String(length).length).length;
  return tarEntry("PaxHeader", `${length}${tail}`, "x");
}

const gzippedTar = (...entries) =>
  gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

// The entry with `text` written at `offset` of its header and the checksum
// recomputed.
function patchedHeader(entry, offset, text) {
  const patched = Buffer.from(entry);
  patched.write(text, offset, "latin1");
  patched.write("        ", 148);
  const sum = patched.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  patched.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return patched;
}

// A 100 byte pax path record whose length field is `digits`.
const paxLength = (digits) => {
  const head = `${digits} path=package/`;
  return tarEntry(
    "PaxHeader",
    `${head}${"x".repeat(100 - head.length - 1)}\n`,
    "x",
  );
};

for (const digits of ["1e2", "0x64", "0100", "99", "101"])
  test(`this reader refuses a pax record whose length field is ${digits}, which npm's tar module drops`, () => {
    assert.throws(
      () =>
        tarballFiles(gzippedTar(paxLength(digits), tarEntry("package/a", ""))),
      /The tarball has a malformed extended header/,
    );
  });

test("this reader takes a pax record whose length field is its decimal byte count", () => {
  const files = tarballFiles(
    gzippedTar(paxLength("100"), tarEntry("package/a", "")),
  );
  assert.deepEqual([...files.keys()], [`package/${"x".repeat(82)}`]);
});

// A pax header of one record whose key and value are bytes.
function paxBytes(key, value) {
  const tail = Buffer.concat([
    Buffer.from(" "),
    Buffer.from(key),
    Buffer.from("="),
    Buffer.from(value),
    Buffer.from("\n"),
  ]);
  let length = tail.length;
  length += String(length + String(length).length).length;
  return tarEntry(
    "PaxHeader",
    Buffer.concat([Buffer.from(String(length)), tail]),
    "x",
  );
}

for (const [description, header] of [
  [
    "a path value that is not valid UTF-8",
    paxBytes("path", Buffer.from([...Buffer.from("package/b"), 0xff])),
  ],
  ["a newline inside its key", paxBytes("pa\nth", "package/b")],
])
  test(`this reader refuses a pax record with ${description}`, () => {
    assert.throws(
      () => tarballFiles(gzippedTar(header, tarEntry("package/a", ""))),
      /The tarball has a malformed extended header/,
    );
  });

for (const [description, offset, text] of [
  ["a byte 475 that is not 0 after a short prefix", 475, "a"],
  ["an access time after a prefix of 130 bytes or fewer", 476, "00000000001"],
  ["a byte after the prefix field", 500, "a"],
])
  test(`this reader refuses a ustar header with ${description}, which npm pack does not write`, () => {
    const entry = patchedHeader(
      tarEntry("a.json", "{}", "0", { prefix: "package" }),
      offset,
      text,
    );
    assert.throws(
      () => tarballFiles(gzippedTar(entry)),
      /The tarball has a ustar header with bytes after its prefix that npm pack does not write/,
    );
  });

test("this reader reads a prefix of 155 bytes when byte 475 is not 0, as npm's tar module does", async () => {
  const prefix = `package/${"d".repeat(140)}`;
  const entry = tarEntry("a.json", "{}", "0", { prefix });
  assert.notEqual(entry[475], 0);
  const files = tarballFiles(gzippedTar(entry));
  assert.deepEqual([...files.keys()], [`${prefix}/a.json`]);
  await assertNpmEntries(gzippedTar(entry));
});

const PACKED = JSON.stringify({ ...MANIFEST, gitHead: HEAD });
// A change the build job could make to the published manifest.
const EVIL = JSON.stringify({
  ...MANIFEST,
  gitHead: HEAD,
  publishConfig: { registry: "https://registry.example.invalid/" },
});

// The packed package.json, then the given entries.
const afterPackageJson = (...entries) =>
  gzippedTar(tarEntry("package/package.json", PACKED), ...entries);

// A GNU header whose bytes at the ustar prefix field read package/gnu. npm's
// tar module applies no prefix to it and reads package/package.json.
const GNU_PACKAGE_JSON = tarEntry("package/package.json", EVIL, "0", {
  magic: "ustar  \0",
  prefix: "package/gnu",
});

// Publishes a crafted tarball under the release's file name with its real
// integrity, so a refusal comes from the rule under test alone.
function publishCrafted(t, manifest, extra = {}) {
  return publishBytes(
    t,
    gzippedTar(
      tarEntry("package/package.json", JSON.stringify(manifest)),
      tarEntry("package/main.js", ""),
    ),
    extra,
  );
}

function publishBytes(t, bytes, extra = {}) {
  const run = releaseScenario();
  t.after(run.cleanup);
  mkdirSync(join(run.root, "crafted"));
  const tarball = join(run.root, "crafted", tarballName(VERSION));
  writeFileSync(tarball, bytes);
  const result = run.attempt("publish", {
    RELEASE_TARBALL: tarball,
    RELEASE_INTEGRITY: sri(readFileSync(tarball)),
    ...extra,
  });
  // Every refusal comes before the first registry request.
  assert.deepEqual(run.commands(), []);
  assert.deepEqual(run.requests(), []);
  return result;
}

test("a crafted tarball with exactly the packed package.json passes every check before the registry", (t) => {
  const run = releaseScenario();
  t.after(run.cleanup);
  const tarball = join(run.root, tarballName(VERSION));
  writeFileSync(
    tarball,
    gzipSync(
      Buffer.concat([
        tarEntry(
          "package/package.json",
          JSON.stringify({ ...MANIFEST, gitHead: HEAD }),
        ),
        Buffer.alloc(1024),
      ]),
    ),
  );
  run.step("publish", {
    RELEASE_TARBALL: tarball,
    RELEASE_INTEGRITY: sri(readFileSync(tarball)),
  });
  assert.deepEqual(run.commands(), [`npm ${publishArgs(tarball).join(" ")}`]);
});

for (const [description, manifest] of [
  ["a changed field", { ...MANIFEST, gitHead: HEAD, description: "changed" }],
  [
    "a publishConfig the build job changed",
    {
      ...MANIFEST,
      gitHead: HEAD,
      publishConfig: {
        access: "public",
        registry: "https://registry.example.invalid/",
      },
    },
  ],
  ["another name", { ...MANIFEST, gitHead: HEAD, name: "@glamsystems/other" }],
  ["another version", { ...MANIFEST, gitHead: HEAD, version: "1.2.1" }],
  ["another gitHead", { ...MANIFEST, gitHead: "c".repeat(40) }],
  ["no gitHead", MANIFEST],
  [
    "another repository",
    {
      ...MANIFEST,
      gitHead: HEAD,
      repository: { url: "https://github.com/fork/glam-cli.git" },
    },
  ],
])
  test(`the publish mode refuses a tarball whose package.json has ${description}`, (t) => {
    const result = publishCrafted(t, manifest);
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stderr,
      /The tarball's package\.json is not this commit's package\.json with gitHead added/,
    );
  });

for (const [description, bytes, message] of [
  [
    "a GNU header after the POSIX package.json",
    afterPackageJson(GNU_PACKAGE_JSON),
    /The tarball has a header that is not POSIX ustar$/m,
  ],
  [
    "a ustar version other than 00",
    afterPackageJson(
      tarEntry("package/package.json", EVIL, "0", {
        magic: "ustar\u000001",
        prefix: "package/old",
      }),
    ),
    /The tarball has a ustar header whose version is not 00/,
  ],
  [
    "a pax path that the prefix field extends to package/package.json",
    afterPackageJson(
      paxHeader("path", "package.json"),
      tarEntry("package/other.json", EVIL, "0", { prefix: "package" }),
    ),
    /The tarball holds package\/package\.json twice/,
  ],
  [
    "a pax path with a newline, which npm's tar module skips",
    afterPackageJson(
      paxHeader("path", "package/other\n.json"),
      tarEntry("package/package.json", EVIL),
    ),
    /The tarball has a malformed extended header/,
  ],
  [
    "a binding.gyp, for which npm adds an install script",
    afterPackageJson(tarEntry("package/binding.gyp", "{}")),
    /npm reads a package\.json from the tarball that is not this commit's package\.json with gitHead added/,
  ],
])
  test(`the publish mode refuses a tarball with ${description}`, (t) => {
    const result = publishBytes(t, bytes);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
  });

test("the publish arguments name the registry for the package's scope too", () => {
  assert.deepEqual(publishArgs("x.tgz"), [
    "publish",
    "x.tgz",
    "--ignore-scripts",
    "--access",
    "public",
    "--provenance",
    "--tag",
    "latest",
    "--registry=https://registry.npmjs.org",
    "--@glamsystems:registry=https://registry.npmjs.org/",
  ]);
});

test("the checks load npm's modules from the npm bundled with this Node, which pack and publish run and which is the npm on PATH", () => {
  const npm = JSON.parse(readFileSync(join(NPM_ROOT, "package.json"), "utf8"));
  assert.equal(npm.name, "npm");
  assert.equal(
    execFileSync(process.execPath, [NPM_CLI, "--version"], {
      encoding: "utf8",
    }).trim(),
    npm.version,
  );
  assert.equal(
    execFileSync(REAL_NPM, ["--version"], { encoding: "utf8" }).trim(),
    npm.version,
  );
});

test("npm's tar module passes a packed tarball with a directory entry", async () => {
  await assertNpmEntries(afterPackageJson(tarEntry("package/lib/", "", "5")));
});

const damaged = tarEntry("package/main.js", "");
damaged[0] ^= 1;
for (const [description, bytes, message] of [
  [
    "a GNU header that it reads as a second package.json",
    afterPackageJson(GNU_PACKAGE_JSON),
    /: npm reads package\/package\.json twice$/,
  ],
  [
    "a symbolic link",
    afterPackageJson(
      tarEntry("package/link", "", "2", { linkpath: "package.json" }),
    ),
    /: npm reads package\/link as SymbolicLink, which is not a regular file or a directory$/,
  ],
  [
    "an entry outside package/",
    afterPackageJson(tarEntry("other/package.json", "{}")),
    /: npm reads other\/package\.json, which is outside package\/$/,
  ],
  [
    "a damaged checksum",
    afterPackageJson(damaged),
    /: npm (reads a damaged tarball|cannot read the tarball): /,
  ],
])
  test(`npm's tar module refuses ${description}`, async () => {
    await assert.rejects(assertNpmEntries(bytes), message);
  });

test("npm's manifest reader takes the package.json that a GNU header carries", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "glam-cli-manifest-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const good = join(directory, "good.tgz");
  writeFileSync(good, afterPackageJson());
  await assertNpmManifest(good, MANIFEST, HEAD);
  const gnu = join(directory, "gnu.tgz");
  writeFileSync(gnu, afterPackageJson(GNU_PACKAGE_JSON));
  await assert.rejects(
    assertNpmManifest(gnu, MANIFEST, HEAD),
    /npm reads a package\.json from the tarball that is not this commit's package\.json with gitHead added/,
  );
});

for (const [description, integrity, message] of [
  [
    "an integrity that differs from the tarball's",
    sri(Buffer.from("another tarball")),
    /The tarball differs from the one the build job reported/,
  ],
  [
    "a malformed integrity",
    "sha512-abc",
    /RELEASE_INTEGRITY is not a sha512 integrity/,
  ],
])
  test(`the publish mode refuses ${description}`, (t) => {
    const result = publishCrafted(
      t,
      { ...MANIFEST, gitHead: HEAD },
      { RELEASE_INTEGRITY: integrity },
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
  });

for (const [script, value] of [
  ["prepare", "node scripts/build.mjs"],
  ["prepublishOnly", "npm test"],
  ["postpack", "node scripts/clean.mjs"],
  ["prepack", "node scripts/build.mjs --other"],
])
  test(`every mode refuses a ${script} script that a folder publish runs and the pack does not`, (t) => {
    const run = releaseScenario({
      manifest: {
        ...MANIFEST,
        scripts: { ...MANIFEST.scripts, [script]: value },
      },
    });
    t.after(run.cleanup);
    for (const mode of ["validate", "pack"]) {
      const result = run.attempt(mode);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        new RegExp(
          `A folder publish runs the ${script} script and the pack mode does not`,
        ),
      );
    }
    assert.deepEqual(run.commands(), []);
  });

test("the verify mode refuses an installed tarball other than the one the build job packed", (t) => {
  const run = releaseScenario({ published: true });
  t.after(run.cleanup);
  run.step("pack");
  const result = run.attempt("verify", {
    ...run.packed(),
    FAKE_LOCK_INTEGRITY: sri(Buffer.from("another tarball")),
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /The installed tarball is not the one the build job packed/,
  );
  assert.deepEqual(run.commands(), [...packCommands(run), INSTALL]);
});

test("the finish mode refuses a registry version without provenance before any GitHub request", (t) => {
  const run = releaseScenario({ published: true });
  t.after(run.cleanup);
  run.step("pack");
  const result = run.attempt("finish", {
    ...run.packed(),
    FAKE_METADATA: JSON.stringify({
      name: PACKAGE,
      version: VERSION,
      gitHead: HEAD,
      dist: { signatures: [{ keyid: "test-registry-key" }] },
    }),
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /identity\/provenance does not match/);
  assert.ok(!run.requests().some((line) => line.includes("/releases")));
});

for (const [description, publishConfig] of [
  [
    "a scoped registry",
    { "@glamsystems:registry": "https://registry.example.invalid/" },
  ],
  ["access public and another key", { access: "public", tag: "next" }],
  ["another access", { access: "restricted" }],
])
  test(`every mode refuses a publishConfig with ${description}`, (t) => {
    const run = releaseScenario({ manifest: { ...MANIFEST, publishConfig } });
    t.after(run.cleanup);
    for (const mode of ["validate", "pack"]) {
      const result = run.attempt(mode);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /package\.json may carry no publishConfig other than access public/,
      );
    }
    assert.deepEqual(run.commands(), []);
  });

test("every mode refuses a package.json that already carries gitHead", (t) => {
  const run = releaseScenario({ manifest: { ...MANIFEST, gitHead: HEAD } });
  t.after(run.cleanup);
  for (const mode of ["validate", "pack"]) {
    const result = run.attempt(mode);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /package\.json must not carry gitHead/);
  }
  assert.deepEqual(run.commands(), []);
});

test("the verify mode refuses a registry version whose tarball is not the packed one", (t) => {
  const run = releaseScenario({ published: true });
  t.after(run.cleanup);
  run.step("pack");
  const result = run.attempt("verify", {
    ...run.packed(),
    FAKE_REGISTRY_INTEGRITY: sri(Buffer.from("another tarball")),
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /identity\/provenance does not match/);
  assert.deepEqual(run.commands(), packCommands(run));
});

test("verification waits until the published version becomes visible", async () => {
  const metadata = { version: VERSION };
  const answers = [null, null, metadata];
  let delays = 0;
  const found = await waitForPackage({
    lookup: async () => answers.shift(),
    version: VERSION,
    delay: async (ms) => {
      assert.equal(ms, 15_000);
      delays++;
    },
  });
  assert.equal(found, metadata);
  assert.equal(delays, 2);
});

test("verification fails with the not on npm message once the attempts are exhausted", async () => {
  let lookups = 0;
  await assert.rejects(
    waitForPackage({
      lookup: async () => {
        lookups++;
        return null;
      },
      version: VERSION,
      delay: async () => {},
      attempts: 3,
    }),
    new RegExp(`${PACKAGE}@${VERSION} is not on npm`),
  );
  assert.equal(lookups, 3);
});

test("the pack mode runs the bundle check on the tarball it packs and reports nothing when it fails", (t) => {
  const run = releaseScenario();
  t.after(run.cleanup);
  writeFileSync(
    join(run.work, "main.js"),
    '#!/usr/bin/env node\nconsole.log("1.1.9");\n',
  );
  const result = run.attempt("pack");
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /node main\.js --version printed "1\.1\.9" on stdout, not the version 1\.2\.0/,
  );
  assert.match(
    result.stderr,
    /glamsystems-glam-cli-1\.2\.0\.tgz failed the bundle check\. This run published nothing\./,
  );
  assert.ok(!existsSync(join(run.root, "output")), "pack reported a tarball");
});

test("the bundle check receives no workflow file, so the package code it starts writes no output", (t) => {
  const run = releaseScenario();
  t.after(run.cleanup);
  run.step("pack");
  const outputs = readFileSync(join(run.root, "output"), "utf8");
  assert.doesNotMatch(outputs, /leaked/);
  assert.match(
    outputs,
    /^tarball=glamsystems-glam-cli-1\.2\.0\.tgz\nintegrity=sha512-/,
  );
});

test("the verify mode starts the installed binary and requires the version on stdout", (t) => {
  const run = releaseScenario({ published: true });
  t.after(run.cleanup);
  run.step("pack");
  const result = run.attempt("verify", {
    ...run.packed(),
    FAKE_INSTALLED_VERSION: "1.1.9",
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /The installed glam-cli --version printed "1\.1\.9", expected 1\.2\.0/,
  );
});

test("the verify mode refuses an installed package with no glam-cli command", (t) => {
  const run = releaseScenario({ published: true });
  t.after(run.cleanup);
  run.step("pack");
  const result = run.attempt("verify", {
    ...run.packed(),
    FAKE_NO_COMMAND: "1",
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /^The installed package has no glam-cli command in node_modules\/\.bin$/m,
  );
});

test("the publisher starts the command the bundle check requires", () => {
  assert.equal(COMMAND, "glam-cli");
  assert.equal(COMMAND, CHECKED_COMMAND);
});

test("the verify mode fails at once on an install error other than ETARGET", (t) => {
  const run = releaseScenario({ published: true });
  t.after(run.cleanup);
  run.step("pack");
  const result = run.attempt("verify", {
    ...run.packed(),
    FAKE_INSTALL_ERROR: "E404",
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /failed with an error other than ETARGET, so it is not retried/,
  );
  assert.equal(
    readFileSync(join(run.root, "state", "install-attempts"), "utf8"),
    "attempt\n",
  );
});

test("the verify install is retried while npm reports ETARGET", async () => {
  const answers = [
    {
      status: 1,
      stderr:
        "npm error code ETARGET\nnpm error notarget No matching version found",
    },
    { status: 1, stderr: "npm error code ETARGET" },
    { status: 0, stderr: "" },
  ];
  const delays = [];
  const attempts = await installPublished({
    install: () => answers.shift(),
    version: VERSION,
    delay: async (ms) => delays.push(ms),
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [INSTALL_INTERVAL, INSTALL_INTERVAL]);
});

test("the verify install stops with a clear message once the ETARGET attempts are exhausted", async () => {
  let installs = 0;
  await assert.rejects(
    installPublished({
      install: () => {
        installs++;
        return { status: 1, stderr: "npm error code ETARGET" };
      },
      version: VERSION,
      delay: async () => {},
    }),
    new RegExp(
      `npm install still found no ${PACKAGE}@${VERSION} after ${INSTALL_ATTEMPTS} attempts over 5 minutes`,
    ),
  );
  assert.equal(installs, INSTALL_ATTEMPTS);
});

test("the verify install fails at once on an error other than ETARGET", async () => {
  let installs = 0;
  await assert.rejects(
    installPublished({
      install: () => {
        installs++;
        return { status: 1, stderr: "npm error code E404" };
      },
      version: VERSION,
      delay: async () => assert.fail("an E404 must not wait"),
    }),
    /failed with an error other than ETARGET/,
  );
  assert.equal(installs, 1);
});
