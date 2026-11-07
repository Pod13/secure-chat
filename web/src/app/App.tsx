import { Alert } from './components/Alert';
import { Layout } from './components/Layout';
import type { Route } from './router';
import { routeHref } from './router';
import { useRoute } from './useRoute';

export function Page({ route }: { route: Route }) {
  if (route === 'not-found') {
    return (
      <Layout title="Page not found">
        <Alert urgent>That page does not exist.</Alert>
        <a href={routeHref.home}>Go to the start page</a>
      </Layout>
    );
  }
  return (
    <Layout title="Secure Chat">
      <p>Private messaging where the server cannot read your messages.</p>
    </Layout>
  );
}

export function App() {
  return <Page route={useRoute()} />;
}
