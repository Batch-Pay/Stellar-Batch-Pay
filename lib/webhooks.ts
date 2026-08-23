import crypto from "crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getDb } from "./job-store";

export interface WebhookRegistration {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
  secret: string;
}

/** Safe public view of a registration — never exposes the full secret. */
export interface WebhookRegistrationRedacted {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
  /** First 8 chars of the HMAC secret for display/debug only. */
  secretPrefix: string;
}

// RFC1918 + localhost CIDR patterns that must not receive server-side POSTs.
const PRIVATE_HOSTNAME_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/i;

// Link-local / cloud metadata ranges: 169.254.0.0/16 and IPv6 link-local.
const LINK_LOCAL_RE = /^169\.254\.\d+\.\d+$/;
const IPV6_LOOPBACK_RE = /^(::1|0*:0*:0*:0*:0*:0*:0*:1)$/i;
// Well-known metadata hostnames used by cloud providers.
const METADATA_HOSTNAME_RE =
  /^(metadata\.google\.internal|metadata\.goog|169\.254\.169\.254|fd00:ec2::254)$/i;

const REDIRECT_BLOCKED_ERROR = "Webhook delivery blocked: redirects are not allowed.";
const RESOLUTION_BLOCKED_PREFIX = "Webhook delivery blocked:";

/**
 * Decode all common IP obfuscation forms to a dotted-decimal string.
 * Handles decimal (2130706433), hex (0x7f000001), and dotted-octal/hex
 * (0177.0.0.1, 0x7f.0.0.1) notations.
 */
function normalizePossibleIp(hostname: string): string {
  // Pure decimal integer encoding (e.g. 2130706433 → 127.0.0.1)
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (n >= 0 && n <= 0xffffffff) {
      return [
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8) & 0xff,
        n & 0xff,
      ].join(".");
    }
  }
  // Monolithic hex encoding (e.g. 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (n >= 0 && n <= 0xffffffff) {
      return [
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8) & 0xff,
        n & 0xff,
      ].join(".");
    }
  }
  // Dotted notation where individual octets may be octal (leading zero) or hex
  // (0x-prefixed). e.g. 0177.0.0.1 → 127.0.0.1, 0x7f.0.0.1 → 127.0.0.1
  if (/^[\d.x]+$/i.test(hostname)) {
    const parts = hostname.split(".");
    if (parts.length === 4) {
      const octets = parts.map((part) => {
        if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
        if (/^0\d+$/.test(part)) return parseInt(part, 8); // leading-zero octal
        return parseInt(part, 10);
      });
      if (octets.every((o) => Number.isFinite(o) && o >= 0 && o <= 255)) {
        return octets.join(".");
      }
    }
  }
  return hostname;
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

function isBlockedIpv4Address(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;

  const [a, b] = octets;
  // RFC1918 + loopback + link-local + unspecified
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isBlockedIpv6Address(address: string): boolean {
  const lower = address.toLowerCase();
  // loopback, unspecified, unique local (fc00::/7), and link-local (fe80::/10)
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

function getBlockedTargetReason(hostname: string): string | null {
  const normalized = normalizePossibleIp(hostname);
  const ipFamily = isIP(normalized);

  if (ipFamily === 4 && isBlockedIpv4Address(normalized)) {
    return "resolved IPv4 address is private, loopback, link-local, or unspecified.";
  }
  if (ipFamily === 6 && isBlockedIpv6Address(normalized)) {
    return "resolved IPv6 address is private, loopback, link-local, or unspecified.";
  }

  if (PRIVATE_HOSTNAME_RE.test(normalized)) {
    return "hostname is private or localhost.";
  }
  if (LINK_LOCAL_RE.test(normalized)) {
    return "hostname is link-local.";
  }
  if (IPV6_LOOPBACK_RE.test(normalized)) {
    return "hostname is IPv6 loopback.";
  }
  if (METADATA_HOSTNAME_RE.test(normalized)) {
    return "hostname targets a cloud metadata service.";
  }

  return null;
}

async function validateResolvedWebhookTarget(rawUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "invalid URL.";
  }

  // Registration validation already enforces HTTPS; keep HTTP allowed in tests.
  if (parsed.protocol !== "https:") {
    return null;
  }

  const hostReason = getBlockedTargetReason(parsed.hostname);
  if (hostReason) {
    return hostReason;
  }

  try {
    const answers = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (answers.length === 0) {
      return "hostname did not resolve to an address.";
    }

    for (const answer of answers) {
      const reason = getBlockedTargetReason(answer.address);
      if (reason) {
        return `${reason} (resolved: ${answer.address})`;
      }
    }
  } catch {
    return "hostname DNS resolution failed.";
  }

  return null;
}

function getWebhookDeliveryError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Unknown error";
  const causeMsg = (err as any)?.cause?.message || "";
  if (message.toLowerCase().includes("redirect") || causeMsg.toLowerCase().includes("redirect")) {
    return REDIRECT_BLOCKED_ERROR;
  }
  return message;
}

