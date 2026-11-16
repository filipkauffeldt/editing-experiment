import { useEffect } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import styles from './DeletePhotosDialog.module.css';

/**
 * Asks before a sidebar folder's photos are dropped from the Library. Every file stays where it
 * is; an added folder is forgotten so a rescan no longer runs on it. Enter confirms and Esc
 * cancels (the Modal owns Esc).
 */
export function FolderRemoveDialog() {
  const store = useAppStore();
  const request = useAppState().folderRemove;
  const busy = request?.busy ?? false;

  // Enter confirms wherever the focus is, except on the Cancel button, which Enter presses.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.isComposing || event.repeat) return;
      if (event.target instanceof HTMLElement && event.target.dataset.deleteCancel !== undefined) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void store.confirmRemoveLibraryFolder();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [store]);

  if (!request) return null;
  const subject = request.count === 1 ? '1 photo' : `${request.count} photos`;
  const pronoun = request.count === 1 ? 'its' : 'their';
  return (
    <Modal
      title="Remove folder from Library"
      subtitle={request.name}
      onClose={() => store.cancelRemoveLibraryFolder()}
      width={460}
      testId="folder-remove-dialog"
      footer={
        <>
          <span className={styles.spacer} />
          <Button
            data-delete-cancel
            disabled={busy}
            onClick={() => store.cancelRemoveLibraryFolder()}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            autoFocus
            disabled={busy}
            data-testid="folder-remove-confirm"
            onClick={() => void store.confirmRemoveLibraryFolder()}
          >
            {busy ? 'Removing…' : 'Remove'}
          </Button>
        </>
      }
    >
      <p className={styles.text} data-testid="folder-remove-message">
        {subject}{' '}
        {request.root
          ? 'in this folder and its subfolders will be removed'
          : 'in this folder will be removed'}{' '}
        from the Library, with {pronoun} edits and ratings in the app. Files on disk are not
        touched.
      </p>
      <p className={styles.note}>
        Nothing is deleted, moved or changed on disk, not the photos, {pronoun} XMP sidecars or the
        folder.{' '}
        {request.root
          ? 'The added folder is forgotten, with any added folder below it.'
          : 'Photos in subfolders stay in the Library; only this folder is removed.'}
      </p>
    </Modal>
  );
}
