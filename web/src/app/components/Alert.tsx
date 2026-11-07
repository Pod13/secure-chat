import type { ReactNode } from 'react';

/** Important messages are announced at once; others politely. */
export function Alert({ urgent = false, children }: { urgent?: boolean; children: ReactNode }) {
  return urgent ? (
    <div role="alert" className="alert alert-urgent">
      {children}
    </div>
  ) : (
    <div role="status" className="alert">
      {children}
    </div>
  );
}
