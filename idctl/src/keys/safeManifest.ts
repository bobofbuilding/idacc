/**
 * Pinned production evidence for agent Safes. IDACC verifies every runtime
 * hash on the selected chain before it may prepare an authority change.
 */

export type SafeModuleStability = 'stable' | 'experimental';

export interface SafeModuleArtifact {
  name: string;
  address: string;
  runtimeCodeHashByChain: Record<number, string>;
}

export interface SafeModuleManifest {
  id: string;
  architecture: 'safe-1.4.1-zodiac-roles-v2';
  stability: SafeModuleStability;
  safeDeployments: {
    package: '@safe-global/safe-deployments';
    version: string;
    repository: string;
    sourceRevision: string;
  };
  authority: {
    package: 'zodiac-roles-sdk';
    sdkVersion: string;
    contractVersion: string;
    repository: string;
    sdkSourceRevision: string;
    contractSourceRevision: string;
    auditPatchRevision: string;
  };
  artifacts: SafeModuleArtifact[];
}

const SHARED_HASHES = (hash: string): Record<number, string> => ({
  1: hash,
  11155111: hash,
});

/**
 * New agent Safes use Safe 1.4.1 with the root Safe as owner/recovery and a
 * Zodiac Roles v2 modifier for finite target/function/value/rate permissions.
 * Agent EOAs are role members, never Safe owners. Rotation revokes the old
 * member and assigns the same bounded role to a replacement key.
 */
export const SAFE_MODULE_MANIFEST: SafeModuleManifest = {
  id: 'safe-1.4.1-zodiac-roles-v2.1',
  architecture: 'safe-1.4.1-zodiac-roles-v2',
  stability: 'stable',
  safeDeployments: {
    package: '@safe-global/safe-deployments',
    version: '1.37.59',
    repository: 'https://github.com/safe-global/safe-deployments',
    sourceRevision: '2a6844b0d1ec45e32f179e4ef2599de58905db4a',
  },
  authority: {
    package: 'zodiac-roles-sdk',
    sdkVersion: '4.0.0',
    contractVersion: '2.1.1',
    repository: 'https://github.com/gnosisguild/zodiac-modifier-roles',
    sdkSourceRevision: '7ac8153c4058a2dc6c63a2615bcd87ff52ce2799',
    contractSourceRevision: '218a5164d739c107b132034436978e78cdd90c95',
    auditPatchRevision: 'a19c0ebda97f7d645335f2c386818546641f832b',
  },
  artifacts: [
    {
      name: 'Safe 1.4.1 singleton',
      address: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
      runtimeCodeHashByChain: SHARED_HASHES('0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4'),
    },
    {
      name: 'Safe 1.4.1 proxy factory',
      address: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
      runtimeCodeHashByChain: SHARED_HASHES('0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317'),
    },
    {
      name: 'Safe 1.4.1 MultiSend',
      address: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
      runtimeCodeHashByChain: SHARED_HASHES('0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77'),
    },
    {
      name: 'Safe 1.4.1 MultiSendCallOnly',
      address: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
      runtimeCodeHashByChain: SHARED_HASHES('0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939'),
    },
    {
      name: 'Safe 1.4.1 compatibility fallback handler',
      address: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
      runtimeCodeHashByChain: SHARED_HASHES('0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9'),
    },
    {
      name: 'Safe CreateAndAddModules 1.1.1',
      address: '0xF61A721642B0c0C8b334bA3763BA1326F53798C0',
      runtimeCodeHashByChain: {
        1: '0x83941bb48a3e3302a6e502e61513981ad02f3870f2d15e6d9cd301d616a0ba38',
      },
    },
    {
      name: 'Zodiac ModuleProxyFactory 3.0.1',
      address: '0x000000000000aDdb49795B0f9BA5bc298CdDA236',
      runtimeCodeHashByChain: SHARED_HASHES('0x01623cbcf010a1c326230f1b2d5f48a66b440232ee49096102bc84967dc5f21e'),
    },
    {
      name: 'Zodiac Roles Modifier v2.1',
      address: '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5',
      runtimeCodeHashByChain: SHARED_HASHES('0x471d8b3b419f1eb955230c0326c8812176df49bf3c7b414a563fda5a3c6c10b6'),
    },
  ],
};

/** Retained for audit history; this profile is deliberately not selectable. */
export const EXPERIMENTAL_ERC7579_CANDIDATE = {
  id: 'rhinestone-safe7579-v2-smartsession-emissary-v1',
  stability: 'experimental' as const,
  sdk: '@rhinestone/sdk@1.9.2',
  sourceRevision: '02a052586b69f0e08925323627ed797a05b22a1b',
  reasonInactive: 'The upstream Smart Sessions SDK path is explicitly experimental.',
};
