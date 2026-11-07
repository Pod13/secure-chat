import { useState, type FormEvent } from 'react';

import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Layout } from '../components/Layout';
import { TextField } from '../components/TextField';
import { useController } from '../context';
import { useAction } from '../useAction';

interface Fields {
  inviteLink: string;
  username: string;
  passcode: string;
  again: string;
}

function useFields(link: string): [Fields, (name: keyof Fields) => (value: string) => void] {
  const [fields, setFields] = useState<Fields>({
    inviteLink: link,
    username: '',
    passcode: '',
    again: '',
  });
  return [fields, (name) => (value) => setFields((old) => ({ ...old, [name]: value }))];
}

function PasscodeFields({
  fields: f,
  set,
  mismatch,
}: {
  fields: Fields;
  set: (name: keyof Fields) => (value: string) => void;
  mismatch: boolean;
}) {
  return (
    <>
      <TextField
        label="Passcode"
        type="password"
        value={f.passcode}
        required
        minLength={10}
        autoComplete="new-password"
        hint="At least 10 characters. It protects everything on this device."
        onChange={(e) => set('passcode')(e.target.value)}
      />
      <TextField
        label="Passcode again"
        type="password"
        value={f.again}
        required
        autoComplete="new-password"
        error={mismatch ? 'The passcodes do not match.' : undefined}
        onChange={(e) => set('again')(e.target.value)}
      />
    </>
  );
}

/** Creating an account: a name only this device knows, a passcode, and an invite. */
export function SignUp({ link }: { link: string }) {
  const controller = useController();
  const { busy, error, run } = useAction();
  const [f, set] = useFields(link);
  const mismatch = f.again !== '' && f.again !== f.passcode;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!mismatch) void run(() => controller.signUp(f));
  }

  return (
    <Layout title="Create your account">
      <form onSubmit={submit}>
        <p>No phone number or email. Your messages are encrypted on this device.</p>
        <TextField
          label="Invite link"
          value={f.inviteLink}
          required
          autoComplete="off"
          onChange={(e) => set('inviteLink')(e.target.value)}
        />
        <TextField
          label="Your name"
          value={f.username}
          required
          autoComplete="off"
          hint="Kept on this device only. The server never sees it."
          onChange={(e) => set('username')(e.target.value)}
        />
        <PasscodeFields fields={f} set={set} mismatch={mismatch} />
        {error ? <Alert urgent>{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>
    </Layout>
  );
}
