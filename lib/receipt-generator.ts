import type { BatchResult } from "@/lib/stellar/types";
import { escapeHtml } from "@/lib/utils";
import { sumStellarAmounts, formatStellarAmount } from "@/lib/stellar/utils";

interface ReceiptData {
  batchResult: BatchResult;
  generatedAt: string;
  receiptId: string;
}

export function generateReceiptHtml(batchResult: BatchResult): string {
  const receiptId = crypto.randomUUID();
  const generatedAt = new Date().toISOString();

  const successfulPayments = batchResult.results.filter(r => r.status === "success");
  const failedPayments = batchResult.results.filter(r => r.status === "failed");

  const assetGroups: Record<string, string[]> = {};
  for (const payment of successfulPayments) {
    const asset = payment.asset || "XLM";
    if (!assetGroups[asset]) {
      assetGroups[asset] = [];
    }
    assetGroups[asset].push(payment.amount || "0");
  }

  const successfulTotals = Object.entries(assetGroups).map(([asset, amounts]) => ({
    asset,
    total: formatStellarAmount(sumStellarAmounts(amounts)),
  }));

  let totalAmountHtml = "";
  let totalAmountLabel = "";

  if (successfulTotals.length === 0) {
    totalAmountHtml = `<div class="number">0.0000000</div>`;
    totalAmountLabel = `<div class="label">Total Amount (XLM)</div>`;
  } else if (successfulTotals.length === 1) {
    const { asset, total } = successfulTotals[0];
    if (asset.includes(':')) {
      totalAmountHtml = `<div class="number" style="font-size: 14px; line-height: 1.3; padding-top: 5px;">${total} ${asset}</div>`;
      totalAmountLabel = `<div class="label">Total Amount</div>`;
    } else {
      totalAmountHtml = `<div class="number">${total}</div>`;
      totalAmountLabel = `<div class="label">Total Amount (${asset})</div>`;
    }
  } else {
    totalAmountHtml = `<div class="number" style="font-size: 14px; line-height: 1.3; padding-top: 5px;">${successfulTotals.map(t => `${t.total} ${t.asset}`).join('<br/>')}</div>`;
    totalAmountLabel = `<div class="label">Total Amount</div>`;
  }


  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Batch Payment Receipt - ${receiptId.slice(0, 8)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .receipt { max-width: 800px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { text-align: center; border-bottom: 2px solid #0B0F1A; padding-bottom: 20px; margin-bottom: 30px; }
    .header h1 { color: #0B0F1A; margin: 0; }
    .header p { color: #666; margin: 5px 0; }
    .section { margin-bottom: 30px; }
    .section h2 { color: #0B0F1A; font-size: 18px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; }
    .field { background: #f9f9f9; padding: 12px; border-radius: 4px; }
    .field label { display: block; font-size: 12px; color: #666; margin-bottom: 4px; }
    .field value { font-size: 14px; font-weight: 600; color: #0B0F1A; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th { background: #0B0F1A; color: white; padding: 12px; text-align: left; font-size: 12px; }
    td { padding: 12px; border-bottom: 1px solid #eee; font-size: 13px; }
    .success { color: #10b981; }
    .failed { color: #ef4444; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-top: 20px; }
    .summary-box { background: #f9f9f9; padding: 15px; border-radius: 4px; text-align: center; }
    .summary-box .number { font-size: 24px; font-weight: bold; color: #0B0F1A; }
    .summary-box .label { font-size: 12px; color: #666; }
    .footer { text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="receipt">
    <div class="header">
      <h1>Stellar BatchPay</h1>
      <p>Batch Payment Receipt</p>
      <p>Receipt ID: ${receiptId}</p>
    </div>

    <div class="section">
      <h2>Batch Summary</h2>
      <div class="summary">
        <div class="summary-box">
          <div class="number">${batchResult.totalRecipients}</div>
          <div class="label">Total Recipients</div>
        </div>
        <div class="summary-box">
          <div class="number">${batchResult.summary.successful}</div>
          <div class="label">Successful</div>
        </div>
        <div class="summary-box">
          <div class="number">${batchResult.summary.failed}</div>
          <div class="label">Failed</div>
        </div>
        <div class="summary-box">
          ${totalAmountHtml}
          ${totalAmountLabel}
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Transaction Details</h2>
      <div class="grid">
        <div class="field">
          <label>Network</label>
          <value>${escapeHtml(String(batchResult.network))}</value>
        </div>
        <div class="field">
          <label>Timestamp</label>
          <value>${new Date(batchResult.timestamp).toLocaleString()}</value>
        </div>
        <div class="field">
          <label>Total Transactions</label>
          <value>${batchResult.totalTransactions}</value>
        </div>
        <div class="field">
          <label>Generated At</label>
          <value>${new Date(generatedAt).toLocaleString()}</value>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Payment Details</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Recipient</th>
            <th>Amount</th>
            <th>Asset</th>
            <th>Status</th>
            <th>Transaction Hash</th>
          </tr>
        </thead>
        <tbody>
          ${batchResult.results.map((payment, idx) => `
            <tr>
              <td>${idx + 1}</td>
              <td><code style="font-size:11px">${escapeHtml(String(payment.recipient))}</code></td>
              <td>${escapeHtml(String(payment.amount))}</td>
              <td>${escapeHtml(String(payment.asset))}</td>
              <td class="${escapeHtml(String(payment.status))}">${escapeHtml(String(payment.status))}</td>
              <td><code style="font-size:10px">${escapeHtml(String(payment.transactionHash || "N/A"))}</code></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>

    ${failedPayments.length > 0 ? `
    <div class="section">
      <h2>Failed Payments</h2>
      <table>
        <thead>
          <tr>
            <th>Recipient</th>
            <th>Amount</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          ${failedPayments.map((payment) => `
            <tr>
              <td><code style="font-size:11px">${escapeHtml(String(payment.recipient))}</code></td>
              <td>${escapeHtml(String(payment.amount))}</td>
              <td style="color:#ef4444">${escapeHtml(String(payment.error || "Unknown error"))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ` : ""}

    <div class="footer">
      <p>This receipt was generated by Stellar BatchPay</p>
      <p>Verify transactions on <a href="https://stellar.expert/explorer/${batchResult.network === 'testnet' ? 'testnet' : 'public'}" target="_blank">Stellar Expert</a></p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

export function generateReceiptText(batchResult: BatchResult): string {
  const successfulPayments = batchResult.results.filter(r => r.status === "success");

  const assetGroups: Record<string, string[]> = {};
  for (const payment of successfulPayments) {
    const asset = payment.asset || "XLM";
    if (!assetGroups[asset]) {
      assetGroups[asset] = [];
    }
    assetGroups[asset].push(payment.amount || "0");
  }

  const successfulTotals = Object.entries(assetGroups).map(([asset, amounts]) => ({
    asset,
    total: formatStellarAmount(sumStellarAmounts(amounts)),
  }));

  const totalAmountText = successfulTotals.length > 0
    ? successfulTotals.map(t => `${t.total} ${t.asset}`).join(", ")
    : "0.0000000 XLM";

  let text = `Stellar BatchPay - Batch Payment Receipt\n`;
  text += `${"=".repeat(50)}\n\n`;
  text += `Generated: ${new Date().toLocaleString()}\n`;
  text += `Network: ${batchResult.network}\n`;
  text += `Timestamp: ${new Date(batchResult.timestamp).toLocaleString()}\n\n`;

  text += `SUMMARY\n`;
  text += `${"-".repeat(30)}\n`;
  text += `Total Recipients: ${batchResult.totalRecipients}\n`;
  text += `Successful: ${batchResult.summary.successful}\n`;
  text += `Failed: ${batchResult.summary.failed}\n`;
  text += `Total Amount: ${totalAmountText}\n\n`;

  text += `PAYMENT DETAILS\n`;
  text += `${"-".repeat(30)}\n`;
  batchResult.results.forEach((payment, idx) => {
    text += `${idx + 1}. ${payment.recipient}\n`;
    text += `   Amount: ${payment.amount} ${payment.asset}\n`;
    text += `   Status: ${payment.status}\n`;
    if (payment.transactionHash) {
      text += `   Hash: ${payment.transactionHash}\n`;
    }
    if (payment.error) {
      text += `   Error: ${payment.error}\n`;
    }
    text += `\n`;
  });

  return text;
}

export function downloadReceipt(batchResult: BatchResult, format: "html" | "text" = "html") {
  const timestamp = new Date(batchResult.timestamp).toISOString().split("T")[0];
  const filename = `batch-receipt-${timestamp}`;

  if (format === "html") {
    const html = generateReceiptHtml(batchResult);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.html`;
    a.click();
    URL.revokeObjectURL(url);
  } else {
    const text = generateReceiptText(batchResult);
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

export function downloadReceiptCsv(batchResult: BatchResult) {
  const timestamp = new Date(batchResult.timestamp).toISOString().split("T")[0];
  const filename = `batch-receipt-${timestamp}.csv`;

  const headers = ["Recipient", "Amount", "Asset", "Status", "Transaction Hash", "Error"];

  const rows = batchResult.results.map(p =>
    [p.recipient, p.amount, p.asset, p.status, p.transactionHash || "N/A", p.error || ""]
      .map(v => `"${v.replace(/"/g, '""')}"`)
      .join(",")
  );

  const csv = [headers.map(h => `"${h}"`).join(","), ...rows].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
