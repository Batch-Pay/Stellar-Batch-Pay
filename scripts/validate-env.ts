import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolveVestingContractId } from "../lib/stellar/vesting-config";
import { getStoreConfig, validateStoreConfig } from "../lib/store-config";

const ROOT = process.cwd();
let failed = false;

function fail(message: string): void {
  console.error(`FAIL: ${message}`);
  failed = true;
}

function ok(message: string): void {
  console.log(`OK: ${message}`);
}

function warn(message: string): void {
  console.warn(`WARN: ${message}`);
}

// Loads a .env-style file into process.env without overwriting variables the
// caller already set explicitly (matching dotenv's precedence), so running
// `npm run validate:env` locally picks up a developer's own .env the same
// way `next dev`/`next start` would.
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(`${ROOT}/.env`);

const examplePath = `${ROOT}/.env.example`;

// Every process.env key actually read at runtime for Horizon/RPC endpoint
// resolution, vesting contract ID resolution, and network selection — see
// lib/stellar/network-config.ts, lib/stellar/vesting-config.ts, and
// app/layout.tsx. Keep this in sync with those files: if a var is added
// there but not documented in .env.example, this script should fail.
const RUNTIME_CONTRACT_NETWORK_KEYS = [
  // Network selection (app/layout.tsx)
  "NEXT_PUBLIC_STELLAR_NETWORK",
  // Horizon (lib/stellar/network-config.ts)
  "HORIZON_URL_TESTNET",
  "HORIZON_URL_MAINNET",
  "HORIZON_URL_FUTURENET",
  "NEXT_PUBLIC_HORIZON_URL_TESTNET",
  "NEXT_PUBLIC_HORIZON_URL_MAINNET",
  "NEXT_PUBLIC_HORIZON_URL_FUTURENET",
  // Soroban RPC (lib/stellar/network-config.ts)
  "SOROBAN_RPC_URL_TESTNET",
  "SOROBAN_RPC_URL_MAINNET",
  "SOROBAN_RPC_URL_FUTURENET",
  "NEXT_PUBLIC_SOROBAN_RPC_URL_TESTNET",
  "NEXT_PUBLIC_SOROBAN_RPC_URL_MAINNET",
  "NEXT_PUBLIC_SOROBAN_RPC_URL_FUTURENET",
  // Vesting contract ID (lib/stellar/vesting-config.ts)
  "NEXT_PUBLIC_CONTRACT_ID",
  "CONTRACT_ID",
  "NEXT_PUBLIC_CONTRACT_ID_TESTNET",
  "NEXT_PUBLIC_CONTRACT_ID_MAINNET",
  "NEXT_PUBLIC_CONTRACT_ID_FUTURENET",
  "CONTRACT_ID_TESTNET",
  "CONTRACT_ID_MAINNET",
  "CONTRACT_ID_FUTURENET",
];

