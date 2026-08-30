// npm run reset — drop the database and every uploaded document.
//
// Destructive and deliberately awkward: it requires --yes, because the thing it
// deletes is confidential deal documents.

import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { env, ROOT } from "../lib/env.ts";

if (!process.argv.includes("--yes")) {
  console.log(
    "This deletes the database and every uploaded document.\n\n" +
      "  npm run reset -- --yes\n",
  );
  process.exit(1);
}

const targets = [
  env.dbPath,
  `${env.dbPath}-wal`,
  `${env.dbPath}-shm`,
  env.uploadDir,
  resolve(ROOT, "data/.session-key"),
];

let removed = 0;
for (const target of targets) {
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
  console.log(`removed ${target}`);
  removed++;
}

console.log(removed ? `\n${removed} path(s) removed. Run: npm run init` : "\nNothing to remove.");
