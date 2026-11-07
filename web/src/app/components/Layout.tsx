import type { ReactNode } from 'react';

/** Page frame with a skip link and a single main landmark. */
export function Layout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <h1>{title}</h1>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
