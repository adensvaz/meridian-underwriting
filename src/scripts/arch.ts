// npm run arch — architectural and code-quality gate.
//
// The Ralph loop is deliberately dumb: same prompt, one backlog item at a time.
// That works for correctness because tests catch a wrong answer. It does NOT
// catch a right answer arrived at badly — a route reaching into the database
// directly, a lib file importing a route, a 2,000-line module, a formula
// hard-coded where a model definition belongs.
//
// Those failures compound silently across iterations and are exactly how a
// codebase rots under automation. So the loop needs a gate that encodes the
// architecture rather than trusting each iteration to remember it. Every rule
// here is one this project has actually stated somewhere, made mechanical.
//
// Rules are advisory (warn) or binding (error). Only errors fail the build.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ROOT } from "../lib/env.ts";

interface Violation {
  level: "error" | "warn";
  rule: string;
  file: string;
  line?: number;
  message: string;
}

const violations: Violation[] = [];

function fail(rule: string, file: string, message: string, line?: number): void {
  violations.push({ level: "error", rule, file, message, line });
}
function warn(rule: string, file: string, message: string, line?: number): void {
  violations.push({ level: "warn", rule, file, message, line });
}

// ------------------------------------------------------------------- files --

interface SourceFile {
  path: string;
  rel: string;
  source: string;
  lines: string[];
  /** Relative import specifiers, resolved to repo-relative paths. */
  imports: string[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "data") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function loadSources(): SourceFile[] {
  const files = walk(resolve(ROOT, "src")).filter((f) => f.endsWith(".ts"));
  return files.map((path) => {
    const source = readFileSync(path, "utf8");
    const rel = relative(ROOT, path);
    const imports: string[] = [];
    for (const m of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      imports.push(resolve(path, "..", m[1]));
    }
    return { path, rel, source, lines: source.split("\n"), imports };
  });
}

const sources = loadSources();

// --------------------------------------------------------------- layering --
//
// The dependency direction this codebase is built on:
//
//   routes  →  lib  →  db
//   seed    →  lib
//   scripts →  everything
//
// Anything pointing the other way is a design error, not a style preference.
// A lib module that imports a route cannot be reused or tested in isolation,
// and a db module that imports the AI layer makes persistence depend on a
// network service.

const LAYER_RULES: Array<{ from: string; forbidden: string[]; why: string }> = [
  {
    from: "src/lib/db/",
    forbidden: ["src/routes/", "src/lib/ai/", "src/lib/http/"],
    why: "persistence must not depend on transport, routing or a network service",
  },
  {
    from: "src/lib/engine/",
    forbidden: ["src/routes/", "src/lib/db/", "src/lib/ai/", "src/lib/http/"],
    why: "the underwriting engine must stay a pure function of its inputs — it is the one part that has to be trivially testable and reproducible",
  },
  {
    from: "src/lib/",
    forbidden: ["src/routes/"],
    why: "a library that imports a route cannot be reused or tested in isolation",
  },
  {
    from: "src/seed/",
    forbidden: ["src/routes/", "src/lib/ai/"],
    why: "seed data is data — it must not reach into transport or the model provider",
  },
];

for (const file of sources) {
  for (const rule of LAYER_RULES) {
    if (!file.rel.startsWith(rule.from)) continue;
    // A more specific rule already covered this file's own subtree.
    for (const imported of file.imports) {
      const importedRel = relative(ROOT, imported);
      for (const forbidden of rule.forbidden) {
        if (importedRel.startsWith(forbidden)) {
          fail(
            "layering",
            file.rel,
            `imports ${importedRel} — ${rule.why}`,
          );
        }
      }
    }
  }
}

// ------------------------------------------------------- circular imports --

const graph = new Map<string, string[]>();
for (const file of sources) {
  graph.set(
    file.path,
    file.imports.filter((i) => sources.some((s) => s.path === i)),
  );
}

function findCycle(): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    const s = state.get(node) ?? 0;
    if (s === 1) return [...stack.slice(stack.indexOf(node)), node];
    if (s === 2) return null;
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

const cycle = findCycle();
if (cycle) {
  fail(
    "no-cycles",
    relative(ROOT, cycle[0]),
    `circular import: ${cycle.map((c) => relative(ROOT, c)).join(" → ")}`,
  );
}

// ---------------------------------------------- Node type-stripping limits --
//
// Node runs this TypeScript directly with no build step. That is a deliberate
// deployment choice and it forbids anything requiring a transform.

// This file necessarily contains the literal text of every pattern it looks
// for, so scanning itself reports its own rule definitions as violations. A
// linter cannot lint its own rule table.
const SELF = "src/scripts/arch.ts";

for (const file of sources) {
  if (file.rel === SELF) continue;
  file.lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(export\s+)?enum\s/.test(line)) {
      fail("no-build-step", file.rel, "`enum` needs a transform — use a union type or a const object", n);
    }
    if (/^\s*(export\s+)?namespace\s/.test(line)) {
      fail("no-build-step", file.rel, "`namespace` needs a transform — use a module", n);
    }
    if (/^\s*@[A-Za-z]/.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
      fail("no-build-step", file.rel, "decorators need a transform", n);
    }
    // Relative imports must carry an explicit extension for Node's ESM resolver.
    const rel = /from\s+["'](\.[^"']+)["']/.exec(line);
    if (rel && !/\.(ts|js|json|sql)$/.test(rel[1])) {
      fail("no-build-step", file.rel, `relative import "${rel[1]}" needs an explicit .ts extension`, n);
    }
  });

  // Parameter properties: `constructor(private readonly x: T)`.
  if (/constructor\s*\([^)]*\b(private|public|protected|readonly)\s/.test(file.source)) {
    fail("no-build-step", file.rel, "parameter properties need a transform — assign in the body");
  }
}

