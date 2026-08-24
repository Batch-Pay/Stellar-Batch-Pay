import { test, expect } from "@playwright/test";

const sidebarLinks = [
  { name: /^dashboard$/i, path: "/dashboard" },
  { name: /new batch payment/i, path: "/dashboard/new-batch" },
  { name: /batch history/i, path: "/dashboard/history" },
  { name: /^analytics$/i, path: "/dashboard/analytics" },
  { name: /batch vesting/i, path: "/dashboard/vesting" },
  { name: /address book/i, path: "/dashboard/address-book" },
  { name: /^settings$/i, path: "/dashboard/settings" },
  { name: /documentation/i, path: "/dashboard/docs" },
] as const;

test.describe("Dashboard sidebar navigation", () => {
  for (const link of sidebarLinks) {
    test(`navigates to ${link.path}`, async ({ page }) => {
      await page.goto("/dashboard");
      await page
        .locator('[data-sidebar="menu"]')
        .getByRole("link", { name: link.name })
        .click();
      await expect(page).toHaveURL(new RegExp(`${link.path}/?$`));
    });
  }
});
