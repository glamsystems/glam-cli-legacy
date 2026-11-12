import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GUARDED_OPTIONAL_LOADS,
  binFindings,
  leavesPackage,
  packageOf,
  scanLoads,
} from "../check-bundle.mjs";

// Runs scripts/check-bundle.mjs as the mirror does, from a built package root,
// with the real npm offline. Each dependency is a local tarball, so the user
// install resolves it without a registry, and the tree's node_modules is
// written by hand, as an npm ci with overrides could leave it.
const SCRIPT = fileURLToPath(new URL("../check-bundle.mjs", import.meta.url));
const VERSION = "1.4.0";
// It reads package.json through fs, since a path given to require is refused.
const PRINT_VERSION = `if (process.argv[2] === "--version") console.log(JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "package.json"), "utf8")).version);\n`;

const writeAll = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
};

// The installed copies of ws and node-fetch, which mark the guarded loads
// optional as the real ones do.
const LOADERS = {
  "node_modules/ws/package.json": {
    name: "ws",
    version: "7.5.11",
    peerDependenciesMeta: {
      bufferutil: { optional: true },
      "utf-8-validate": { optional: true },
    },
  },
  "node_modules/node-fetch/package.json": {
    name: "node-fetch",
    version: "2.7.0",
    peerDependenciesMeta: { encoding: { optional: true } },
  },
};

// Given as the bin of a scenario, it leaves bin out of package.json.
const NO_BIN = Symbol("no bin");

function scenario({
  main = `#!/usr/bin/env node\nrequire("dep");\n${PRINT_VERSION}`,
  bin = { "glam-cli": "./main.js" },
  // The version the user's install gets, and the one the tree holds.
  userDep = "1.0.0",
  treeDep = { name: "dep", version: "1.0.0" },
  optionalDependencies,
  // More declared packages, each a name and the version both trees get.
  packages = {},
  tree = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "glam-cli-check-test-"));
  const work = join(root, "work");
  const tarballs = join(root, "tarballs");
  const temporary = join(root, "tmp");
  for (const folder of [work, tarballs, temporary]) mkdirSync(folder);
  const dep = (version, name = "dep") => {
    const file = `${name.replace("/", "-")}-${version}`;
    const folder = join(root, file);
    writeAll(folder, {
      "package/package.json": { name, version, main: "index.js" },
      "package/index.js": "module.exports = 1;\n",
    });
    const tarball = join(tarballs, `${file}.tgz`);
    execFileSync("tar", ["-czf", tarball, "-C", folder, "package"]);
    return tarball;
  };
  const pkg = {
    name: "@glamsystems/glam-cli",
    version: VERSION,
    ...(bin === NO_BIN ? {} : { bin }),
    files: ["main.js"],
    dependencies: {
      dep: `file:${dep(userDep)}`,
      ...Object.fromEntries(
        Object.entries(packages).map(([name, version]) => [
          name,
          `file:${dep(version, name)}`,
        ]),
      ),
    },
    ...(optionalDependencies ? { optionalDependencies } : {}),
  };
  writeAll(work, {
    "package.json": pkg,
    "main.js": main,
    ...LOADERS,
    ...(treeDep
      ? {
          "node_modules/dep/package.json": { ...treeDep, main: "index.js" },
          "node_modules/dep/index.js": "module.exports = 1;\n",
        }
      : {}),
    ...Object.fromEntries(
      Object.entries(packages).flatMap(([name, version]) => [
        [
          `node_modules/${name}/package.json`,
          { name, version, main: "index.js" },
        ],
        [`node_modules/${name}/index.js`, "module.exports = 1;\n"],
      ]),
    ),
    ...tree,
  });
  const env = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: root,
    TMPDIR: temporary,
    npm_config_cache: join(root, ".npm-cache"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
  const listing = () =>
    readdirSync(work, { recursive: true })
      .filter((path) => !path.startsWith("node_modules"))
      .sort();
  return {
    root,
    work,
    env,
    check: (...args) => {
      const before = listing();
      const result = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: work,
        env,
        encoding: "utf8",
      });
      assert.deepEqual(listing(), before, "the check left a file in the tree");
      // npm keeps its compile cache in the temporary folder too.
      assert.deepEqual(
        readdirSync(temporary).filter((name) => name.startsWith("glam-cli-")),
        [],
        "the check left a temporary folder",
      );
      return result;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const passes = (result) =>
  assert.equal(
    result.status,
    0,
    `check-bundle.mjs exited ${result.status}:\n${result.stderr}`,
  );
const refuses = (result, pattern) => {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, pattern);
  assert.match(result.stderr, /The CLI bundle fails the bundle check\./);
};

