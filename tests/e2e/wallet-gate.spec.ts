import { test, expect } from "@playwright/test";
import { WALLET_EMPTY_TITLE } from "./copy";

const gatedRoutes = [
  "/dashboard",
  "/dashboard/history",
  "/dashboard/new-batch",
  "/dashboard/analytics",
  "/dashboard/vesting",
  "/dashboard/address-book",
] as const;

test.describe("Dashboard wallet gate", () => {
  for (const route of gatedRoutes) {
    test(`${route} shows connect-wallet empty state`, async ({ page }) => {
      const response = await page.goto(route);
      expect(response).not.toBeNull();
      expect(response!.status()).toBeLessThan(500);
      await expect(page.getByText(WALLET_EMPTY_TITLE)).toBeVisible();
    });
  }

  test("empty-state settings link goes to settings", async ({ page }) => {
    await page.goto("/dashboard");
    await page
      .locator("main#main-content")
      .getByRole("link", { name: /^settings$/i })
      .click();
    await expect(page).toHaveURL(/\/dashboard\/settings/);
  });
});
