import { createContext, useContext, useSyncExternalStore } from 'react';

import type { AppController, Snapshot } from './controller';

export const ControllerContext = createContext<AppController | undefined>(undefined);

export function useController(): AppController {
  const controller = useContext(ControllerContext);
  if (controller === undefined) throw new Error('No controller provided');
  return controller;
}

/** The latest app state; the screen re-renders whenever it changes. */
export function useSnapshot(): Snapshot {
  const controller = useController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
