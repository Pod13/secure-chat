import { useState } from 'react';

import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Layout } from '../components/Layout';
import { useController } from '../context';
import { routeHref } from '../router';
import { useAction } from '../useAction';

/** The Recovery Key is shown once. Without it, a lost device means a lost account. */
export function RecoveryKey({ value }: { value: string }) {
  const controller = useController();
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);

  function next() {
    void run(async () => {
      const conversation = await controller.confirmRecoveryKey();
      window.location.hash =
        conversation === undefined ? routeHref.home : routeHref.chat(conversation);
    });
  }

  return (
    <Layout title="Save your Recovery Key">
      <p>
        Write this down and keep it somewhere safe. It is the only way to get your account back if
        you lose this device. We cannot show it again, and no one else can recover it for you.
      </p>
      <p className="recovery-key" aria-label="Your Recovery Key" data-testid="recovery-key">
        {value}
      </p>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have
        written it down
      </label>
      {error ? <Alert urgent>{error}</Alert> : null}
      <Button disabled={!saved || busy} onClick={next}>
        Continue
      </Button>
    </Layout>
  );
}