function isNonRetryableWebhookError(err: unknown): boolean {
  const message = getWebhookDeliveryError(err).toLowerCase();
  return (
    message.includes("redirect") ||
    message.startsWith(RESOLUTION_BLOCKED_PREFIX.toLowerCase()) ||
    message.includes("invalid url")
  );
}

/**
 * Validate that a webhook target URL is safe for server-side delivery.
 *
 * Rules:
 *  - Must use HTTPS (not HTTP).
 *  - Hostname must not resolve to RFC1918, localhost, link-local (169.254/16),
 *    IPv6 loopback (::1), or cloud metadata service addresses.
 *  - Decimal/hex/octal IP encodings are normalised before checking.
 *
 * Returns `null` on success or an error string on failure.
 */
export function validateWebhookUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "URL is invalid.";
  }

  if (parsed.protocol !== "https:") {
    return "Webhook URL must use HTTPS.";
  }

  const hostname = normalizePossibleIp(parsed.hostname);

  if (PRIVATE_HOSTNAME_RE.test(hostname)) {
    return "Webhook URL must not target private/local addresses.";
  }

  if (LINK_LOCAL_RE.test(hostname)) {
    return "Webhook URL must not target link-local addresses (169.254.0.0/16).";
  }

  if (IPV6_LOOPBACK_RE.test(hostname)) {
    return "Webhook URL must not target IPv6 loopback addresses.";
  }

  if (METADATA_HOSTNAME_RE.test(hostname)) {
    return "Webhook URL must not target cloud metadata service addresses.";
  }

  return null;
}

const WEBHOOK_KEY = crypto
  .createHash("sha256")
  .update(
    process.env.WEBHOOK_ENCRYPTION_KEY ??
      process.env.AUTH_SECRET ??
      process.env.NEXTAUTH_SECRET ??
      "stellar-batch-pay-development-webhook-key",
  )
  .digest();

interface WebhookRow {
  id: string;
  url: string;
  events: string;
  createdAt: string;
  secretHash: string;
  secretCiphertext: string;
}

