import { test, expect } from "@playwright/test";
import { WALLET_EMPTY_DESCRIPTION, WALLET_EMPTY_TITLE } from "./copy";

test.describe("Insufficient Balance", () => {
  test("new-batch empty state points users to connect a wallet", async ({
    page,
  }) => {
    const response = await page.goto("/dashboard/new-batch");
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(500);

    await expect(
      page.getByText(WALLET_EMPTY_TITLE),
    ).toBeVisible();
    await expect(
      page.getByText(WALLET_EMPTY_DESCRIPTION),
    ).toBeVisible();
    await expect(
      page.locator("#main-content").getByRole("link", { name: /^settings$/i }),
    ).toBeVisible();
  });
});
