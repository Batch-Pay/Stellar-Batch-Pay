import { test, expect } from "@playwright/test";
import { WALLET_EMPTY_TITLE } from "./copy";

test.describe("Ungated dashboard routes", () => {
  test("settings page renders without wallet empty state", async ({ page }) => {
    const response = await page.goto("/dashboard/settings");
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(500);
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible();
    await expect(page.getByText(WALLET_EMPTY_TITLE)).toHaveCount(0);
  });

  test("docs page renders without wallet empty state", async ({ page }) => {
    const response = await page.goto("/dashboard/docs");
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(500);
    await expect(
      page.getByRole("heading", { name: /documentation/i }),
    ).toBeVisible();
    await expect(page.getByText(WALLET_EMPTY_TITLE)).toHaveCount(0);
  });
});
