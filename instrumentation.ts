/**
 * Next.js server instrumentation hook (#734).
 *
 * This file runs once when the Next.js server boots (Node.js runtime only).
 * It performs a startup safety check on the secrets backend so that a
 * misconfigured production deployment fails fast instead of silently using
 * environment-variable secrets.
 *
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run in the Node.js runtime — the Edge runtime doesn't have access to
  // process.env in the same way and doesn't use the secrets backend.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertEnvBackendAllowed, isProductionEnv } = await import(
      './lib/secrets/index'
    );

    const backend = process.env.SECRET_BACKEND ?? 'env';

    if (isProductionEnv() && backend === 'env') {
      // assertEnvBackendAllowed throws if ALLOW_ENV_SECRETS_IN_PROD != 'true',
      // which causes the Next.js server to refuse to start. This is intentional
      // — a production deployment with SECRET_BACKEND=env must be explicit.
      assertEnvBackendAllowed();
    }
  }
}
