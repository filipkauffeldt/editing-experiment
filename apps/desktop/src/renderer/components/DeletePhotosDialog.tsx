import { useEffect } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import styles from './DeletePhotosDialog.module.css';

/**
 * Asks before photos go to the system trash. Enter confirms and Esc cancels (the Modal owns
 * Esc). Nothing is deleted permanently: the files can be taken back from the trash.
 */
export function DeletePhotosDialog() {
  const store = useAppStore();
  const state = useAppState();
  const request = state.deleteRequest;
  const busy = request?.busy ?? false;
  const count = request?.photoIds.length ?? 0;
  const single =
    count === 1 ? state.photos.find((photo) => photo.id === request?.photoIds[0]) : undefined;

  // Enter confirms wherever the focus is, except on the Cancel button, which Enter presses.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.isComposing || event.repeat) return;
      if (event.target instanceof HTMLElement && event.target.dataset.deleteCancel !== undefined) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void store.confirmDelete();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [store]);

  if (!request) return null;
  const subject = count === 1 ? '1 photo' : `${count} photos`;
  return (
    <Modal
      title="Delete photos"
      subtitle={single ? single.fileName : undefined}
      onClose={() => store.cancelDelete()}
      width={440}
      testId="delete-photos-dialog"
      footer={
        <>
          <span className={styles.spacer} />
          <Button data-delete-cancel disabled={busy} onClick={() => store.cancelDelete()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            autoFocus
            disabled={busy}
            data-testid="delete-photos-confirm"
            onClick={() => void store.confirmDelete()}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </>
      }
    >
      <p className={styles.text} data-testid="delete-photos-message">
        {subject} will be moved to the system trash, with {count === 1 ? 'its' : 'their'} XMP
        sidecar{count === 1 ? '' : 's'} and edits. {count === 1 ? 'It' : 'They'} leave the Library
        and can be restored from the trash.
      </p>
      <p className={styles.note}>
        Backup copies and exported files are not touched. Photos on a card or in a source folder are
        never deleted.
      </p>
    </Modal>
  );
}