test("a built package whose user install loads the same packages passes", (t) => {
  const run = scenario();
  t.after(run.cleanup);
  const result = run.check();
  passes(result);
  assert.match(result.stdout, /loads the same packages: dep\./);
});

test("a main.js without the node shebang is refused", (t) => {
  const run = scenario({ main: `require("dep");\n${PRINT_VERSION}` });
  t.after(run.cleanup);
  refuses(run.check(), /main\.js does not start with #!\/usr\/bin\/env node/);
});

test("a missing main.js is refused with the build to run", (t) => {
  const run = scenario();
  t.after(run.cleanup);
  rmSync(join(run.work, "main.js"));
  refuses(run.check(), /main\.js does not exist\. Run npm run build/);
});

test("a start that prints another version is refused", (t) => {
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\nconsole.log("1.3.9");\n`,
  });
  t.after(run.cleanup);
  refuses(
    run.check(),
    /node main\.js --version printed "1\.3\.9" on stdout, not the version 1\.4\.0/,
  );
});

// stdout must be the version alone, so neither a prefix, a suffix nor a line
// printed before it passes.
for (const printed of ["v1.4.0", "1.4.0-dirty", "warning: slow start\n1.4.0"])
  test(`a start that prints ${JSON.stringify(printed)} is refused`, (t) => {
    const run = scenario({
      main: `#!/usr/bin/env node\nrequire("dep");\nconsole.log(${JSON.stringify(printed)});\n`,
    });
    t.after(run.cleanup);
    refuses(
      run.check(),
      new RegExp(
        RegExp.escape(
          `node main.js --version printed ${JSON.stringify(printed)} on stdout, not the version 1.4.0`,
        ),
      ),
    );
  });

test("a start that fails is refused with its error", (t) => {
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\nthrow new Error("the bundle cannot start");\n`,
  });
  t.after(run.cleanup);
  const result = run.check();
  refuses(
    result,
    /node main\.js --version failed: exited 1\nError: the bundle cannot start/,
  );
  assert.match(result.stderr, /The user install was not checked/);
});

test("a version printed with a warning on stderr passes", (t) => {
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\nconsole.error("bigint: Failed to load bindings, pure JS will be used");\n${PRINT_VERSION}`,
  });
  t.after(run.cleanup);
  passes(run.check());
});

test("a runtime module the package does not declare is refused by name", (t) => {
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\ntry { require("bigint-buffer"); } catch {}\nimport("undeclared-import").catch(() => {});\n${PRINT_VERSION}`,
  });
  t.after(run.cleanup);
  const result = run.check();
  refuses(
    result,
    /main\.js loads bigint-buffer, which package\.json does not declare in dependencies or optionalDependencies/,
  );
  assert.match(
    result.stderr,
    /main\.js loads undeclared-import, which package\.json does not declare/,
  );
});

test("a guarded optional load passes while its loader marks it an optional peer", (t) => {
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\ntry { require("utf-8-validate"); } catch {}\ntry { require("encoding"); } catch {}\n${PRINT_VERSION}`,
  });
  t.after(run.cleanup);
  passes(run.check());
});

test("a listed optional load that is no longer an optional peer is refused", (t) => {
  const run = scenario({
    tree: {
      "node_modules/rpc-websockets/node_modules/ws/package.json": {
        name: "ws",
        version: "8.21.0",
        peerDependenciesMeta: { bufferutil: { optional: true } },
      },
    },
  });
  t.after(run.cleanup);
  refuses(
    run.check(),
    /utf-8-validate is listed as a guarded optional load of ws, but an installed ws does not mark it optional/,
  );
});

test("a listed optional load whose loader is no longer installed is refused", (t) => {
  const run = scenario();
  t.after(run.cleanup);
  rmSync(join(run.work, "node_modules", "node-fetch"), { recursive: true });
  refuses(
    run.check(),
    /encoding is listed as a guarded optional load of node-fetch, but node-fetch is not installed/,
  );
});

