import { useState } from 'react';

import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Layout } from '../components/Layout';
import { useController } from '../context';
import { routeHref } from '../router';
import { useAction } from '../useAction';

/** Makes a one-use link to share. Whoever opens it can sign up and start a conversation. */
export function Invite() {
  const controller = useController();
  const { busy, error, run } = useAction();
  const [link, setLink] = useState<string | undefined>();
  return (
    <Layout title="Invite someone">
      <p>
        The link works once and expires in 7 days. Send it to the person yourself, in a way you
        trust. Anyone who gets it can start a conversation with you.
      </p>
      {link === undefined ? (
        <Button
          disabled={busy}
          onClick={() => void run(async () => setLink(await controller.createInviteLink()))}
        >
          {busy ? 'Making link…' : 'Make an invite link'}
        </Button>
      ) : (
        <p className="invite-link" data-testid="invite-link">
          {link}
        </p>
      )}
      {error ? <Alert urgent>{error}</Alert> : null}
      <p>
        <a href={routeHref.home}>Back</a>
      </p>
    </Layout>
  );
}
