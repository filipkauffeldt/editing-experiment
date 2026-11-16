import { useEffect, useState } from 'react';
import { ee } from './ee';

interface Presence {
  key: string;
  present: ReadonlySet<string>;
  loaded: boolean;
}

/**
 * Which `credentialRef`s have a secret on this computer. A source or destination that came
 * from another computer keeps its reference but not its encrypted secret, so its row says
 * "Password needed" until the user enters it here.
 */
export function useCredentialPresence(
  refs: readonly string[],
  refresh = 0,
): {
  present: ReadonlySet<string>;
  loaded: boolean;
} {
  const key = [...new Set(refs.filter((ref) => ref !== ''))].sort().join('\n');
  const [result, setResult] = useState<Presence>({
    key: '',
    present: new Set(),
    loaded: true,
  });

  useEffect(() => {
    if (key === '') return;
    let cancelled = false;
    const wanted = key.split('\n');
    void ee.invoke('credentials:present', { refs: wanted }).then(
      (found) => {
        if (!cancelled) setResult({ key, present: new Set(found), loaded: true });
      },
      () => {
        // Unknown is not "missing": no badge until the question can be answered.
        if (!cancelled) setResult({ key, present: new Set(), loaded: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, refresh]);

  if (key === '') return { present: result.present, loaded: true };
  return result.key === key
    ? { present: result.present, loaded: result.loaded }
    : { present: new Set(), loaded: false };
}