test("a require whose argument is not a string literal is refused", (t) => {
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\nconst name = "dep";\nrequire(name);\n${PRINT_VERSION}`,
  });
  t.after(run.cleanup);
  refuses(
    run.check(),
    /main\.js calls require with an argument that is not a string literal at line 4: "require\(name\)/,
  );
});

test("a require whose argument is not a string is refused in each form", (t) => {
  const forms = [
    "require()",
    'require(/* c */ "dep")',
    "__require(name)",
    "module.require(name)",
  ];
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\nconst name = "dep";\n${forms.map((form) => `try { ${form}; } catch {}`).join("\n")}\n${PRINT_VERSION}`,
  });
  t.after(run.cleanup);
  const result = run.check();
  refuses(result, /not a string literal/);
  forms.forEach((form, index) =>
    assert.match(
      result.stderr,
      new RegExp(
        RegExp.escape(
          `main.js calls require with an argument that is not a string literal at line ${index + 4}: "`,
        ),
      ),
      form,
    ),
  );
  assert.equal(
    result.stderr.match(/not a string literal at line/g).length,
    forms.length,
  );
});

test("a require or an import with a string that is not a module name is refused in each form", (t) => {
  const forms = [
    'require("")',
    'require("\\x64ep")',
    'require("d" + "ep")',
    'require("dep", "x")',
    'require("dep",)',
    'require("dep" /* c */)',
    'require(`d${"e"}p`)',
    'import("a b")',
  ];
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\n${forms.map((form) => `if (process.argv[2] === "never") { ${form}; }`).join("\n")}\n${PRINT_VERSION}`,
  });
  t.after(run.cleanup);
  const result = run.check();
  refuses(result, /a string that is not a module name/);
  assert.match(
    result.stderr,
    /A module name holds only ASCII letters, digits and the characters @ \/ \. _ : -, so the check cannot tell what it loads\./,
  );
  forms.forEach((form, index) =>
    assert.match(
      result.stderr,
      new RegExp(
        RegExp.escape(
          `main.js calls ${form.split("(")[0]} with a string that is not a module name at line ${index + 3}: ${JSON.stringify(`${form}; }`).slice(0, -1)}`,
        ),
      ),
      form,
    ),
  );
  assert.equal(
    result.stderr.match(/not a module name at line/g).length,
    forms.length,
  );
  assert.doesNotMatch(result.stderr, /not a string literal/);
});

test("an import whose argument is not a string literal passes", (t) => {
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\nconst name = "node:fs";\nimport(name).catch(() => {});\n${PRINT_VERSION}`,
  });
  t.after(run.cleanup);
  passes(run.check());
});

test("require text inside a string or a comment counts like a call", (t) => {
  const run = scenario({
    main: [
      "#!/usr/bin/env node",
      'require("dep");',
      `const other = 'require("undeclared-in-a-string")';`,
      '// require("undeclared-in-a-comment")',
      PRINT_VERSION,
    ].join("\n"),
  });
  t.after(run.cleanup);
  const result = run.check();
  refuses(result, /main\.js loads undeclared-in-a-string, which package\.json/);
  assert.match(
    result.stderr,
    /main\.js loads undeclared-in-a-comment, which package\.json/,
  );
});

test("require text inside a string or a comment that names a builtin passes", (t) => {
  const run = scenario({
    main: [
      "#!/usr/bin/env node",
      'require("dep");',
      `const hint = "Use iconv.enableStreamingAPI(require('stream')); to enable it.";`,
      '// require("node:fs")',
      "/* import(`path`) */",
      PRINT_VERSION,
    ].join("\n"),
  });
  t.after(run.cleanup);
  const result = run.check();
  passes(result);
  assert.match(result.stdout, /loads the same packages: dep\.$/m);
});

