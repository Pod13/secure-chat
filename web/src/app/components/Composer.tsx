import type { FormEvent } from 'react';

import type { MessageView } from '../../crypto/messagetypes';
import { Alert } from './Alert';
import { Button } from './Button';

export type Mode =
  { kind: 'new' } | { kind: 'reply'; to: MessageView } | { kind: 'edit'; of: MessageView };

interface Props {
  mode: Mode;
  text: string;
  busy: boolean;
  error: string | undefined;
  onText(text: string): void;
  onSubmit(event: FormEvent): void;
}

/** The message box. It says plainly when the message is a reply or an edit. */
export function Composer({ mode, text, busy, error, onText, onSubmit }: Props) {
  return (
    <form onSubmit={onSubmit} className="composer">
      {mode.kind === 'reply' ? <p>Replying to “{mode.to.text}”</p> : null}
      {mode.kind === 'edit' ? <p>Editing your message</p> : null}
      <label htmlFor="message">Message</label>
      <textarea
        id="message"
        value={text}
        required
        maxLength={4000}
        rows={2}
        onChange={(e) => onText(e.target.value)}
      />
      {error ? <Alert urgent>{error}</Alert> : null}
      <Button type="submit" disabled={busy || text.trim() === ''}>
        Send
      </Button>
    </form>
  );
}
