/**
 * scripts/validate-env.ts tests (#746).
 *
 * Runs the script as a real subprocess (same as CI/`npm run validate:env`
 * would) so we exercise the actual exit code and top-level control flow,
 * rather than re-implementing its logic against imported internals.
 *
 * Covers the #746 acceptance criteria:
 *   - .env.example lists every process.env key used for Horizon/RPC/contract ID
 *   - validate:env fails on missing critical prod keys in prod profile
 */

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../scripts/validate-env.ts");

const VALID_CONTRACT_ID =
  "CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ";

// On Windows, npx resolves to npx.cmd, and execFileSync needs shell:true to
// invoke .cmd files directly. Spawning through a shell adds real overhead on
// Windows, so each test below is given a generous 20s timeout.
const NPX_COMMAND = process.platform === "win32" ? "npx.cmd" : "npx";
const TEST_TIMEOUT_MS = 20000;

function run(env: Record<string, string | undefined>): { status: number; output: string } {
  try {
    const output = execFileSync(NPX_COMMAND, ["tsx", SCRIPT], {
      encoding: "utf-8",
      shell: process.platform === "win32",
      // Only pass through the vars the test explicitly sets, plus a minimal
      // PATH, so ambient developer/CI env vars can't leak into a "clean"
      // scenario and make the test flaky. NODE_ENV is intentionally left
      // unset here (VALIDATE_ENV_PROFILE drives the profile instead), cast
      // through unknown since Next's global type augmentation otherwise
      // requires NODE_ENV on every ProcessEnv value.
      env: {
        PATH: process.env.PATH,
        ...env,
      } as unknown as NodeJS.ProcessEnv,
    });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status: number | null; stdout: Buffer; stderr: Buffer };
    return {
      status: err.status ?? 1,
      output: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
    };
  }
}

describe("validate-env.ts (#746)", () => {
  test(
    "passes in the default (non-production) profile against the repo's real .env.example",
    () => {
      const { status, output } = run({});
      expect(output).toContain(
        "OK: .env.example documents every Horizon/RPC/contract-ID/network runtime env var",
      );
      expect(status).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(".env.example documents every Horizon/RPC/contract-ID/network env var the runtime reads", () => {
    const content = readFileSync(path.resolve(__dirname, "../.env.example"), "utf8");
    const requiredKeys = [
      "NEXT_PUBLIC_STELLAR_NETWORK",
      "HORIZON_URL_TESTNET",
      "HORIZON_URL_MAINNET",
      "HORIZON_URL_FUTURENET",
      "NEXT_PUBLIC_HORIZON_URL_TESTNET",
      "NEXT_PUBLIC_HORIZON_URL_MAINNET",
      "NEXT_PUBLIC_HORIZON_URL_FUTURENET",
      "SOROBAN_RPC_URL_TESTNET",
      "SOROBAN_RPC_URL_MAINNET",
      "SOROBAN_RPC_URL_FUTURENET",
      "NEXT_PUBLIC_SOROBAN_RPC_URL_TESTNET",
      "NEXT_PUBLIC_SOROBAN_RPC_URL_MAINNET",
      "NEXT_PUBLIC_SOROBAN_RPC_URL_FUTURENET",
      "NEXT_PUBLIC_CONTRACT_ID",
      "CONTRACT_ID",
      "NEXT_PUBLIC_CONTRACT_ID_TESTNET",
      "NEXT_PUBLIC_CONTRACT_ID_MAINNET",
      "NEXT_PUBLIC_CONTRACT_ID_FUTURENET",
      "CONTRACT_ID_TESTNET",
      "CONTRACT_ID_MAINNET",
      "CONTRACT_ID_FUTURENET",
    ];
    for (const key of requiredKeys) {
      expect(content).toContain(key);
    }
  });

  test(
    "fails in the production profile when no contract ID or keeper secret is configured",
    () => {
      const { status, output } = run({ VALIDATE_ENV_PROFILE: "production" });
      expect(status).toBe(1);
      expect(output).toContain("Vesting contract is not configured for testnet");
      expect(output).toContain("SECRET_BACKEND=env (or unset) requires KEEPER_SECRET");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "fails in the production profile on an invalid NEXT_PUBLIC_STELLAR_NETWORK",
    () => {
      const { status, output } = run({
        VALIDATE_ENV_PROFILE: "production",
        NEXT_PUBLIC_STELLAR_NETWORK: "futurenet",
        KEEPER_SECRET: "dummy",
      });
      expect(status).toBe(1);
      expect(output).toContain(
        'NEXT_PUBLIC_STELLAR_NETWORK="futurenet" is invalid in production',
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "fails in the production profile when ALLOW_SERVER_SIGNING=true but signing secrets are missing",
    () => {
      const { status, output } = run({
        VALIDATE_ENV_PROFILE: "production",
        NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT_ID,
        KEEPER_SECRET: "dummy",
        ALLOW_SERVER_SIGNING: "true",
      });
      expect(status).toBe(1);
      expect(output).toContain("ALLOW_SERVER_SIGNING=true requires STELLAR_SECRET_KEY");
      expect(output).toContain("ALLOW_SERVER_SIGNING=true requires SERVER_SIGNING_API_KEY");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "fails in the production profile when SECRET_BACKEND=aws is missing AWS credentials",
    () => {
      const { status, output } = run({
        VALIDATE_ENV_PROFILE: "production",
        NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT_ID,
        SECRET_BACKEND: "aws",
      });
      expect(status).toBe(1);
      expect(output).toContain("SECRET_BACKEND=aws requires AWS_REGION");
      expect(output).toContain("SECRET_BACKEND=aws requires AWS_ACCESS_KEY_ID");
      expect(output).toContain("SECRET_BACKEND=aws requires AWS_SECRET_ACCESS_KEY");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "passes in the production profile once network, contract ID, and keeper secret are all set",
    () => {
      const { status } = run({
        VALIDATE_ENV_PROFILE: "production",
        NEXT_PUBLIC_STELLAR_NETWORK: "mainnet",
        NEXT_PUBLIC_CONTRACT_ID_MAINNET: VALID_CONTRACT_ID,
        KEEPER_SECRET: "dummy",
      });
      expect(status).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "fails in the production profile when DEPLOYMENT_MODE=ha is missing DATABASE_URL/REDIS_URL",
    () => {
      const { status, output } = run({
        VALIDATE_ENV_PROFILE: "production",
        NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT_ID,
        KEEPER_SECRET: "dummy",
        DEPLOYMENT_MODE: "ha",
      });
      expect(status).toBe(1);
      expect(output).toContain(
        "DATABASE_URL is required when JOB_STORE_BACKEND=postgres in HA mode",
      );
      expect(output).toContain("REDIS_URL is required when RATE_LIMIT_BACKEND=redis in HA mode");
    },
    TEST_TIMEOUT_MS,
  );
});