if (!existsSync(examplePath)) {
  fail(".env.example is missing");
} else {
  const content = readFileSync(examplePath, "utf8");
  ok(".env.example exists");

  const requiredSections = [
    "Wallet/Signing",
    "Storage",
    "Rate limits",
    "Horizon/RPC",
    "Webhooks",
    "Keeper",
  ];

  for (const section of requiredSections) {
    if (!content.includes(section)) {
      fail(`.env.example is missing section: ${section}`);
    } else {
      ok(`.env.example contains section: ${section}`);
    }
  }

  const missingKeys = RUNTIME_CONTRACT_NETWORK_KEYS.filter((key) => !content.includes(key));
  if (missingKeys.length > 0) {
    fail(
      `.env.example is missing runtime env var(s) used for Horizon/RPC/contract-ID/network resolution: ${missingKeys.join(", ")}`,
    );
  } else {
    ok(".env.example documents every Horizon/RPC/contract-ID/network runtime env var");
  }

  if (/STELLAR_SECRET_KEY\s*=\s*S[A-Z2-7]{55}/.test(content)) {
    fail(".env.example contains a value that looks like a real secret key");
  }

  // Match only an actual `ALLOW_SERVER_SIGNING=true` assignment (commented
  // out or not), not the var name mentioned in unrelated prose elsewhere in
  // a comment (e.g. "...header when ALLOW_SERVER_SIGNING=true (#696)").
  const setsAllowServerSigningTrue = content
    .split("\n")
    .some((line) => /^#?\s*ALLOW_SERVER_SIGNING\s*=\s*true\s*$/.test(line.trim()));
  if (setsAllowServerSigningTrue) {
    fail(".env.example sets ALLOW_SERVER_SIGNING=true without a strong warning");
  }
}

try {
  const tracked = execSync("git ls-files .env .env.local .env.production .env*.local", {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (tracked) {
    fail(`tracked env files: ${tracked}`);
  } else {
    ok("no sensitive .env files tracked by git");
  }
} catch {
  ok("no sensitive .env files tracked by git");
}

try {
  const untracked = execSync("git ls-files --others --exclude-standard .env .env.local .env.production .env*.local", {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (untracked) {
    warn(`untracked env files present (should not be committed): ${untracked.split(/\s+/).join(", ")}`);
  }
} catch {
  // no untracked env files
}

// -----------------------------------------------------------------------------
// Production-profile checks: fail on missing production-critical runtime
// values instead of only checking the static .env.example template. The
// profile is "production" when NODE_ENV=production, or when explicitly
// forced via VALIDATE_ENV_PROFILE=production (useful for CI to test the
// prod path without setting NODE_ENV, which also affects the Next.js build).
// -----------------------------------------------------------------------------
const profile = process.env.VALIDATE_ENV_PROFILE ?? process.env.NODE_ENV ?? "development";

if (profile === "production") {
  ok("running production-profile checks (NODE_ENV/VALIDATE_ENV_PROFILE=production)");

  const rawNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  if (rawNetwork && rawNetwork !== "testnet" && rawNetwork !== "mainnet") {
    fail(
      `NEXT_PUBLIC_STELLAR_NETWORK="${rawNetwork}" is invalid in production. Expected "testnet" or "mainnet".`,
    );
  } else {
    const network = rawNetwork === "mainnet" ? "mainnet" : "testnet";
    if (!rawNetwork) {
      warn('NEXT_PUBLIC_STELLAR_NETWORK is unset; defaulting to "testnet" for this check.');
    } else {
      ok(`NEXT_PUBLIC_STELLAR_NETWORK="${network}"`);
    }

    try {
      resolveVestingContractId(network);
      ok(`vesting contract ID resolves for ${network}`);
    } catch (error) {
      fail((error as Error).message);
    }
  }

  if (process.env.ALLOW_SERVER_SIGNING === "true") {
    if (!process.env.STELLAR_SECRET_KEY) {
      fail("ALLOW_SERVER_SIGNING=true requires STELLAR_SECRET_KEY to be set.");
    } else {
      ok("STELLAR_SECRET_KEY is set");
    }
    if (!process.env.SERVER_SIGNING_API_KEY) {
      fail("ALLOW_SERVER_SIGNING=true requires SERVER_SIGNING_API_KEY to be set.");
    } else {
      ok("SERVER_SIGNING_API_KEY is set");
    }
  }

  const secretBackend = process.env.SECRET_BACKEND ?? "env";
  if (secretBackend === "env") {
    if (!process.env.KEEPER_SECRET) {
      fail("SECRET_BACKEND=env (or unset) requires KEEPER_SECRET to be set.");
    } else {
      ok("KEEPER_SECRET is set");
    }
  } else if (secretBackend === "aws") {
    for (const key of ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      if (!process.env[key]) {
        fail(`SECRET_BACKEND=aws requires ${key} to be set.`);
      } else {
        ok(`${key} is set`);
      }
    }
  } else if (secretBackend === "github") {
    ok("SECRET_BACKEND=github (secret injected by GitHub Actions)");
  } else {
    fail(`Invalid SECRET_BACKEND "${secretBackend}". Expected "env", "aws", or "github".`);
  }

  try {
    const storeIssues = validateStoreConfig(getStoreConfig(process.env));
    for (const issue of storeIssues) {
      if (issue.severity === "error") {
        fail(`${issue.field}: ${issue.message}`);
      } else {
        warn(`${issue.field}: ${issue.message}`);
      }
    }
    if (storeIssues.every((issue) => issue.severity !== "error")) {
      ok("store config (DEPLOYMENT_MODE/JOB_STORE_BACKEND/RATE_LIMIT_BACKEND) is consistent");
    }
  } catch (error) {
    fail((error as Error).message);
  }
} else {
  ok(`skipping production-profile checks (profile="${profile}")`);
}

if (failed) {
  process.exit(1);
}
