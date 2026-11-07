import { useState, type FormEvent } from 'react';

import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Layout } from '../components/Layout';
import { TextField } from '../components/TextField';
import { useController } from '../context';
import { routeHref } from '../router';
import { useAction } from '../useAction';

/** Starting a conversation from an invite link someone sent. */
export function JoinInvite({ link }: { link: string }) {
  const controller = useController();
  const { busy, error, run } = useAction();
  const [text, setText] = useState(link === '/join/' ? '' : link);

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const id = await controller.join(text);
      window.location.hash = routeHref.chat(id);
    });
  }

  return (
    <Layout title="Use an invite link">
      <form onSubmit={submit}>
        <TextField
          label="Invite link"
          value={text}
          required
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
        {error ? <Alert urgent>{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? 'Connecting…' : 'Start conversation'}
        </Button>
      </form>
      <p>
        <a href={routeHref.home}>Back</a>
      </p>
    </Layout>
  );
}
