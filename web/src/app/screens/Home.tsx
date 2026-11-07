import { Layout } from '../components/Layout';
import { useSnapshot } from '../context';
import { routeHref } from '../router';
import { Button } from '../components/Button';
import { useController } from '../context';

const CONNECTION_TEXT = {
  idle: 'Offline',
  connecting: 'Connecting…',
  open: 'Connected',
  waiting: 'Reconnecting…',
  unlinked: 'Removed',
} as const;

export function Home() {
  const controller = useController();
  const { conversations, connection } = useSnapshot();
  return (
    <Layout title="Conversations">
      <p role="status">{CONNECTION_TEXT[connection]}</p>
      {conversations.length === 0 ? (
        <p>No conversations yet. Invite someone to start one.</p>
      ) : (
        <ul className="conversations">
          {conversations.map((c) => (
            <li key={c.id}>
              <a href={routeHref.chat(c.id)}>{c.lastText ?? 'New conversation'}</a>
            </li>
          ))}
        </ul>
      )}
      <p>
        <a className="button" href={routeHref.invite}>
          Invite someone
        </a>{' '}
        <a href="#/join/">Use an invite link</a>
      </p>
      <Button onClick={() => controller.lock()}>Lock</Button>
    </Layout>
  );
}
