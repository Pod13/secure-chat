import { useEffect, useState, type FormEvent } from 'react';

import type { Writable } from '../../net/delivery';
import type { MessageView } from '../../crypto/messagetypes';
import type { ViewState } from '../../store/history';
import { Composer, type Mode } from '../components/Composer';
import { Layout } from '../components/Layout';
import { LIKE, MessageItem } from '../components/MessageItem';
import { useController, useSnapshot } from '../context';
import { routeHref } from '../router';
import { useAction } from '../useAction';

/** Reloads the conversation whenever the app says something changed. */
function useView(id: string): ViewState | undefined {
  const controller = useController();
  const { revision } = useSnapshot();
  const [view, setView] = useState<ViewState | undefined>();
  useEffect(() => {
    let current = true;
    void controller.view(id).then((loaded) => current && setView(loaded));
    return () => {
      current = false;
    };
  }, [controller, id, revision]);
  return view;
}

function contentFor(mode: Mode, text: string): Writable {
  if (mode.kind === 'edit') return { kind: 'edit', to: mode.of.id, text };
  if (mode.kind === 'reply') return { kind: 'reply', to: mode.to.id, text };
  return { kind: 'text', text };
}

/** What is being written, and what happens when it is sent. */
function useCompose(id: string) {
  const controller = useController();
  const { busy, error, run } = useAction();
  const [mode, setMode] = useState<Mode>({ kind: 'new' });
  const [text, setText] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    const content = contentFor(mode, text);
    const previous = { mode, text };
    // Clear at once, so what the person types next is never wiped by a send still finishing.
    setText('');
    setMode({ kind: 'new' });
    void run(async () => {
      try {
        await controller.send(id, content);
      } catch (failure) {
        setText((now) => (now === '' ? previous.text : now));
        setMode(previous.mode);
        throw failure;
      }
    });
  }
  const like = (m: MessageView) =>
    void run(() =>
      controller.send(id, {
        kind: 'reaction',
        to: m.id,
        emoji: LIKE,
        remove: m.reactions.get(LIKE)?.has('me') === true,
      }),
    );
  const edit = (m: MessageView) => {
    setMode({ kind: 'edit', of: m });
    setText(m.text);
  };
  return {
    busy,
    error,
    mode,
    text,
    setText,
    submit,
    like,
    edit,
    reply: (m: MessageView) => setMode({ kind: 'reply', to: m }),
  };
}

export function Conversation({ id }: { id: string }) {
  const view = useView(id);
  const compose = useCompose(id);
  const all = view?.conversation.messages;
  const messages = view?.conversation.order.map((m) => all?.get(m) as MessageView) ?? [];
  return (
    <Layout title="Conversation">
      <p>
        <a href={routeHref.home}>All conversations</a>
      </p>
      <ul className="messages" aria-live="polite" aria-label="Messages">
        {messages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            quoted={m.replyTo ? all?.get(m.replyTo) : undefined}
            status={view?.statuses.get(m.id)}
            onReply={() => compose.reply(m)}
            onEdit={() => compose.edit(m)}
            onLike={() => compose.like(m)}
          />
        ))}
      </ul>
      <Composer
        mode={compose.mode}
        text={compose.text}
        busy={compose.busy}
        error={compose.error}
        onText={compose.setText}
        onSubmit={compose.submit}
      />
    </Layout>
  );
}
