import { useState, type FormEvent } from 'react';

import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Layout } from '../components/Layout';
import { TextField } from '../components/TextField';
import { useController } from '../context';
import { useAction } from '../useAction';

export function Unlock() {
  const controller = useController();
  const { busy, error, run } = useAction();
  const [passcode, setPasscode] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(() => controller.unlock(passcode));
  }

  return (
    <Layout title="Unlock">
      <form onSubmit={submit}>
        <TextField
          label="Passcode"
          type="password"
          value={passcode}
          required
          autoComplete="current-password"
          onChange={(e) => setPasscode(e.target.value)}
        />
        {error ? <Alert urgent>{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>
    </Layout>
  );
}
