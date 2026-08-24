import { test, expect, type Page } from "@playwright/test";

async function expectHealthyPage(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response).not.toBeNull();
  expect(response!.status()).toBeLessThan(500);
}

test.describe("Public marketing pages", () => {
  test("about page renders heading", async ({ page }) => {
    await expectHealthyPage(page, "/about");
    await expect(
      page.getByRole("heading", { name: /about stellar batchpay/i }),
    ).toBeVisible();
  });

  test("pricing page renders heading", async ({ page }) => {
    await expectHealthyPage(page, "/pricing");
    await expect(
      page.getByRole("heading", { name: /simple, transparent/i }),
    ).toBeVisible();
  });

  test("contact page renders message form", async ({ page }) => {
    await expectHealthyPage(page, "/contact");
    await expect(
      page.getByRole("heading", { name: /send us a message/i }),
    ).toBeVisible();
    await expect(page.getByRole("navigation").first()).toBeVisible();
  });

  test("privacy page renders heading", async ({ page }) => {
    await expectHealthyPage(page, "/privacy");
    await expect(page.getByRole("heading", { name: /^privacy$/i })).toBeVisible();
  });

  test("docs page renders heading", async ({ page }) => {
    await expectHealthyPage(page, "/docs");
    await expect(
      page.getByRole("heading", { name: /documentation/i }),
    ).toBeVisible();
  });

  test("demo page renders heading", async ({ page }) => {
    await expectHealthyPage(page, "/demo");
    await expect(
      page.getByRole("heading", { name: /stellar batchpay/i }).first(),
    ).toBeVisible();
  });

  test("sign-in page explains wallet access", async ({ page }) => {
    await expectHealthyPage(page, "/sign-in");
    await expect(
      page.getByRole("heading", { name: /connect your stellar wallet/i }),
    ).toBeVisible();
  });

  test("create-account page renders heading", async ({ page }) => {
    await expectHealthyPage(page, "/create-account");
    await expect(
      page.getByRole("heading", { name: /create your/i }),
    ).toBeVisible();
  });

  test("forgot-password page explains wallet access", async ({ page }) => {
    await expectHealthyPage(page, "/forgot-password");
    await expect(
      page.getByRole("heading", { name: /no password to reset/i }),
    ).toBeVisible();
  });
});