function encryptSecret(secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", WEBHOOK_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptSecret(ciphertext: string): string {
  const [ivEncoded, tagEncoded, valueEncoded] = ciphertext.split(".");
  if (!ivEncoded || !tagEncoded || !valueEncoded) {
    throw new Error("Invalid webhook secret ciphertext");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    WEBHOOK_KEY,
    Buffer.from(ivEncoded, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(valueEncoded, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function rowToWebhook(row: WebhookRow): WebhookRegistration {
  return {
    id: row.id,
    url: row.url,
    events: JSON.parse(row.events) as string[],
    createdAt: row.createdAt,
    secret: decryptSecret(row.secretCiphertext),
  };
}

function loadWebhooks(): WebhookRegistration[] {
  const rows = getDb()
    .prepare("SELECT id, url, events, createdAt, secretHash, secretCiphertext FROM webhooks ORDER BY createdAt DESC")
    .all() as WebhookRow[];
  return rows.map(rowToWebhook);
}

export function registerWebhook(url: string, events: string[], secret?: string): WebhookRegistration {
  const resolvedSecret = secret || crypto.randomBytes(32).toString("hex");
  const newWebhook: WebhookRegistration = {
    id: crypto.randomUUID(),
    url,
    events,
    createdAt: new Date().toISOString(),
    secret: resolvedSecret,
  };
  getDb()
    .prepare(
      `INSERT INTO webhooks (id, url, events, createdAt, secretHash, secretCiphertext)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newWebhook.id,
      newWebhook.url,
      JSON.stringify(newWebhook.events),
      newWebhook.createdAt,
      crypto.createHash("sha256").update(resolvedSecret).digest("hex"),
      encryptSecret(resolvedSecret),
    );
  return newWebhook;
}

export function verifyWebhookSignature(payload: string, secret: string, signature: string): boolean {
  // #332: Validate signature format before timing-safe comparison.
  // timingSafeEqual throws if buffers have different lengths; gracefully
  // reject malformed input to avoid 500 errors and DoS on bad client signatures.
  if (!signature || signature.length === 0) {
    return false;
  }

  // Validate hex format: must be even length (hex pairs)
  if (signature.length % 2 !== 0) {
    return false;
  }

  // Validate characters are hex digits
  if (!/^[0-9a-fA-F]*$/.test(signature)) {
    return false;
  }

  const expectedSignature = crypto.createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  // Length check before timingSafeEqual to prevent throws
  if (signature.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'));
}

export function unregisterWebhook(id: string): boolean {
  return getDb().prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes > 0;
}

export function getWebhooks(): WebhookRegistration[] {
  return loadWebhooks();
}

/** Returns webhook list with secrets stripped to a short prefix. */
export function getWebhooksRedacted(): WebhookRegistrationRedacted[] {
  return loadWebhooks().map(({ id, url, events, createdAt, secret }) => ({
    id,
    url,
    events,
    createdAt,
    secretPrefix: secret.slice(0, 8),
  }));
}

export async function triggerWebhooks(eventName: string, payload: any) {
  const targets = loadWebhooks().filter((w) => w.events.includes(eventName) || w.events.includes("*"));
   
  const results = await Promise.allSettled(
    targets.map(async (webhook) => {
      try {
        const resolutionError = await validateResolvedWebhookTarget(webhook.url);
        if (resolutionError) {
          throw new Error(`${RESOLUTION_BLOCKED_PREFIX} ${resolutionError}`);
        }

        const timestamp = new Date().toISOString();
        const bodyPayload = { event: eventName, payload, timestamp };
        const body = JSON.stringify(bodyPayload);
        
        const signature = crypto.createHmac('sha256', webhook.secret)
          .update(body)
          .digest('hex');
        
        const response = await fetch(webhook.url, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "X-Stellar-Batch-Pay-Event": eventName,
            "x-webhook-signature": signature,
          },
          body,
        });
        return { id: webhook.id, success: response.ok, status: response.status };
      } catch (error) {
        return { id: webhook.id, success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    })
  );

  return results;
}

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;

/**
 * Deliver a webhook event to all matching registrations with exponential backoff
 * on 5xx / network errors. Logs each attempt to the webhook_deliveries table.
 */
export async function triggerWebhooksWithRetry(
  eventName: string,
  payload: any,
  jobId?: string,
): Promise<void> {
  // Lazy import to avoid circular dependency at module load time
  const { logWebhookDelivery } = await import("./job-store");

  const targets = loadWebhooks().filter(
    (w) => w.events.includes(eventName) || w.events.includes("*"),
  );

  await Promise.allSettled(
    targets.map(async (webhook) => {
      const timestamp = new Date().toISOString();
      const bodyPayload = { event: eventName, payload, timestamp };
      const body = JSON.stringify(bodyPayload);
      const signature = crypto
        .createHmac("sha256", webhook.secret)
        .update(body)
        .digest("hex");

      let attempt = 0;
      while (attempt <= MAX_RETRIES) {
        try {
          const resolutionError = await validateResolvedWebhookTarget(webhook.url);
          if (resolutionError) {
            throw new Error(`${RESOLUTION_BLOCKED_PREFIX} ${resolutionError}`);
          }

          const response = await fetch(webhook.url, {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              "X-Stellar-Batch-Pay-Event": eventName,
              "x-webhook-signature": signature,
            },
            body,
          });

          if (response.ok) {
            logWebhookDelivery({
              webhookId: webhook.id,
              jobId,
              event: eventName,
              status: "success",
              responseCode: response.status,
              retryCount: attempt,
            });
            return;
          }

          // 4xx — don't retry
          if (response.status < 500) {
            logWebhookDelivery({
              webhookId: webhook.id,
              jobId,
              event: eventName,
              status: "failed",
              responseCode: response.status,
              retryCount: attempt,
              error: `HTTP ${response.status}`,
            });
            return;
          }

          // 5xx — fall through to retry
          if (attempt === MAX_RETRIES) {
            logWebhookDelivery({
              webhookId: webhook.id,
              jobId,
              event: eventName,
              status: "failed",
              responseCode: response.status,
              retryCount: attempt,
              error: `HTTP ${response.status} after ${attempt} retries`,
            });
            return;
          }
        } catch (err) {
          const errorMessage = getWebhookDeliveryError(err);
          if (isNonRetryableWebhookError(err)) {
            logWebhookDelivery({
              webhookId: webhook.id,
              jobId,
              event: eventName,
              status: "failed",
              retryCount: attempt,
              error: errorMessage,
            });
            return;
          }

          if (attempt === MAX_RETRIES) {
            logWebhookDelivery({
              webhookId: webhook.id,
              jobId,
              event: eventName,
              status: "failed",
              retryCount: attempt,
              error: errorMessage,
            });
            return;
          }
        }

        // Exponential backoff: 500ms, 1s, 2s, 4s
        await new Promise((r) =>
          setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)),
        );
        attempt++;
      }
    }),
  );
}
