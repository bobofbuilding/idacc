import {
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import {
  basename,
  join,
  relative,
  sep,
} from 'node:path';

const XMTP_BINDING_BY_TARGET = new Map([
  ['darwin-arm64', 'bindings_node.darwin-arm64.node'],
  ['darwin-x64', 'bindings_node.darwin-x64.node'],
  ['linux-x64', 'bindings_node.linux-x64-gnu.node'],
  ['win32-x64', 'bindings_node.win32-x64-msvc.node'],
]);

function portable(root, path) {
  return relative(root, path).split(sep).join('/');
}

function collectXmtpBindingDirectories(root, current = root, directories = []) {
  if (!existsSync(current)) return directories;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      if (portable(root, path).endsWith('/@xmtp/node-bindings/dist')) {
        directories.push(path);
      } else {
        collectXmtpBindingDirectories(root, path, directories);
      }
    }
  }
  return directories;
}

/**
 * @xmtp/node-bindings publishes every supported native target in each installed
 * copy. A unified native package needs exactly one of those binaries. Removing
 * foreign targets after the lockfile install preserves XMTP while avoiding
 * hundreds of megabytes of duplicate, unreachable payload.
 */
export function pruneXmtpNativeBindings(
  runtimeRoot,
  {
    platform = process.platform,
    arch = process.arch,
  } = {},
) {
  const bindingDirectories = collectXmtpBindingDirectories(runtimeRoot);
  if (!bindingDirectories.length) return { expected: null, kept: [], removed: [] };

  const expected = XMTP_BINDING_BY_TARGET.get(`${platform}-${arch}`);
  if (!expected) {
    throw new Error(`XMTP native bindings are unsupported for ${platform}-${arch}`);
  }

  const bindingsByDirectory = bindingDirectories.map((directory) => {
    const installed = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => (
        entry.isFile()
        && /^bindings_node\..+\.node$/.test(entry.name)
      ))
      .map((entry) => join(directory, entry.name));
    if (!installed.some((path) => basename(path) === expected)) {
      throw new Error(
        `XMTP binding directory ${portable(runtimeRoot, directory)} is missing required ${expected}`,
      );
    }
    return installed;
  });

  const kept = [];
  const removed = [];
  for (const installed of bindingsByDirectory) {
    for (const path of installed) {
      if (basename(path) === expected) {
        kept.push(portable(runtimeRoot, path));
        continue;
      }
      rmSync(path);
      removed.push(portable(runtimeRoot, path));
    }
  }
  return {
    expected,
    kept: kept.sort(),
    removed: removed.sort(),
  };
}
