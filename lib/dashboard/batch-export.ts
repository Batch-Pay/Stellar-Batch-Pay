/**
 * Per-batch export helpers (#311).
 *
 * Produces CSV and printable-HTML payloads from a single job's
 * recipient list so accounting / payroll workflows can pull a
 * record without depending on a block explorer. The HTML output
 * is print-friendly — operators "Print → Save as PDF" to satisfy
 * the issue's PDF acceptance criterion without pulling a PDF lib.
 */

export interface BatchExportRecipient {
  address: string;
  amount: string;
  asset: string;
  status: "pending" | "success" | "failed" | "unknown";
  transactionHash?: string;
  error?: string;
}

export interface BatchExportRow {
  address: string;
  amount: string;
  asset: string;
  status: string;
  transactionHash: string;
  timestamp: string;
}

interface JobLikeShape {
  recipients?: BatchExportRecipient[];
  createdAt?: string;
  completedAt?: string;
}

export function buildBatchExportRows(job: JobLikeShape): BatchExportRow[] {
  const ts = job.completedAt ?? job.createdAt ?? "";
  return (job.recipients ?? []).map((r) => ({
    address: r.address,
    amount: r.amount,
    asset: r.asset,
    status: r.status,
    transactionHash: r.transactionHash ?? "",
    timestamp: ts,
  }));
}

function csvEscape(value: string): string {
  // RFC 4180: any field containing ", \r, \n, or , must be quoted; "
  // inside a quoted field is doubled. Also defend against CSV-injection
  // by prefixing leading =, +, -, @ with a single quote.
  let v = value;
  if (v.length > 0 && /^[=+\-@]/.test(v)) {
    v = `'${v}`;
  }
  if (/[",\r\n]/.test(v)) {
    v = `"${v.replaceAll('"', '""')}"`;
  }
  return v;
}

export function toBatchExportCsv(rows: BatchExportRow[]): string {
  const header = ["Address", "Amount", "Asset", "Status", "Transaction hash", "Timestamp"];
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push(
      [r.address, r.amount, r.asset, r.status, r.transactionHash, r.timestamp]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function htmlEscape(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function explorerHref(hash: string, network: "testnet" | "mainnet"): string {
  const base =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${encodeURIComponent(hash)}`;
}

export function toBatchExportHtml(
  rows: BatchExportRow[],
  jobId: string,
  network: "testnet" | "mainnet",
): string {
  const body = rows
    .map(
      (r) => `
        <tr>
          <td>${htmlEscape(r.address)}</td>
          <td>${htmlEscape(r.amount)}</td>
          <td>${htmlEscape(r.asset)}</td>
          <td>${htmlEscape(r.status)}</td>
          <td>${
            r.transactionHash
              ? `<a href="${htmlEscape(explorerHref(r.transactionHash, network))}">${htmlEscape(r.transactionHash)}</a>`
              : "&mdash;"
          }</td>
          <td>${htmlEscape(r.timestamp)}</td>
        </tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>BatchPay export — ${htmlEscape(jobId)}</title>
    <style>
      body { font-family: -apple-system, sans-serif; padding: 24px; color: #1F2937; }
      h1 { margin: 0 0 8px; }
      .meta { color: #6B7280; font-size: 12px; margin-bottom: 16px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border-bottom: 1px solid #E5E7EB; padding: 6px 8px; text-align: left; vertical-align: top; }
      th { background: #F9FAFB; }
      .print-button { float: right; }
      @media print { .print-button { display: none; } }
    </style>
  </head>
  <body>
    <button class="print-button" onclick="window.print()">Print / Save as PDF</button>
    <h1>BatchPay export</h1>
    <p class="meta">Job <code>${htmlEscape(jobId)}</code> · ${htmlEscape(network)} · ${rows.length} recipients</p>
    <table>
      <thead>
        <tr>
          <th>Address</th><th>Amount</th><th>Asset</th><th>Status</th><th>Transaction hash</th><th>Timestamp</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </body>
</html>`;
}
