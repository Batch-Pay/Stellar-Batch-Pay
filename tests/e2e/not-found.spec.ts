import { test, expect } from "@playwright/test";

test.describe("Not found page", () => {
  test("unknown route shows page not found", async ({ page }) => {
    const response = await page.goto("/this-page-does-not-exist");
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: /page not found/i }),
    ).toBeVisible();
  });

  test("homepage link returns to landing", async ({ page }) => {
    await page.goto("/this-page-does-not-exist");
    await page.getByRole("link", { name: /go to homepage/i }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("dashboard link returns to dashboard", async ({ page }) => {
    await page.goto("/this-page-does-not-exist");
    await page.getByRole("link", { name: /return to dashboard/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