test("a path or a URL is refused, since the package holds no such file", (t) => {
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\ntry { require("./local.js"); } catch {}\ntry { require("/abs/x.js"); } catch {}\ntry { require("file:///abs/y.js"); } catch {}\n${PRINT_VERSION}`,
  });
  t.after(run.cleanup);
  const result = run.check();
  for (const specifier of ["./local.js", "/abs/x.js", "file:///abs/y.js"])
    assert.match(
      result.stderr,
      new RegExp(
        RegExp.escape(
          `main.js loads ${specifier}, a path or a URL. The published package holds main.js and no such file: its files are main.js.`,
        ),
      ),
    );
  refuses(result, /a path or a URL/);
});

test("builtins with and without the node: prefix are not runtime modules", (t) => {
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\nrequire("fs");\nrequire("node:fs");\nrequire("fs/promises");\nrequire("node:test");\n${PRINT_VERSION}`,
  });
  t.after(run.cleanup);
  const result = run.check();
  passes(result);
  assert.match(result.stdout, /loads the same packages: dep\.$/m);
});

test("an optional dependency absent from both trees passes", (t) => {
  const run = scenario({
    optionalDependencies: { "optional-hid": "file:./absent/optional-hid.tgz" },
  });
  t.after(run.cleanup);
  const result = run.check();
  passes(result);
  assert.match(result.stdout, /loads the same packages: dep, optional-hid\./);
});

test("an optional dependency present in the tree alone is refused", (t) => {
  const run = scenario({
    optionalDependencies: { "optional-hid": "file:./absent/optional-hid.tgz" },
    tree: {
      "node_modules/optional-hid/package.json": {
        name: "optional-hid",
        version: "6.33.1",
      },
    },
  });
  t.after(run.cleanup);
  refuses(
    run.check(),
    /optional-hid resolves to optional-hid@6\.33\.1 in the mirror's tree and to nothing in a user's install/,
  );
});

test("a user install that resolves another package than the tree is refused", (t) => {
  // The tree took the fork through an override, which a user's install does
  // not apply. The name is the one in the resolved package.json.
  const run = scenario({
    userDep: "1.1.5",
    treeDep: { name: "@exodus/dep", version: "1.1.5-exodus.1" },
  });
  t.after(run.cleanup);
  refuses(
    run.check(),
    /dep resolves to @exodus\/dep@1\.1\.5-exodus\.1 in the mirror's tree and to dep@1\.1\.5 in a user's install of the packed package/,
  );
});

test("a user install whose binary does not start is refused", (t) => {
  // The tree starts because its working folder holds a cli/ folder that the
  // bundle loads from through createRequire. A user's working folder does not.
  const run = scenario({
    main: `#!/usr/bin/env node\nrequire("dep");\nrequire("node:module").createRequire(__filename)(require("node:path").join(process.cwd(), "cli", "x.js"));\n${PRINT_VERSION}`,
    tree: { "cli/x.js": "" },
  });
  t.after(run.cleanup);
  refuses(
    run.check(),
    /The installed glam-cli --version failed: exited 1\nError: Cannot find module/,
  );
});

const specifiers = (source) =>
  scanLoads(source).literals.map(({ word, specifier }) => [word, specifier]);

test("the search reads each quote form as a literal", () => {
  assert.deepEqual(specifiers("require(\"a\");require('b');require(`c`)"), [
    ["require", "a"],
    ["require", "b"],
    ["require", "c"],
  ]);
});

test("the search allows space and a newline before the parenthesis", () => {
  assert.deepEqual(
    specifiers('require ("a");require\n("b");require \n ( "c" \n)'),
    [
      ["require", "a"],
      ["require", "b"],
      ["require", "c"],
    ],
  );
});

test("the search reads an optional call", () => {
  assert.deepEqual(specifiers('require?.("a");require ?. ( "b" )'), [
    ["require", "a"],
    ["require", "b"],
  ]);
});

test("the search reads a prefixed or member require and an import", () => {
  assert.deepEqual(
    specifiers(
      '__require("a");module.require("b");import("c");obj.import("d")',
    ),
    [
      ["require", "a"],
      ["require", "b"],
      ["import", "c"],
      ["import", "d"],
    ],
  );
});

test("the search does not read a longer name or require as a value", () => {
  const source = [
    'require_x("a");requires("b");requireX("c");required("d")',
    'imports("e");important("f");import_x("g")',
    'var r=typeof __webpack_require__=="function"?__non_webpack_require__:require;',
    "(0,_3r.createRequire)(n)(e);",
  ].join("\n");
  assert.deepEqual(scanLoads(source), {
    literals: [],
    strings: [],
    computed: [],
  });
});

