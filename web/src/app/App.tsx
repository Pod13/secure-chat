import { Alert } from './components/Alert';
import { Layout } from './components/Layout';
import { ControllerContext, useSnapshot } from './context';
import type { AppController } from './controller';
import { routeHref, type Route } from './router';
import { Conversation } from './screens/Conversation';
import { Home } from './screens/Home';
import { Invite } from './screens/Invite';
import { JoinInvite } from './screens/JoinInvite';
import { RecoveryKey } from './screens/RecoveryKey';
import { SignUp } from './screens/SignUp';
import { Unlock } from './screens/Unlock';
import { useRoute } from './useRoute';

function NotFound() {
  return (
    <Layout title="Page not found">
      <Alert urgent>That page does not exist.</Alert>
      <a href={routeHref.home}>Go to the start page</a>
    </Layout>
  );
}

/** The signed-in screens. */
export function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'invite':
      return <Invite />;
    case 'join':
      return <JoinInvite link={route.link} />;
    case 'chat':
      return <Conversation id={route.id} />;
    case 'home':
      return <Home />;
    case 'not-found':
      return <NotFound />;
  }
}

function Screens() {
  const snapshot = useSnapshot();
  const route = useRoute();
  switch (snapshot.phase) {
    case 'starting':
      return (
        <Layout title="Secure Chat">
          <p>Loading…</p>
        </Layout>
      );
    case 'sign-up':
      return <SignUp link={route.name === 'join' ? route.link : ''} />;
    case 'recovery-key':
      return <RecoveryKey value={snapshot.recoveryKey ?? ''} />;
    case 'locked':
      return <Unlock />;
    case 'unlinked':
      return (
        <Layout title="Device removed">
          <Alert urgent>This device was removed from the account. Its messages were erased.</Alert>
        </Layout>
      );
    case 'ready':
      return <Page route={route} />;
  }
}

export function App({ controller }: { controller: AppController }) {
  return (
    <ControllerContext.Provider value={controller}>
      <Screens />
    </ControllerContext.Provider>
  );
}
