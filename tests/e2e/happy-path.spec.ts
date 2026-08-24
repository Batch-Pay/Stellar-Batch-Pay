import { test, expect } from "@playwright/test";
import { WALLET_EMPTY_TITLE } from "./copy";

test.describe("Batch Payment Happy Path", () => {
  test("new-batch route loads with sidebar and wallet empty state", async ({
    page,
  }) => {
    const response = await page.goto("/dashboard/new-batch");
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(500);

    await expect(page).toHaveTitle(/New Batch/);

    await expect(
      page.getByRole("link", { name: /new batch payment/i }),
    ).toBeVisible();

    await expect(
      page.getByText(WALLET_EMPTY_TITLE),
    ).toBeVisible();
  });
});
