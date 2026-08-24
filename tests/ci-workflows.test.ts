/**
 * Merge-gating guards for #738.
 *
 * The e2e workflow must invoke Playwright with a tool that exists after
 * `npm ci` on a Node-only runner. `bunx` is not present unless Bun is
 * installed, and this repo's packageManager is npm.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const E2E_WORKFLOW = path.join(
  process.cwd(),
  ".github",
  "workflows",
  "e2e.yml",
);
const PLAYWRIGHT_CONFIG = path.join(process.cwd(), "playwright.config.ts");
const PACKAGE_JSON = path.join(process.cwd(), "package.json");

const e2eYaml = readFileSync(E2E_WORKFLOW, "utf8");
const playwrightConfig = readFileSync(PLAYWRIGHT_CONFIG, "utf8");
const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
  packageManager?: string;
  scripts?: Record<string, string>;
};

describe("e2e workflow uses npm-native playwright (#738)", () => {
  test("packageManager is npm", () => {
    expect(packageJson.packageManager).toMatch(/^npm@/);
  });

  test("does not invoke bunx or setup-bun", () => {
    expect(e2eYaml).not.toMatch(/\bbunx\b/);
    expect(e2eYaml).not.toMatch(/oven-sh\/setup-bun/);
    expect(e2eYaml).not.toMatch(/\bbun run\b/);
  });

  test("installs playwright browsers with npx after npm ci", () => {
    expect(e2eYaml).toMatch(/npm ci/);
    expect(e2eYaml).toMatch(/npx playwright install --with-deps chromium/);
  });

  test("runs the package.json e2e script", () => {
    expect(packageJson.scripts?.["test:e2e"]).toBe("playwright test");
    expect(e2eYaml).toMatch(/npm run test:e2e/);
  });

  test("defines an e2e job", () => {
    expect(e2eYaml).toMatch(/^ {2}e2e:/m);
  });
});

describe("playwright local server uses npm (#738)", () => {
  test("webServer command is npm run dev", () => {
    expect(playwrightConfig).toMatch(/command:\s*"npm run dev"/);
    expect(playwrightConfig).not.toMatch(/bun run dev/);
  });
});
