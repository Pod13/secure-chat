// Release versions are "major.minor.patch" (checked by `verifyManifest`); this compares them.

/** Negative if `a` is older than `b`, zero if equal, positive if newer. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const difference = (left[i] as number) - (right[i] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}
