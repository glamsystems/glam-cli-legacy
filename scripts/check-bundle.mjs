// Checks that the built CLI starts and that a user who installs the packed
// package loads the same packages as this tree.
//
//   node scripts/check-bundle.mjs [tarball]
//
// Run it from the package root after npm ci --ignore-scripts and npm run build.
// Without an argument it packs the package itself, into a temporary folder
// outside the tree. The publisher passes the tarball it is about to publish.
// The check applies the bin rule to the package.json in that tarball too, and
// takes the other files in it to be this tree's.
//
// It refuses unless all of these hold:
// 1. package.json's bin is the one command glam-cli, started from main.js or
//    ./main.js. main.js starts with the node shebang, and node main.js
//    --version exits 0 and prints exactly the version in package.json on
//    stdout.
// 2. main.js is searched as text, not as syntax. The search sees each place
//    where the word require or import, with any text before it, is followed
//    by optional space, an optional ?. and an opening parenthesis. Text in a
//    string or a comment counts like code. Each place is one of three kinds.
//    A literal is a place followed by optional space, a quote, a module name,
//    the same quote, optional space and a closing parenthesis. A module name
//    is one or more ASCII letters, digits and the characters @ / . _ : -, so
//    it holds no parenthesis and no place stands inside a literal. Another
//    string is a place followed by optional space and a quote that does not
//    start a literal, and it is refused for both words. Every other place is
//    computed. A computed require( is refused, and a computed import( passes,
//    since the bundle has one.
//    A literal passes when it names a Node builtin, a package declared in
//    dependencies or optionalDependencies, or one of the guarded optional
//    loads below. It is refused when it is a path or a URL, since the
//    published package holds main.js and no such file. It is refused when a
//    segment between its slashes is only dots, or is node_modules in any case
//    with or without dots after it, since such a segment can leave the
//    package the literal names and load a package that package.json does not
//    declare. A plain subpath still counts as its package. It is refused when
//    it names any other package.
// 3. The packed package, installed into a fresh project with --ignore-scripts,
//    gives the command glam-cli in node_modules/.bin. The command starts from
//    another folder and prints the version. Each runtime module resolves from
//    the installed package to the same package name and version as from this
//    tree, or is absent in both. The runtime modules are the declared packages
//    from the search and every key of optionalDependencies.
//
// The limit: the search sees only those places. These are examples, not a full
// list. It does not see require or import held in another name or called
// through call, apply or bind, a module loaded through createRequire, what an
// import( that is not followed by a quote loads, or a call written with an
// escape in its name or a comment before its parenthesis. The optional
// dependencies are added to the comparison because the build loads them
// through a createRequire wrapper.
//
// It uses Node builtins only and writes nothing inside the tree.
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Bare specifiers that the bundle loads only inside try/catch, so the CLI
// works without them. Each must stay an optional peer of the package that
// loads it, as installed in node_modules, or the check refuses the entry.
export const GUARDED_OPTIONAL_LOADS = Object.freeze([
  Object.freeze({
    module: "utf-8-validate",
    loadedBy: "ws",
    reason:
      "ws loads it inside try/catch to validate UTF-8 faster and validates in JavaScript without it",
  }),
  Object.freeze({
    module: "encoding",
    loadedBy: "node-fetch",
    reason:
      "node-fetch loads it inside try/catch to convert response charsets and works without it",
  }),
]);

const SHEBANG = /^#!\/usr\/bin\/env node\r?\n/;
const START_TIMEOUT = 120_000;

// The one command the published package gives a user, and the two spellings
// of the file it starts.
export const COMMAND = "glam-cli";
const ENTRIES = new Set(["main.js", "./main.js"]);

/**
 * The fault of a manifest's bin, which must be the one command glam-cli,
 * started from main.js. Any other shape is refused, a string bin included.
 */
