// A startup self-check for Trusted Types. The page's policy (`require-trusted-types-for
// 'script'` with no allowed policies) makes the browser refuse every string-to-HTML/script sink.
// If a browser claims support but a sink still accepts a string, the policy did not arrive
// (for example a proxy stripped it), and the app should not start.

export type TrustedTypesState = 'enforced' | 'not_enforced' | 'unsupported';

/** `probe` tries a string sink (such as assigning innerHTML); it throws when enforcement works. */
export function checkTrustedTypes(supported: boolean, probe: () => unknown): TrustedTypesState {
  if (!supported) return 'unsupported';
  try {
    probe();
  } catch {
    return 'enforced';
  }
  return 'not_enforced';
}

/** Runs the check in a browser page. */
export function checkThisPage(): TrustedTypesState {
  return checkTrustedTypes('trustedTypes' in window, () => {
    document.createElement('div').innerHTML = '<i></i>';
  });
}
