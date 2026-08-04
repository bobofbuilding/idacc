/**
 * Keep CI review sequencing available to the updater without exposing it in
 * the application chrome. Stable, beta, and otherwise unknown versions are
 * left untouched so the UI never misrepresents a non-review build.
 */
export function displayAppVersion(version: string): string {
  const normalized = version.trim();
  const review = /^(\d+\.\d+\.\d+)-review\.\d+(?:\+[0-9A-Za-z.-]+)?$/i.exec(normalized);
  return review?.[1] ?? normalized;
}
