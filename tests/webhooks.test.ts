import { describe, expect, test } from 'vitest';
import {
  getWebhooks,
  getWebhooksRedacted,
  registerWebhook,
  unregisterWebhook,
  verifyWebhookSignature,
  validateWebhookUrl,
} from '../lib/webhooks';
import { getDb } from '../lib/job-store';
import crypto from 'crypto';

describe('verifyWebhookSignature (#332)', () => {
  const payload = JSON.stringify({ event: 'batch.created', data: {} });
  const secret = 'test-secret-key';

  // Generate a valid signature
  const validSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  test('accepts valid signature', () => {
    const result = verifyWebhookSignature(payload, secret, validSignature);
    expect(result).toBe(true);
  });

  test('rejects invalid signature (wrong payload)', () => {
    const wrongPayload = JSON.stringify({ event: 'batch.updated', data: {} });
    const result = verifyWebhookSignature(wrongPayload, secret, validSignature);
    expect(result).toBe(false);
  });

  test('rejects invalid signature (wrong secret)', () => {
    const wrongSecret = 'wrong-secret';
    const result = verifyWebhookSignature(payload, wrongSecret, validSignature);
    expect(result).toBe(false);
  });

  // #332: Test malformed signatures without throwing
  test('rejects empty signature gracefully without throwing', () => {
    expect(() => {
      verifyWebhookSignature(payload, secret, '');
    }).not.toThrow();

    const result = verifyWebhookSignature(payload, secret, '');
    expect(result).toBe(false);
  });

  test('rejects null/undefined signature gracefully', () => {
    expect(() => {
      verifyWebhookSignature(payload, secret, null as any);
    }).not.toThrow();

    const result = verifyWebhookSignature(payload, secret, null as any);
    expect(result).toBe(false);
  });

  test('rejects odd-length hex string (malformed)', () => {
    // Odd-length hex is invalid (not a multiple of 2)
    const oddHex = validSignature.slice(0, -1); // Remove last char
    expect(() => {
      verifyWebhookSignature(payload, secret, oddHex);
    }).not.toThrow();

    const result = verifyWebhookSignature(payload, secret, oddHex);
    expect(result).toBe(false);
  });

  test('rejects non-hex characters gracefully', () => {
    const nonHex = 'GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG';
    expect(() => {
      verifyWebhookSignature(payload, secret, nonHex);
    }).not.toThrow();

    const result = verifyWebhookSignature(payload, secret, nonHex);
    expect(result).toBe(false);
  });

  test('rejects wrong-length valid hex (too short)', () => {
    const shortHex = '0000000000000000'; // Valid hex but wrong length
    expect(() => {
      verifyWebhookSignature(payload, secret, shortHex);
    }).not.toThrow();

    const result = verifyWebhookSignature(payload, secret, shortHex);
    expect(result).toBe(false);
  });

  test('rejects truncated signature (length mismatch)', () => {
    const truncated = validSignature.slice(0, 16); // Half length
    expect(() => {
      verifyWebhookSignature(payload, secret, truncated);
    }).not.toThrow();

    const result = verifyWebhookSignature(payload, secret, truncated);
    expect(result).toBe(false);
  });

  test('case-insensitive hex comparison works', () => {
    // Convert valid hex to uppercase
    const upperHex = validSignature.toUpperCase();
    const result = verifyWebhookSignature(payload, secret, upperHex);
    expect(result).toBe(true);
  });

  test('mixed case hex signature works', () => {
    const mixedCase = validSignature
      .split('')
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
      .join('');
    const result = verifyWebhookSignature(payload, secret, mixedCase);
    expect(result).toBe(true);
  });
});

describe('validateWebhookUrl — IP obfuscation blocking (#540)', () => {
  test('accepts a normal HTTPS public URL', () => {
    expect(validateWebhookUrl('https://example.com/hook')).toBeNull();
  });

  test('rejects HTTP (non-HTTPS)', () => {
    expect(validateWebhookUrl('http://example.com/hook')).not.toBeNull();
  });

  test('rejects standard localhost', () => {
    expect(validateWebhookUrl('https://localhost/hook')).not.toBeNull();
  });

  test('rejects dotted-decimal loopback 127.0.0.1', () => {
    expect(validateWebhookUrl('https://127.0.0.1/hook')).not.toBeNull();
  });

  test('rejects dotted-octal loopback 0177.0.0.1', () => {
    // 0177 octal = 127 decimal → resolves to 127.0.0.1
    expect(validateWebhookUrl('https://0177.0.0.1/hook')).not.toBeNull();
  });

  test('rejects dotted-hex loopback 0x7f.0.0.1', () => {
    expect(validateWebhookUrl('https://0x7f.0.0.1/hook')).not.toBeNull();
  });

  test('rejects mixed octal/decimal dotted notation 0177.0.0.0x1', () => {
    expect(validateWebhookUrl('https://0177.0.0.0x1/hook')).not.toBeNull();
  });

  test('rejects monolithic decimal integer 2130706433 (127.0.0.1)', () => {
    expect(validateWebhookUrl('https://2130706433/hook')).not.toBeNull();
  });

  test('rejects monolithic hex 0x7f000001 (127.0.0.1)', () => {
    expect(validateWebhookUrl('https://0x7f000001/hook')).not.toBeNull();
  });

  test('rejects RFC1918 10.x.x.x', () => {
    expect(validateWebhookUrl('https://10.0.0.1/hook')).not.toBeNull();
  });

  test('rejects RFC1918 192.168.x.x', () => {
    expect(validateWebhookUrl('https://192.168.1.1/hook')).not.toBeNull();
  });

  test('rejects link-local 169.254.169.254 (cloud metadata)', () => {
    expect(validateWebhookUrl('https://169.254.169.254/hook')).not.toBeNull();
  });

  test('rejects dotted-octal 192.168 range (0300.0250.x.x)', () => {
    // 0300 = 192, 0250 = 168 in octal
    expect(validateWebhookUrl('https://0300.0250.1.1/hook')).not.toBeNull();
  });
});

describe('webhook registration persistence (#730)', () => {
  test('stores registrations durably and never stores the plaintext secret', () => {
    const secret = 'test-webhook-secret';
    const registration = registerWebhook('https://example.com/webhook', ['batch.completed'], secret);

    try {
      expect(getWebhooks()).toEqual(expect.arrayContaining([registration]));
      expect(getWebhooksRedacted()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: registration.id,
            secretPrefix: secret.slice(0, 8),
          }),
        ]),
      );
      expect(JSON.stringify(getWebhooksRedacted())).not.toContain(secret);

      const row = getDb()
        .prepare('SELECT secretHash, secretCiphertext FROM webhooks WHERE id = ?')
        .get(registration.id) as { secretHash: string; secretCiphertext: string };
      expect(row.secretHash).not.toBe(secret);
      expect(row.secretCiphertext).not.toContain(secret);
    } finally {
      unregisterWebhook(registration.id);
    }
  });
});
