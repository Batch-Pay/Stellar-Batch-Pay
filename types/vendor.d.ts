/**
 * Vendor ambient module declarations
 *
 * These stubs cover packages whose published TypeScript declarations are not
 * resolvable under `moduleResolution: "bundler"` in this environment:
 *
 *   - @aws-sdk/client-secrets-manager — now declared as an optionalDependency
 *                    in package.json (#595). The ambient stub below is retained
 *                    as a fallback for environments where the package is not
 *                    installed; `lib/secrets/aws-backend.ts` wraps the dynamic
 *                    import in a try/catch so a missing package fails at runtime
 *                    with a clear install message rather than at compile time.
 *                    Remove this stub once the package is pinned as a regular
 *                    dependency.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Fallback stub — only active when the optional package is not installed.
// When `bun add @aws-sdk/client-secrets-manager` is run, the package's own
// declarations take precedence and this stub becomes unreachable.
declare module '@aws-sdk/client-secrets-manager' {
  export class SecretsManagerClient {
    constructor(config: { region: string });
    send(command: any): Promise<any>;
  }
  export class GetSecretValueCommand {
    constructor(input: { SecretId: string });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

