import { useCallback, useState } from 'react';

import { describeError } from './errors';

/** Runs a button's action, tracking "busy" and showing a friendly message if it fails. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