test("the search counts an argument that is not a quote as computed", () => {
  for (const form of ["require()", 'require(/* c */ "a")', "require(name)"])
    assert.deepEqual(
      scanLoads(form),
      { literals: [], strings: [], computed: [{ word: "require", offset: 0 }] },
      form,
    );
  assert.deepEqual(scanLoads("x=import(name)"), {
    literals: [],
    strings: [],
    computed: [{ word: "import", offset: 2 }],
  });
});

test("the search counts a quoted argument that is not a literal as another string", () => {
  const forms = [
    'require("")',
    "require('')",
    "require(``)",
    'require("\\x61")',
    "require('a\\'b')",
    "require(`a\\u0062`)",
    'require("a\nb")',
    "require(`a${b}`)",
    "require(`a$b`)",
    'require("a"+b)',
    'require("a", "b")',
    'require("a",)',
    'require("a" /* c */)',
    'require("a" // c\n)',
    'require("a b")',
    'require("a(b)")',
    'require("a\'")',
  ];
  for (const form of forms)
    assert.deepEqual(
      scanLoads(form),
      { literals: [], strings: [{ word: "require", offset: 0 }], computed: [] },
      form,
    );
  assert.deepEqual(scanLoads("x=import(`a${b}`)"), {
    literals: [],
    strings: [{ word: "import", offset: 2 }],
    computed: [],
  });
});

test("the search gives the offset of the word", () => {
  assert.deepEqual(scanLoads('x;\n__require("a")'), {
    literals: [{ word: "require", specifier: "a", offset: 5 }],
    strings: [],
    computed: [],
  });
});

test("the search reads each literal after a slash that divides or starts a regular expression", () => {
  const probes = [
    ['var a = function(){} /1; require("probe-1")//', "probe-1"],
    ['var a = class {} /1; require("probe-2")//', "probe-2"],
    [
      'x = class extends {}.constructor {} / 1; require("probe-a")//',
      "probe-a",
    ],
    [
      "class A extends [Object, 1][0] {}\n/'/; require(\"probe-b\") // '",
      "probe-b",
    ],
    ['require?.("probe-c")', "probe-c"],
    ['var of = 2; of / 1; require("probe-d") //', "probe-d"],
    ['var await = 2; await / 1; require("probe-e") //', "probe-e"],
    [
      "async function f(y){ for await (const x of y) /'/; require(\"probe-f\") // '\n}; f([])",
      "probe-f",
    ],
  ];
  for (const [source, specifier] of probes)
    assert.deepEqual(
      scanLoads(source),
      {
        literals: [
          { word: "require", specifier, offset: source.indexOf("require") },
        ],
        strings: [],
        computed: [],
      },
      source,
    );
});

test("a package name keeps its scope and drops a subpath", () => {
  assert.equal(
    packageOf("@ledgerhq/hw-app-solana/lib/x"),
    "@ledgerhq/hw-app-solana",
  );
  assert.equal(packageOf("bigint-buffer/sub"), "bigint-buffer");
  assert.equal(packageOf("a/b"), "a");
  assert.equal(packageOf("@scope/pkg/sub"), "@scope/pkg");
  assert.equal(packageOf("@scope/pkg"), "@scope/pkg");
  assert.equal(packageOf("dep/sub/file.js"), "dep");
  assert.equal(packageOf("@s/p/sub"), "@s/p");
  assert.equal(packageOf("dep/"), "dep");
  // buffer/ is not a builtin and names the package buffer.
  assert.equal(isBuiltin("buffer/"), false);
  assert.equal(packageOf("buffer/"), "buffer");
  assert.equal(packageOf("./local"), null);
  assert.equal(packageOf("../up"), null);
  assert.equal(packageOf("/absolute"), null);
  assert.equal(packageOf("file:///absolute"), null);
});

test("a specifier with a segment that is only dots or that names node_modules names no package", () => {
  for (const specifier of [
    "dep/../x",
    "dep/./x",
    "dep/..",
    "@s/p/../x",
    "node_modules/x",
    "dep/node_modules/x",
  ]) {
    assert.equal(leavesPackage(specifier), true, specifier);
    assert.equal(packageOf(specifier), null, specifier);
  }
  for (const specifier of ["dep/sub/file.js", "dep/", "dep/.x", "dep/x..y"])
    assert.equal(leavesPackage(specifier), false, specifier);
});

