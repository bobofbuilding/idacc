import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bridge = readFileSync(join(root, 'src', 'main', 'bridge.ts'), 'utf8');
const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8');
const policy = readFileSync(join(root, 'src', 'main', 'secureStoragePolicy.ts'), 'utf8');
const onboarding = readFileSync(join(root, 'src', 'main', 'consumerOnboarding.ts'), 'utf8');
const schema = readFileSync(join(root, '..', 'idctl', 'src', 'settings', 'schema.ts'), 'utf8');
const providerClient = readFileSync(join(root, '..', 'idctl', 'src', 'settings', 'ProviderClient.ts'), 'utf8');
const providerStore = readFileSync(join(root, '..', 'idctl', 'src', 'settings', 'store.ts'), 'utf8');
const providerTransport = readFileSync(join(root, '..', 'idctl', 'src', 'settings', 'providerTransport.ts'), 'utf8');
const identity = readFileSync(join(root, 'src', 'renderer', 'views', 'Identity.tsx'), 'utf8');
const settings = readFileSync(join(root, 'src', 'renderer', 'views', 'Settings.tsx'), 'utf8');

assert.match(schema, /apiKeyEncrypted\?: string/);
assert.match(schema, /connectionEncrypted\?: string/);
assert.match(schema, /settingsSecretMigrationVersion\?: number/);
assert.match(bridge, /function providerForStorage/);
assert.match(bridge, /function mcpForStorage/);
assert.match(bridge, /function hydrateRegisteredMcp/);
assert.match(bridge, /export function migrateSettingsSecrets/);
assert.match(bridge, /const encrypted = provider\.apiKeyEncrypted \|\| codec\.encrypt\(provider\.apiKey\)/);
assert.match(bridge, /const encrypted = codec\.encrypt\(JSON\.stringify\(connection\)\)/);
assert.match(bridge, /const \{ apiKey: _apiKey, apiKeyEncrypted: _apiKeyEncrypted/);
assert.match(main, /secureStorageStatus\(safeStorage\)\.available/);
assert.match(policy, /selectedBackend === 'basic_text'/);
assert.match(policy, /macOS-Keychain/);
assert.match(policy, /Windows-DPAPI/);
assert.match(main, /configureSettingsSecretCodec/);
const secretMigration = bridge.slice(
  bridge.indexOf('export function migrateSettingsSecrets'),
  bridge.indexOf('function assertDefaultPrimaryWrite'),
);
assert.match(secretMigration, /settingsSecretMigrationVersion/);
assert.match(secretMigration, /if \(server\.connectionEncrypted\) return server/);
assert.doesNotMatch(
  secretMigration,
  /codec\.decrypt|hydrateMcp\(/,
  'startup migration must not decrypt already-encrypted settings',
);
assert.match(bridge, /hydratedMcpConnectionCache\.get\(profile\.connectionEncrypted\)/);
assert.match(bridge, /hydratedMcpConnectionCache\.set\(profile\.connectionEncrypted, connection\)/);
assert.match(bridge, /hydratedProviderCredentialCache\.get\(provider\.apiKeyEncrypted\)/);
assert.match(bridge, /if \(options\.unlockProtectedStorage === false\) return resolveProviderKey\(provider\)/);
assert.match(bridge, /managedMcpConnectionEnvironment\(\{ unlockProtectedStorage: false \}\)/);
assert.match(bridge, /export function secureSettingsSessionStatus/);
assert.match(bridge, /export function unlockSecureSettingsSession/);
const configureSecureSettings = main.slice(
  main.indexOf('function configureSecureSettings'),
  main.indexOf('function presentProviderRehydrationStatus'),
);
assert.match(configureSecureSettings, /managedMcpConnectionEnvironment\(\{ unlockProtectedStorage: false \}\)/);
assert.doesNotMatch(configureSecureSettings, /migrateSettingsSecrets|unlockSecureSettingsSession/);
assert.match(main, /unlockProtectedStorage: false/);
assert.match(main, /case 'secureSettings:unlock':[\s\S]*args\[0\] !== true/);
assert.match(main, /let protectedStorageUnlockAuthorized = false/);
assert.match(main, /!protectedStorageUnlockAuthorized[\s\S]*!secureCredentialStorageAvailable\(\)/);
assert.match(main, /return withProtectedStorageUnlock\(async \(\) =>/);
assert.match(main, /loadEvmRpcsMigratingSecrets\(\s*options:[\s\S]*options\.migrateProtectedStorage !== true\) return rpcs/);
assert.match(main, /const rehearsal = probeProtectedStorage[\s\S]*\? await verifySafeRehearsal\(\)/);
assert.match(settings, /Unlock for this session/);
assert.match(settings, /secureSettings:unlock', true/);
assert.match(providerTransport, /Plain HTTP providers are allowed only on exact localhost, 127\.0\.0\.1, or \[::1\]/);
assert.match(providerTransport, /Provider URLs cannot contain a query string/);
assert.match(providerTransport, /Provider URLs cannot contain a fragment/);
assert.match(providerClient, /Transport validation happens before authentication headers are built/);
assert.match(providerStore, /normalizeProviderBaseUrl\(p\.baseUrl\)/);
assert.match(onboarding, /normalizeProviderBaseUrl\(String\(input\.baseUrl/);
assert.match(bridge, /async function probeConfiguredProvider/);
assert.match(bridge, /function providerKey[\s\S]*providerTransportDecision\(provider\.baseUrl\)\.ok\) return undefined;[\s\S]*provider\.apiKeyEncrypted/);
assert.match(bridge, /function providerForStorage[\s\S]*normalizeProviderBaseUrl\(input\.baseUrl\)[\s\S]*requireSettingsSecretCodec\(\)\.encrypt/);
assert.match(
  bridge,
  /const needsKey = providerNeedsKey\(p\);[\s\S]*const apiKey = needsKey[\s\S]*\? providerKey\(p, options\)[\s\S]*: \(isLoopbackProvider\(p\) \? 'idacc-local-provider-no-key' : ''\)/,
  'automatic restart restoration must not decrypt obsolete credentials for local/no-key providers',
);
assert.match(main, /keyProductionReadiness\(options:[\s\S]*probeProtectedStorage/);
assert.match(main, /agentSignerVaultStatus\(\{ verifyEncryption: probeProtectedStorage \}\)/);
assert.match(main, /args\[0\] === true/);
assert.match(identity, /call<KeyProductionReadiness>\('keys:productionReadiness', false\)/);
assert.match(identity, /call<KeyProductionReadiness>\('keys:productionReadiness', true\)/);

process.stdout.write('secure settings vault smoke: ok\n');