export function binFindings(pkg, where = "package.json") {
  const { bin } = pkg;
  const names =
    bin !== null && typeof bin === "object" && !Array.isArray(bin)
      ? Object.keys(bin)
      : [];
  if (names.length === 1 && names[0] === COMMAND && ENTRIES.has(bin[COMMAND]))
    return [];
  return [
    `The bin in ${where} is ${JSON.stringify(bin) ?? "missing"}. It must give one command, ${COMMAND}, started from main.js, or a user's install has no checked ${COMMAND} to start. The sync keeps the mirror's own bin, which must be { "${COMMAND}": "./main.js" }.`,
  ];
}

// The word require or import with any text before it, optional space, an
// optional ?. and a parenthesis, then the argument when it is a literal:
// optional space, a quote, a module name, the same quote, optional space and a
// parenthesis.
const LOAD =
  /(require|import)\s*(?:\?\.\s*)?\(\s*(?:(["'`])([A-Za-z0-9@/._:-]+)\2\s*\))?/gu;
const QUOTES = new Set(['"', "'", "`"]);

/**
 * The require and import calls in the text of a script, strings and comments
 * included, in three kinds. A literal has the word, the specifier and the
 * offset. Another string, an argument that starts with a quote but is not a
 * literal, and a computed argument each have the word and the offset.
 */
export function scanLoads(source) {
  const literals = [];
  const strings = [];
  const computed = [];
  for (const match of source.matchAll(LOAD)) {
    const [text, word, , specifier] = match;
    const offset = match.index;
    if (specifier !== undefined) literals.push({ word, specifier, offset });
    else if (QUOTES.has(source[offset + text.length]))
      strings.push({ word, offset });
    else computed.push({ word, offset });
  }
  return { literals, strings, computed };
}

const PATH = /^(\.|\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/;

/**
 * Whether a specifier has a segment between its slashes that is only dots, or
 * that is node_modules in any case with or without dots after it. A file
 * system that ignores case opens Node_Modules as node_modules.
 */
export function leavesPackage(specifier) {
  return specifier.split("/").some((part) => {
    const name = part.replace(/\.+$/u, "").toLowerCase();
    return (part !== "" && name === "") || name === "node_modules";
  });
}

/**
 * The package a bare specifier names, or null for a path, a URL or a
 * specifier that leaves the package it names.
 */
export function packageOf(specifier) {
  if (PATH.test(specifier) || leavesPackage(specifier)) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// The name and version of the package a bare name resolves to from a file,
// following Node's lookup through each node_modules above it, or null.
export function resolvedPackage(name, fromFile) {
  for (let directory = dirname(fromFile); ; directory = dirname(directory)) {
    if (basename(directory) !== "node_modules") {
      const manifest = join(directory, "node_modules", name, "package.json");
      if (existsSync(manifest)) {
        const { name: real, version } = JSON.parse(
          readFileSync(manifest, "utf8"),
        );
        return `${real}@${version}`;
      }
    }
    if (dirname(directory) === directory) return null;
  }
}

// Every installed copy of a package under a node_modules folder.
function installedCopies(nodeModules, name) {
  const copies = [];
  const visit = (folder) => {
    if (!existsSync(folder)) return;
    const manifest = join(folder, name, "package.json");
    if (existsSync(manifest))
      copies.push(JSON.parse(readFileSync(manifest, "utf8")));
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const packages = entry.name.startsWith("@")
        ? readdirSync(join(folder, entry.name), { withFileTypes: true })
            .filter((inner) => inner.isDirectory())
            .map((inner) => join(entry.name, inner.name))
        : [entry.name];
      for (const pkg of packages) visit(join(folder, pkg, "node_modules"));
    }
  };
  visit(nodeModules);
  return copies;
}

/**
 * The faults of the start and of the declared-module rule for a built tree.
 * Returns the faults and the runtime modules for the user comparison.
 */
export function treeFindings(root, { node = process.execPath } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const findings = binFindings(pkg);
  const main = join(root, "main.js");
  if (!existsSync(main)) {
    findings.push(
      "main.js does not exist. Run npm run build in the package root, then run the check again.",
    );
    return { findings, runtime: [] };
  }
  const source = readFileSync(main, "utf8");
  if (!SHEBANG.test(source))
    findings.push(
      "main.js does not start with #!/usr/bin/env node, so the installed glam-cli command cannot start. Restore the banner in scripts/build.mjs and build again.",
    );
  findings.push(
    ...startFindings(node, [main], root, pkg.version, "node main.js --version"),
  );
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  const guarded = new Map(
    GUARDED_OPTIONAL_LOADS.map((entry) => [entry.module, entry]),
  );
  for (const entry of GUARDED_OPTIONAL_LOADS) {
    const copies = installedCopies(join(root, "node_modules"), entry.loadedBy);
    const optional = (copy) =>
      copy.peerDependenciesMeta?.[entry.module]?.optional === true;
    if (copies.length === 0 || !copies.every(optional))
      findings.push(
        `${entry.module} is listed as a guarded optional load of ${entry.loadedBy}, but ${
          copies.length === 0
            ? `${entry.loadedBy} is not installed in node_modules`
            : `an installed ${entry.loadedBy} does not mark it optional in peerDependenciesMeta`
        }. Remove the entry from GUARDED_OPTIONAL_LOADS in scripts/check-bundle.mjs, or declare ${entry.module} if the bundle needs it.`,
      );
  }
  const scan = scanLoads(source);
  const lineOf = (offset) => source.slice(0, offset).split("\n").length;
  const excerpt = (offset) => JSON.stringify(source.slice(offset, offset + 60));
  for (const { word, offset } of scan.strings)
    findings.push(
      `main.js calls ${word} with a string that is not a module name at line ${lineOf(offset)}: ${excerpt(offset)}. A module name holds only ASCII letters, digits and the characters @ / . _ : -, so the check cannot tell what it loads. Make the specifier such a literal in the source or keep the module out of the bundle.`,
    );
  for (const { word, offset } of scan.computed) {
    // An import( whose argument is not a literal passes: the bundle has one.
    if (word !== "require") continue;
    findings.push(
      `main.js calls require with an argument that is not a string literal at line ${lineOf(offset)}: ${excerpt(offset)}. The check cannot tell what it loads. Make the specifier a literal in the source or keep the module out of the bundle.`,
    );
  }
  const runtime = new Set();
  const paths = new Set();
  const leaving = new Set();
  const undeclared = new Set();
  for (const { specifier } of scan.literals) {
    if (isBuiltin(specifier)) continue;
    const name = packageOf(specifier);
    if (name === null) (PATH.test(specifier) ? paths : leaving).add(specifier);
    else if (declared.has(name)) runtime.add(name);
    else if (!guarded.has(name)) undeclared.add(name);
  }
  for (const specifier of [...paths].sort())
    findings.push(
      `main.js loads ${specifier}, a path or a URL. The published package holds main.js and no such file${pkg.files ? `: its files are ${pkg.files.join(", ")}` : ""}. Bundle the file into main.js, then build again.`,
    );
  for (const specifier of [...leaving].sort())
    findings.push(
      `main.js loads ${specifier}, which has a segment that is only dots or that names node_modules. Such a segment can leave the package the specifier names and load one that package.json does not declare. Load the package by its own name and declare it, then build again.`,
    );
  for (const name of [...undeclared].sort())
    findings.push(
      `main.js loads ${name}, which package.json does not declare in dependencies or optionalDependencies. A user's install does not have to provide it. Declare ${name} in the CLI's package.json, or bundle it, then build again.`,
    );
  for (const name of Object.keys(pkg.optionalDependencies ?? {}))
    runtime.add(name);
  return { findings, runtime: [...runtime].sort(), pkg };
}

// The faults of one start: the exit status and the version on stdout.
function startFindings(command, args, cwd, version, label, env = process.env) {
  // stderr goes to a file: Node writes a failing start's error to a pipe
  // asynchronously and exits before the pipe takes all of it.
  const folder = mkdtempSync(join(tmpdir(), "glam-cli-start-"));
  const file = join(folder, "stderr");
  const fd = openSync(file, "w");
  let result;
  try {
    result = spawnSync(command, [...args, "--version"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: START_TIMEOUT,
      stdio: ["ignore", "pipe", fd],
    });
    result.stderr = readFileSync(file, "utf8");
  } finally {
    closeSync(fd);
    rmSync(folder, { recursive: true, force: true });
  }
  if (result.error || result.status !== 0) {
    const reason = result.error
      ? result.error.message
      : `exited ${result.status ?? result.signal}`;
    // The error and the lines after it, or the last lines, each cut short:
    // Node prints the failing line of the bundle, which is megabytes long.
    const lines = (result.stderr ?? "").trim().split("\n");
    const error = lines.findIndex((line) => /^[A-Za-z]*Error\b/.test(line));
    const stderr = (
      error === -1 ? lines.slice(-8) : lines.slice(error, error + 4)
    )
      .map((line) => (line.length > 300 ? `${line.slice(0, 300)}...` : line))
      .join("\n");
    return [
      `${label} failed: ${reason}${stderr ? `\n${stderr}` : ""}\nCorrect the source, the build or the dependencies, then run the check again.`,
    ];
  }
  const printed = result.stdout.trim();
  if (printed !== version)
    return [
      `${label} printed ${JSON.stringify(printed)} on stdout, not the version ${version} in package.json. Correct the version the CLI reports, then build again.`,
    ];
  return [];
}

function pack(root, destination) {
  const [{ filename }] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        `--pack-destination=${destination}`,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  return join(destination, filename);
}

// Installs the tarball as a user would, into a fresh project.
function install(tarball, project) {
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "bundle-check-user", private: true })}\n`,
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: project, stdio: ["ignore", "inherit", "inherit"] },
  );
}

/** The faults of the user install of a tarball, compared with the tree. */
export function userFindings(root, tarball, pkg, runtime, scratch) {
  const findings = [];
  const project = join(scratch, "user");
  const away = join(scratch, "elsewhere");
  mkdirSync(project);
  mkdirSync(away);
  install(tarball, project);
  const installed = join(project, "node_modules", pkg.name);
  const command = join(project, "node_modules", ".bin", COMMAND);
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
  };
  const tarballBin = binFindings(
    JSON.parse(readFileSync(join(installed, "package.json"), "utf8")),
    "the tarball's package.json",
  );
  if (tarballBin.length) findings.push(...tarballBin);
  else if (!existsSync(command))
    findings.push(
      `A user's install of the packed package has no ${COMMAND} command in node_modules/.bin, though the tarball's package.json gives it. Check that the tarball holds main.js.`,
    );
  else
    findings.push(
      ...startFindings(
        command,
        [],
        away,
        pkg.version,
        `The installed ${COMMAND} --version`,
        env,
      ),
    );
  const fromInstalled = join(installed, "main.js");
  const fromTree = join(root, "main.js");
  for (const name of runtime) {
    const tree = resolvedPackage(name, fromTree);
    const user = resolvedPackage(name, fromInstalled);
    if (tree !== user)
      findings.push(
        `${name} resolves to ${tree ?? "nothing"} in the mirror's tree and to ${user ?? "nothing"} in a user's install of the packed package. The tree's lock or overrides give it a package that a user does not get. Declare the package the tree uses in the CLI's package.json, then build again.`,
      );
  }
  return findings;
}

function main() {
  const root = process.cwd();
  const { findings, runtime, pkg } = treeFindings(root);
  if (findings.length === 0) {
    const scratch = mkdtempSync(join(tmpdir(), "glam-cli-bundle-check-"));
    try {
      const tarball = process.argv[2]
        ? resolve(process.argv[2])
        : pack(root, scratch);
      findings.push(...userFindings(root, tarball, pkg, runtime, scratch));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } else
    findings.push(
      "The user install was not checked, because the tree failed the checks above.",
    );
  for (const finding of findings) console.error(finding);
  if (findings.length) {
    console.error("The CLI bundle fails the bundle check.");
    process.exit(1);
  }
  console.log(
    `The CLI bundle starts, declares what it loads, and a user's install loads the same packages: ${runtime.join(", ") || "none"}.`,
  );
  process.exit(0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main();
