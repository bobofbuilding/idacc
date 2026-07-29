# IDACC review build — not a consumer release

This bundle contains native IDACC packages built from one exact source commit
for hands-on review across macOS, Windows, and Linux.

- Each packaged application uses a review-only SemVer identity such as
  `0.1.685-review.42`; the source package version remains unchanged.
- The macOS applications and disk images are unsigned and not notarized.
- The Windows application and installer are unsigned.
- Operating-system security warnings are expected.
- Self-update is disabled inside these review builds.
- Updater descriptor and blockmap files are deliberately excluded.
- No signing, notarization, or GitHub Release publishing credentials are used.
- This bundle was uploaded as a GitHub Actions artifact only. It was not
  published as a GitHub Release, does not change GitHub Latest, and is not an
  IDACC production update.

No user-supplied or private runtime-source credential is used. GitHub's scoped
automatic `github.token` reads the public IDACC and Manager repositories and
writes only the pending/final review status on the exact IDACC commit. Checkout
credential persistence is disabled and the workflow has no release-write
permission. Brain is supplied by the vendored runtime capsule committed with
IDACC; the workflow verifies the capsule before materializing or packaging it.

The capsule manifest binds its exact file inventory, modes, and content hashes
to the lock. It intentionally omits raw private Git tree objects because those
objects would disclose the names and hashes of excluded private siblings. The
private upstream commit/tree and recorded Git blob identities are publisher
assertions in this credential-free review; the capsule inventory and SHA-256
content tree are independently reproducible and tamper-evident. A maintainer
with private-source access can repeat the upstream comparison using the capsule
export tool.

Verify the files with `SHA256SUMS` before review. Use `REVIEW-BUNDLE.json` and
the records under `platform-records/` to confirm the exact IDACC, Manager, and
Brain source identities.

The combined `.tar.gz` preserves the Linux AppImage's executable mode. If the
standalone Linux platform artifact is downloaded instead, run
`chmod 0755 ID-Agents-Control-Center-*.AppImage` before launching it.

The pinned AppImage launcher checks whether unprivileged user namespaces are
available and may conditionally request Electron's `--no-sandbox` fallback on a
host where they are unavailable. IDACC's review and production startup policy
rejects that request before bundled application modules load, writes clear
guidance, and exits; the application will not continue without its sandbox.
Enable unprivileged user namespaces or install the Debian package instead. The
Debian package is the preferred Linux review path because its installer can
configure the Chromium sandbox helper and AppArmor integration for the host.

The workflow's repository-owner and `agent/**` branch checks reduce accidental
execution and distribution of review artifacts. Branch protection, Actions
permissions, and repository or environment policy remain administrative
controls that repository maintainers must configure and review.

Do not redistribute these packages as consumer-ready software. A production
release still requires the normal signed-tag, code-signing, notarization,
verification, and publication gates.
