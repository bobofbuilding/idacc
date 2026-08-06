import { join } from 'node:path';

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AppProfileSelection {
  root: string;
  profileName: string;
  explicitDataDir: boolean;
}

/**
 * Profile names are one portable path segment. Advanced callers that need a
 * custom location must use IDACC_DATA_DIR rather than path syntax in a name.
 */
export function normalizeAppProfileName(input?: string): string {
  const name = input?.trim() || 'default';
  if (!PROFILE_NAME.test(name)) {
    throw new Error(
      'IDACC_PROFILE must be a 1-64 character name using only letters, numbers, ".", "_", or "-", and it must start with a letter or number.',
    );
  }
  return name;
}

export function selectAppProfile(
  userDataRoot: string,
  input: {
    dataDir?: string;
    profile?: string;
  } = {},
): AppProfileSelection {
  const dataDir = input.dataDir?.trim() || '';
  const profileName = normalizeAppProfileName(input.profile);
  return {
    root: dataDir || join(userDataRoot, 'profiles', profileName),
    profileName,
    explicitDataDir: Boolean(dataDir),
  };
}
