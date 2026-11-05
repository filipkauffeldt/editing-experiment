import { useSyncExternalStore } from 'react';
import { createStore } from './develop-view';

/**
 * Which of the Metadata panel's collapsible groups the user opened. View state like the rest of
 * `develop-view.ts`: it outlives the panel (a trip to the Library does not fold the groups again)
 * but not the app, since saving it would need a settings field. Nothing is open by default.
 */
const openGroups = createStore<ReadonlySet<string>>(new Set());

export function useMetadataGroupOpen(
  title: string,
): [open: boolean, setOpen: (open: boolean) => void] {
  const open = useSyncExternalStore(openGroups.subscribe, openGroups.get, openGroups.get);
  return [
    open.has(title),
    (next) =>
      openGroups.update((current) => {
        const groups = new Set(current);
        if (next) groups.add(title);
        else groups.delete(title);
        return groups;
      }),
  ];
}