// ------------------------------------------------------------- code smells --

const MAX_FILE_LINES = 900;
const MAX_FUNCTION_LINES = 120;

for (const file of sources) {
  if (file.rel === SELF) continue;
  // Model definitions and shipped seed data are declarative; length there is
  // content, not complexity, so they are exempt from the size rule.
  const isData = file.rel.startsWith("src/seed/");

  if (!isData && file.lines.length > MAX_FILE_LINES) {
    warn(
      "file-size",
      file.rel,
      `${file.lines.length} lines (soft limit ${MAX_FILE_LINES}) — consider splitting`,
    );
  }

  // `any` defeats the point of the types being here at all.
  file.lines.forEach((line, i) => {
    if (/\bas\s+any\b/.test(line) || /:\s*any\b/.test(line)) {
      if (!line.includes("eslint") && !line.trim().startsWith("//")) {
        warn("no-any", file.rel, "`any` weakens the type contract — prefer `unknown` and narrow", i + 1);
      }
    }
    // eval and Function are the exact hole the expression engine exists to avoid.
    if (/\beval\s*\(/.test(line) || /new\s+Function\s*\(/.test(line)) {
      fail(
        "no-eval",
        file.rel,
        "eval/new Function is forbidden — user formulas go through src/lib/engine/expr.ts",
        i + 1,
      );
    }
    // Library code logging to stdout pollutes a server's output; genuine
    // failures should use console.error, and anything else belongs to a caller.
    if (file.rel.startsWith("src/lib/") && /^\s*console\.log\(/.test(line)) {
      warn("no-stdout-in-lib", file.rel, "library code should not log to stdout", i + 1);
    }
  });

  // Every module earns a header explaining why it exists. This codebase's
  // comments carry the reasoning; a new file without one is a gap.
  if (!isData && !file.rel.endsWith(".test.ts")) {
    const firstCode = file.lines.findIndex((l) => l.trim() && !l.trim().startsWith("//"));
    if (firstCode <= 0) {
      warn("module-header", file.rel, "no header comment explaining what this module is for");
    }
  }

  // Long functions. Crude brace counting, but it reliably catches the 300-line
  // handler that should have been three functions.
  let depth = 0;
  let start = -1;
  let name = "";
  file.lines.forEach((line, i) => {
    const decl = /^\s*(export\s+)?(async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line);
    if (decl && depth === 0) {
      start = i;
      name = decl[3];
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (start >= 0 && depth === 0 && i > start) {
      const length = i - start;
      if (length > MAX_FUNCTION_LINES) {
        warn("function-size", file.rel, `${name}() is ${length} lines (soft limit ${MAX_FUNCTION_LINES})`, start + 1);
      }
      start = -1;
    }
  });
}

// -------------------------------------------- product-specific invariants --

for (const file of sources) {
  if (file.rel === SELF) continue;
  // Ownership scoping: a route handler must not build SQL itself. Everything
  // goes through repo.ts, which requires an actor. This is the mechanism behind
  // the tenant-isolation guarantee and it must not be bypassed for convenience.
  if (file.rel.startsWith("src/routes/")) {
    file.lines.forEach((line, i) => {
      if (/\b(all|get|run)\s*\(\s*["'`]\s*(SELECT|INSERT|UPDATE|DELETE)/i.test(line)) {
        fail(
          "no-sql-in-routes",
          file.rel,
          "raw SQL in a route bypasses the ownership scoping in repo.ts",
          i + 1,
        );
      }
    });
  }

  // Hard-coded market assumptions. The whole product claim is that underwriting
  // logic is editable data; a cap rate or yield baked into TypeScript is a
  // regression of that claim.
  if (file.rel.startsWith("src/lib/engine/") || file.rel.startsWith("src/lib/underwrite")) {
    file.lines.forEach((line, i) => {
      if (/\b(cap_rate|capRate|grossYield|gross_yield)\s*=\s*[\d.]/.test(line)) {
        fail(
          "no-hardcoded-underwriting",
          file.rel,
          "an underwriting constant belongs in a model definition, not in the engine",
          i + 1,
        );
      }
    });
  }
}

// ------------------------------------------------------------------ report --

const errors = violations.filter((v) => v.level === "error");
const warnings = violations.filter((v) => v.level === "warn");

const byRule = new Map<string, Violation[]>();
for (const v of violations) {
  const list = byRule.get(v.rule) ?? [];
  list.push(v);
  byRule.set(v.rule, list);
}

console.log(`\narchitecture gate — ${sources.length} source files\n`);

if (!violations.length) {
  console.log("  no violations\n");
} else {
  for (const [rule, list] of [...byRule.entries()].sort()) {
    const level = list[0].level === "error" ? "ERROR" : "warn ";
    console.log(`  ${level} ${rule} (${list.length})`);
    for (const v of list.slice(0, 8)) {
      console.log(`        ${v.file}${v.line ? `:${v.line}` : ""} — ${v.message}`);
    }
    if (list.length > 8) console.log(`        … and ${list.length - 8} more`);
    console.log("");
  }
}

console.log(`${errors.length} error(s), ${warnings.length} warning(s)\n`);
if (errors.length) process.exitCode = 1;
