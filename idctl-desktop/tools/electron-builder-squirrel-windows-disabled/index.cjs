'use strict';

class DisabledSquirrelWindowsTarget {
  constructor() {
    throw new Error(
      'Squirrel.Windows packaging is disabled for IDACC. Build the configured NSIS target instead.',
    );
  }
}

module.exports = DisabledSquirrelWindowsTarget;
module.exports.default = DisabledSquirrelWindowsTarget;