test("a segment leaves when it is only dots or node_modules in any case with or without dots after it", () => {
  for (const segment of [
    ".",
    "..",
    "...",
    "node_modules",
    "Node_Modules",
    "node_modules.",
    "NODE_MODULES..",
  ]) {
    assert.equal(leavesPackage(segment), true, segment);
    assert.equal(leavesPackage(`dep/${segment}/x`), true, segment);
  }
  for (const segment of [
    "",
    "node_modules.bak",
    "my_node_modules",
    "a..b",
    ".hidden",
    "x.",
  ]) {
    assert.equal(leavesPackage(segment), false, segment);
    assert.equal(leavesPackage(`dep/${segment}/x`), false, segment);
  }
  assert.equal(leavesPackage("dep/"), false);
  assert.equal(leavesPackage("dep//x"), false);
});

test("the segment rule equals its oracle on every short segment and the node_modules forms", () => {
  // An empty segment never leaves.
  const oracle = (segment) =>
    segment !== "" &&
    (/^\.+$/u.test(segment) || /^node_modules\.*$/iu.test(segment));
  const segments = [""];
  for (let length = 1, last = [""]; length <= 4; length += 1) {
    last = last.flatMap((prefix) =>
      [".", "n", "N", "_", "a"].map((character) => prefix + character),
    );
    segments.push(...last);
  }
  segments.push(
    "node_modules",
    "NODE_MODULES",
    "Node_Modules.",
    "node_modules...",
    "node_modulesx",
    "xnode_modules",
    "node_modules.x",
  );
  assert.equal(segments.length, 788);
  for (const segment of segments) {
    assert.equal(leavesPackage(segment), oracle(segment), segment);
    assert.equal(leavesPackage(`dep/${segment}/x`), oracle(segment), segment);
  }
});

test("each guarded optional load names its loader and its reason", () => {
  assert.deepEqual(
    GUARDED_OPTIONAL_LOADS.map(({ module, loadedBy }) => [module, loadedBy]),
    [
      ["utf-8-validate", "ws"],
      ["encoding", "node-fetch"],
    ],
  );
  for (const entry of GUARDED_OPTIONAL_LOADS)
    assert.match(entry.reason, /inside try\/catch/);
});

// A main.js that holds an input where the start does not run it.
const holding = (input) =>
  `#!/usr/bin/env node\nrequire("dep");\nif (process.argv[2] === "never") { ${input}; }\n${PRINT_VERSION}`;
const another = (word) =>
  new RegExp(
    `^main\\.js calls ${word} with a string that is not a module name at line 3: `,
  );
const computedRequire =
  /^main\.js calls require with an argument that is not a string literal at line 3: /;
const undeclared = (name) =>
  new RegExp(
    `^main\\.js loads ${RegExp.escape(name)}, which package\\.json does not declare`,
  );
const leaving = (specifier) =>
  new RegExp(
    `^${RegExp.escape(`main.js loads ${specifier}, which has a segment that is only dots or that names node_modules. Such a segment can leave the package the specifier names and load one that package.json does not declare. Load the package by its own name and declare it, then build again.`)}$`,
  );
// Refused with exactly these faults, in this order.
const refusesWith = (result, patterns) => {
  assert.equal(result.status, 1, result.stdout);
  const lines = result.stderr.trim().split("\n");
  assert.deepEqual(lines.slice(-2), [
    "The user install was not checked, because the tree failed the checks above.",
    "The CLI bundle fails the bundle check.",
  ]);
  assert.equal(lines.length - 2, patterns.length, result.stderr);
  patterns.forEach((pattern, index) =>
    assert.match(lines[index], pattern, result.stderr),
  );
};

