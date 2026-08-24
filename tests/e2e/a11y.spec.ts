import { test, expect } from "@playwright/test";

test.describe("Skip to main content", () => {
  test("home page exposes a skip link to main content", async ({ page }) => {
    await page.goto("/");
    const skip = page.getByRole("link", { name: /skip to main content/i }).first();
    await expect(skip).toHaveAttribute("href", "#main-content");
    await expect(page.locator("main#main-content")).toHaveCount(1);
  });

  test("dashboard page exposes a skip link and main landmark", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const skip = page.getByRole("link", { name: /skip to main content/i }).first();
    await expect(skip).toHaveAttribute("href", "#main-content");
    await expect(page.locator("main#main-content")).toHaveCount(1);
  });
});
