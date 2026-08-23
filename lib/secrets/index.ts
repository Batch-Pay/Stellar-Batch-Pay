/**
 * Secret management factory for the Keeper bot (#257).
 *
 * Selects the backend at runtime via SECRET_BACKEND env var:
 *   SECRET_BACKEND=aws    → AWS Secrets Manager
 *   SECRET_BACKEND=github → GitHub Actions secret (env-injected at runtime)
 *   SECRET_BACKEND=env    → .env file (local dev only — prints a warning)
 *
 * All backends expose the same interface: fetchSecret(name) → string
 *
 * Production safety (#734):
 *   SECRET_BACKEND=env (or unset) is rejected when NODE_ENV=production or
 *   BATCHPAY_ENV=production unless ALLOW_ENV_SECRETS_IN_PROD=true is set.
 *   That override is for emergency use only — document it as such and rotate
 *   to a proper backend (aws / github) as soon as possible.
 */

export type SecretBackend = 'aws' | 'github' | 'env';

export interface SecretsProvider {
  fetchSecret(name: string): Promise<string>;
}

/**
 * Returns true when the current process is running in a production
 * environment. Checks both NODE_ENV and BATCHPAY_ENV so the keeper
 * bot (which may run with its own env vars) is also covered.
 */
export function isProductionEnv(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.BATCHPAY_ENV === 'production'
  );
}

/**
 * Throws if the env backend is selected in production without an explicit
 * override. Call this before constructing an EnvSecretsProvider.
 *
 * @throws {Error} when running in production without ALLOW_ENV_SECRETS_IN_PROD=true
 */
export function assertEnvBackendAllowed(): void {
  if (!isProductionEnv()) return;

  if (process.env.ALLOW_ENV_SECRETS_IN_PROD !== 'true') {
    throw new Error(
      '[secrets] SECRET_BACKEND=env is not allowed in production. ' +
        'Set SECRET_BACKEND=aws or SECRET_BACKEND=github for a secure secrets backend. ' +
        'If you must use env secrets temporarily, set ALLOW_ENV_SECRETS_IN_PROD=true ' +
        '(emergency override — rotate to a proper backend as soon as possible).',
    );
  }

  console.warn(
    '[secrets] WARNING: ALLOW_ENV_SECRETS_IN_PROD=true is set. ' +
      'Reading secrets from environment variables in production is unsafe. ' +
      'This override is for emergency use only — rotate to SECRET_BACKEND=aws or github immediately.',
  );
}

export async function createSecretsProvider(): Promise<SecretsProvider> {
  const backend = (process.env.SECRET_BACKEND ?? 'env') as SecretBackend;

  switch (backend) {
    case 'aws': {
      const { AwsSecretsProvider } = await import('./aws-backend');
      return new AwsSecretsProvider();
    }
    case 'github': {
      const { GitHubSecretsProvider } = await import('./github-backend');
      return new GitHubSecretsProvider();
    }
    case 'env':
    default: {
      // Refuse to use the env backend in production unless explicitly overridden.
      assertEnvBackendAllowed();

      console.warn(
        '[secrets] SECRET_BACKEND=env — reading secrets from environment variables. ' +
          'This is only safe for local development. Set SECRET_BACKEND=aws or github in production.',
      );
      const { EnvSecretsProvider } = await import('./env-backend');
      return new EnvSecretsProvider();
    }
  }
}