for (const [input, patterns, name = `${input} is refused`] of [
  [
    `require("dep"); try { require("dep/ require('undeclared-nested') "); } catch {}`,
    [another("require"), undeclared("undeclared-nested")],
    "a string that holds a require is refused, and so is the package that require names",
  ],
  [
    `x = "bigint-buffer"; require("bigint-buffer/ require(name) import('evil') ")`,
    [another("require"), computedRequire, undeclared("evil")],
    "a string that holds a computed require and an import is refused, and so are the computed require and the package the import names",
  ],
  ...[
    "dep/../undeclared-dotdot",
    "dep/./x",
    "encoding/../x",
    "dep/node_modules/x",
    "@s/p/../x",
    "node_modules/x",
    "dep/Node_Modules/evil",
    "dep/NODE_MODULES/evil/index.js",
    "@s/p/Node_Modules/evil",
    "dep/node_modules./evil",
    "dep/.../x",
  ].map((specifier) => [`require("${specifier}")`, [leaving(specifier)]]),
  ...[
    'import("dep/%2e%2e/x")',
    'require("dep/%2e%2e/x")',
    'require("a b")',
    'require("a(b)")',
    'require("x",)',
    'require("")',
    'require("\\x70")',
    "import(`a${b}`)",
    "import('dep', {})",
  ].map((input) => [input, [another(input.split("(")[0])]]),
])
  test(name, (t) => {
    const run = scenario({
      main: holding(input),
      packages: { "@s/p": "1.0.0" },
    });
    t.after(run.cleanup);
    refusesWith(run.check(), patterns);
  });

for (const input of ["import(name)", 'import(/**/"x")'])
  test(`${input} passes, since the search does not see what it loads`, (t) => {
    const run = scenario({ main: holding(input) });
    t.after(run.cleanup);
    const result = run.check();
    passes(result);
    assert.match(result.stdout, /loads the same packages: dep\.$/m);
  });

test("a subpath of a declared package passes and the package joins the runtime modules", (t) => {
  const run = scenario({
    main: holding(
      'require("dep/sub/file.js"); require("@s/p/sub"); require("dep/"); import(`dep`)',
    ),
    packages: { "@s/p": "1.0.0" },
  });
  t.after(run.cleanup);
  const result = run.check();
  passes(result);
  assert.match(result.stdout, /loads the same packages: @s\/p, dep\.$/m);
});

// A seeded generator written with Math.imul, so every run reads the same
// inputs.
const seeded = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

test("the search classifies each place where require or import meets a parenthesis exactly once", () => {
  // Repeated fragments come up more often, so the inputs are dense.
  const fragments = [
    ...["require", "require", "require(", "import", "import("],
    ...["(", "(", ")", '"', '"', "'", "`", " ", "?.", "a", "a", "/", ".."],
  ];
  const head = /(?=(?:require|import)\s*(?:\?\.\s*)?\()/gu;
  const next = seeded(7);
  for (let index = 0; index < 50_000; index++) {
    let source = "";
    for (let length = 1 + Math.floor(next() * 32); length > 0; length--)
      source += fragments[Math.floor(next() * fragments.length)];
    const { literals, strings, computed } = scanLoads(source);
    const found = [...literals, ...strings, ...computed]
      .map(({ offset }) => offset)
      .sort((a, b) => a - b);
    const places = [...source.matchAll(head)].map(({ index }) => index);
    if (found.join() !== places.join())
      assert.deepEqual(found, places, JSON.stringify(source));
  }
});

// The fault of each bin, as the check prints it for a manifest.
const binMessage = (bin, where = "package.json") =>
  `The bin in ${where} is ${JSON.stringify(bin) ?? "missing"}. It must give one command, glam-cli, started from main.js, or a user's install has no checked glam-cli to start. The sync keeps the mirror's own bin, which must be { "glam-cli": "./main.js" }.`;

test("a bin that is the one command glam-cli started from main.js passes", () => {
  assert.deepEqual(binFindings({ bin: { "glam-cli": "./main.js" } }), []);
  assert.deepEqual(binFindings({ bin: { "glam-cli": "main.js" } }), []);
});

test("every other bin is refused with the one message", () => {
  assert.deepEqual(binFindings({}), [binMessage(undefined)]);
  assert.match(binFindings({})[0], /^The bin in package\.json is missing\. /);
  for (const bin of [
    null,
    {},
    { glam: "./main.js" },
    { "glam-cli": "./other.js" },
    { "glam-cli": "./main.js", glam: "./main.js" },
    "./main.js",
    ["./main.js"],
    { "glam-cli": 7 },
  ])
    assert.deepEqual(
      binFindings({ bin }),
      [binMessage(bin)],
      JSON.stringify(bin),
    );
});

// Refused for its bin alone, before any install. npm writes its cache and its
// logs under the scenario's cache folder, so a run of npm leaves that folder.
const refusesBin = (run, bin) => {
  refusesWith(run.check(), [new RegExp(`^${RegExp.escape(binMessage(bin))}$`)]);
  assert.equal(existsSync(join(run.root, ".npm-cache")), false, "npm ran");
};

test("a package.json without bin is refused before the user install", (t) => {
  const run = scenario({ bin: NO_BIN });
  t.after(run.cleanup);
  refusesBin(run, undefined);
});

test("a package.json with an empty bin is refused before the user install", (t) => {
  const run = scenario({ bin: {} });
  t.after(run.cleanup);
  refusesBin(run, {});
});

test("a package.json whose bin renames the command is refused before the user install", (t) => {
  const run = scenario({ bin: { glam: "./main.js" } });
  t.after(run.cleanup);
  refusesBin(run, { glam: "./main.js" });
});

// A tarball packed by hand from a scenario's package.json, with its bin set
// or removed, and the given files.
const packOf = (
  run,
  {
    bin,
    files = { "main.js": readFileSync(join(run.work, "main.js"), "utf8") },
  } = {},
) => {
  const folder = mkdtempSync(join(run.root, "packed-"));
  const pkg = JSON.parse(readFileSync(join(run.work, "package.json"), "utf8"));
  if (bin === NO_BIN) delete pkg.bin;
  else if (bin !== undefined) pkg.bin = bin;
  writeAll(folder, {
    "package/package.json": pkg,
    ...Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        `package/${path}`,
        content,
      ]),
    ),
  });
  const tarball = join(folder, `glamsystems-glam-cli-${VERSION}.tgz`);
  execFileSync("tar", ["-czf", tarball, "-C", folder, "package"]);
  return tarball;
};

