// npm run init — create the database, install the shipped models, and make the
// first account.
//
// There is deliberately no public signup route in this product, so the first
// user has to be created here. Subsequent users are invited.
//
//   npm run init
//   npm run init -- --email you@firm.ae --name "Your Name" --password '...'
//
// With no --password the script generates a strong one and prints it once.

import { randomBytes } from "node:crypto";
import { db, migrate } from "../lib/db/index.ts";
import { installSystemModels } from "../seed/install.ts";
import { hashPassword, checkPasswordPolicy } from "../lib/auth/password.ts";
import { createOrganization, createUser, findUserByEmail } from "../lib/db/repo.ts";
import { env } from "../lib/env.ts";

function arg(name: string): string | undefined {
  const prefixed = `--${name}`;
  const index = process.argv.indexOf(prefixed);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  const inline = process.argv.find((a) => a.startsWith(`${prefixed}=`));
  return inline ? inline.slice(prefixed.length + 1) : undefined;
}

function generatePassword(): string {
  // Base64url of 18 bytes: 24 characters, ~107 bits. Comfortably past the
  // policy and short enough to retype from a terminal if it has to be.
  return randomBytes(18).toString("base64url");
}

async function main(): Promise<void> {
  db();
  migrate();
  console.log(`database ready at ${env.dbPath}`);

  const installed = installSystemModels();
  console.log(`${installed} underwriting model(s) installed`);

  const email = (arg("email") ?? process.env.MERIDIAN_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email) {
    console.log(
      "\nNo --email given, so no account was created.\n" +
        "Create the first one with:\n" +
        `  npm run init -- --email you@firm.ae --name "Your Name"\n`,
    );
    return;
  }

  if (findUserByEmail(email)) {
    console.log(`\nAn account already exists for ${email} — nothing to do.`);
    return;
  }

  const name = arg("name") ?? process.env.MERIDIAN_ADMIN_NAME ?? email.split("@")[0];
  const orgName = arg("org") ?? process.env.MERIDIAN_ORG_NAME ?? `${name}'s firm`;

  let password = arg("password") ?? process.env.MERIDIAN_ADMIN_PASSWORD ?? "";
  let generated = false;
  if (!password) {
    password = generatePassword();
    generated = true;
  }

  const policy = checkPasswordPolicy(password, email);
  if (!policy.ok) {
    console.error(`\nThat password was rejected:\n  ${policy.problems.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }

  const org = createOrganization(orgName, arg("market") ?? env.defaultMarket);
  const creds = await hashPassword(password);
  const user = createUser({
    orgId: org.id,
    email,
    name,
    role: "owner",
    status: "active",
    passwordHash: creds.hash,
    passwordSalt: creds.salt,
    passwordAlgo: creds.algo,
  });

  console.log(`\naccount created`);
  console.log(`  organisation  ${org.name}`);
  console.log(`  name          ${user.name}`);
  console.log(`  email         ${user.email}`);
  if (generated) {
    console.log(`  password      ${password}`);
    console.log(`\n  ^ This is shown once and is not recoverable. Save it now.`);
  }
  console.log(`\nStart the server with:  npm run serve`);
}

main().catch((err) => {
  console.error("init failed:", err);
  process.exitCode = 1;
});
