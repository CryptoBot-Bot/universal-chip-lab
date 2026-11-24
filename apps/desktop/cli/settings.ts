/**
 * Command-line stand-in for electron/settings.ts. The resolvers ask it for the
 * Anthropic API key; scripts/build-cli.mjs swaps this file in for the Electron
 * one when it bundles the CLI, so the resolver sources themselves are untouched.
 *
 * Only the environment is consulted (cli/vehicle.ts loads <repo>/.env first, the
 * same file the app reads in dev). The key saved in the app's Settings screen is
 * encrypted by Electron's safeStorage for the app alone and cannot be read here.
 */
export function getApiKey(): string | null {
  const env = process.env.ANTHROPIC_API_KEY;
  return env && env.trim() ? env.trim() : null;
}