// The user install of a tarball, run in its own process with the scenario's
// offline npm.
const userFindingsOf = (run, tarball = packOf(run)) => {
  const scratch = mkdtempSync(join(run.root, "scratch-"));
  const code = [
    'import { readFileSync } from "node:fs";',
    `import { userFindings } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`,
    `const [root, tarball, scratch] = ${JSON.stringify([run.work, tarball, scratch])};`,
    'const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));',
    'console.log(JSON.stringify(userFindings(root, tarball, pkg, ["dep"], scratch)));',
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { cwd: run.work, env: run.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  // npm prints its summary on the same stdout, before the findings.
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
};

test("the user install applies the bin rule to the tarball, so a tarball whose package.json has no bin is refused", (t) => {
  const run = scenario();
  t.after(run.cleanup);
  assert.deepEqual(userFindingsOf(run, packOf(run, { bin: NO_BIN })), [
    binMessage(undefined, "the tarball's package.json"),
  ]);
});

test("the user install of a tarball with the right bin and no main.js has no glam-cli command", (t) => {
  const run = scenario();
  t.after(run.cleanup);
  assert.deepEqual(userFindingsOf(run, packOf(run, { files: {} })), [
    "A user's install of the packed package has no glam-cli command in node_modules/.bin, though the tarball's package.json gives it. Check that the tarball holds main.js.",
  ]);
});

test("the user install of a good package starts glam-cli and finds nothing", (t) => {
  const run = scenario();
  t.after(run.cleanup);
  assert.deepEqual(userFindingsOf(run), []);
});

test("a tarball argument whose package.json gives another bin is refused, and no command starts", (t) => {
  const run = scenario();
  t.after(run.cleanup);
  // other.js prints the version, so only the bin rule refuses it. It leaves a
  // file when it starts.
  const started = join(run.root, "started");
  const bin = { "glam-cli": "./other.js", glam: "./other.js" };
  const tarball = packOf(run, {
    bin,
    files: {
      "main.js": readFileSync(join(run.work, "main.js"), "utf8"),
      "other.js": `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(started)}, "");\nconsole.log(${JSON.stringify(VERSION)});\n`,
    },
  });
  const result = run.check(tarball);
  assert.equal(result.status, 1, result.stdout);
  assert.deepEqual(result.stderr.trim().split("\n"), [
    binMessage(bin, "the tarball's package.json"),
    "The CLI bundle fails the bundle check.",
  ]);
  assert.equal(existsSync(started), false, "a command started");
});
