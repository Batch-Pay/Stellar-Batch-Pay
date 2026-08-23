/**
 * Unit tests for the production guard in lib/secrets/index.ts (#734).
 *
 * Acceptance criteria:
 *   - Production boot fails fast on SECRET_BACKEND=env without explicit override
 *   - ALLOW_ENV_SECRETS_IN_PROD=true allows env backend but logs a warning
 *   - Non-production environments are unaffected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Save and restore the env vars touched by tests. */
const WATCHED_VARS = [
  'NODE_ENV',
  'BATCHPAY_ENV',
  'SECRET_BACKEND',
  'ALLOW_ENV_SECRETS_IN_PROD',
] as const;

type WatchedVar = (typeof WATCHED_VARS)[number];

let saved: Partial<Record<WatchedVar, string | undefined>>;

beforeEach(() => {
  saved = {};
  for (const key of WATCHED_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Reset module registry so each test gets a freshly-evaluated module.
  vi.resetModules();
});

afterEach(() => {
  for (const key of WATCHED_VARS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

async function importSecrets() {
  return import('../lib/secrets/index');
}

// ── isProductionEnv ───────────────────────────────────────────────────────────

describe('isProductionEnv()', () => {
  it('returns true when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const { isProductionEnv } = await importSecrets();
    expect(isProductionEnv()).toBe(true);
  });

  it('returns true when BATCHPAY_ENV=production', async () => {
    process.env.BATCHPAY_ENV = 'production';
    const { isProductionEnv } = await importSecrets();
    expect(isProductionEnv()).toBe(true);
  });

  it('returns false when neither NODE_ENV nor BATCHPAY_ENV is production', async () => {
    process.env.NODE_ENV = 'development';
    const { isProductionEnv } = await importSecrets();
    expect(isProductionEnv()).toBe(false);
  });

  it('returns false when both vars are unset', async () => {
    const { isProductionEnv } = await importSecrets();
    expect(isProductionEnv()).toBe(false);
  });
});

// ── assertEnvBackendAllowed ───────────────────────────────────────────────────

describe('assertEnvBackendAllowed()', () => {
  it('throws in production without the override', async () => {
    process.env.NODE_ENV = 'production';
    const { assertEnvBackendAllowed } = await importSecrets();

    expect(() => assertEnvBackendAllowed()).toThrow(
      'SECRET_BACKEND=env is not allowed in production',
    );
  });

  it('throws in production even when BATCHPAY_ENV drives the detection', async () => {
    process.env.BATCHPAY_ENV = 'production';
    const { assertEnvBackendAllowed } = await importSecrets();

    expect(() => assertEnvBackendAllowed()).toThrow(
      'SECRET_BACKEND=env is not allowed in production',
    );
  });

  it('throws with a message that mentions the override flag', async () => {
    process.env.NODE_ENV = 'production';
    const { assertEnvBackendAllowed } = await importSecrets();

    expect(() => assertEnvBackendAllowed()).toThrow('ALLOW_ENV_SECRETS_IN_PROD=true');
  });

  it('does NOT throw in production when ALLOW_ENV_SECRETS_IN_PROD=true', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_ENV_SECRETS_IN_PROD = 'true';
    const { assertEnvBackendAllowed } = await importSecrets();

    expect(() => assertEnvBackendAllowed()).not.toThrow();
  });

  it('logs a warning when the emergency override is active', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_ENV_SECRETS_IN_PROD = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { assertEnvBackendAllowed } = await importSecrets();

    assertEnvBackendAllowed();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ALLOW_ENV_SECRETS_IN_PROD=true'),
    );
    warnSpy.mockRestore();
  });

  it('does NOT throw outside of production', async () => {
    process.env.NODE_ENV = 'development';
    const { assertEnvBackendAllowed } = await importSecrets();

    expect(() => assertEnvBackendAllowed()).not.toThrow();
  });

  it('does NOT throw when env vars are unset (local dev fallback)', async () => {
    // NODE_ENV and BATCHPAY_ENV are both deleted in beforeEach
    const { assertEnvBackendAllowed } = await importSecrets();

    expect(() => assertEnvBackendAllowed()).not.toThrow();
  });
});

// ── createSecretsProvider ─────────────────────────────────────────────────────

describe('createSecretsProvider() — env backend', () => {
  it('throws in production when SECRET_BACKEND=env', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SECRET_BACKEND = 'env';
    const { createSecretsProvider } = await importSecrets();

    await expect(createSecretsProvider()).rejects.toThrow(
      'SECRET_BACKEND=env is not allowed in production',
    );
  });

  it('throws in production when SECRET_BACKEND is unset (defaults to env)', async () => {
    process.env.NODE_ENV = 'production';
    // SECRET_BACKEND is deleted in beforeEach
    const { createSecretsProvider } = await importSecrets();

    await expect(createSecretsProvider()).rejects.toThrow(
      'SECRET_BACKEND=env is not allowed in production',
    );
  });

  it('resolves successfully in production when ALLOW_ENV_SECRETS_IN_PROD=true', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SECRET_BACKEND = 'env';
    process.env.ALLOW_ENV_SECRETS_IN_PROD = 'true';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createSecretsProvider } = await importSecrets();

    const provider = await createSecretsProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.fetchSecret).toBe('function');
  });

  it('resolves successfully in development without any override', async () => {
    process.env.NODE_ENV = 'development';
    process.env.SECRET_BACKEND = 'env';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createSecretsProvider } = await importSecrets();

    const provider = await createSecretsProvider();
    expect(provider).toBeDefined();
  });

  it('still logs the local-dev warning in non-production', async () => {
    process.env.NODE_ENV = 'development';
    process.env.SECRET_BACKEND = 'env';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createSecretsProvider } = await importSecrets();

    await createSecretsProvider();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('only safe for local development'),
    );
    warnSpy.mockRestore();
  });
});

describe('createSecretsProvider() — aws backend', () => {
  it('does not apply the env-backend guard when SECRET_BACKEND=aws', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SECRET_BACKEND = 'aws';
    process.env.AWS_REGION = 'us-east-1';

    // The AwsSecretsProvider constructor doesn't throw; only fetchSecret does.
    vi.resetModules();
    vi.doMock('@aws-sdk/client-secrets-manager', () => ({
      SecretsManagerClient: class {
        send() { return Promise.resolve({ SecretString: 'val' }); }
      },
      GetSecretValueCommand: class { constructor(public _input: unknown) {} },
    }));

    const { createSecretsProvider } = await importSecrets();
    const provider = await createSecretsProvider();
    expect(provider).toBeDefined();

    delete process.env.AWS_REGION;
    vi.doUnmock('@aws-sdk/client-secrets-manager');
  });
});

describe('createSecretsProvider() — github backend', () => {
  it('does not apply the env-backend guard when SECRET_BACKEND=github', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SECRET_BACKEND = 'github';
    const { createSecretsProvider } = await importSecrets();

    const provider = await createSecretsProvider();
    expect(provider).toBeDefined();
  });
});
