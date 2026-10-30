import type { ProfileGroup, ProfileListing } from '@ee/contracts';
import { useEffect } from 'react';
import { activePhoto, namesProfile, paramsForPhoto } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { Button } from './ui/Button';
import { Select } from './ui/Field';
import { PanelSection } from './ui/PanelSection';
import { Slider } from './ui/Slider';
import styles from './ProfileSection.module.css';

const GROUPS: { id: ProfileGroup; label: string }[] = [
  { id: 'adobe-raw', label: 'Adobe Raw' },
  { id: 'camera-matching', label: 'Camera Matching' },
  { id: 'other', label: 'Other' },
];

/** The select value of a profile choice; `''` is no profile (the decoder's camera matrix). */
const MISSING = '__missing__';

/**
 * The camera profile of the photo, at the top of Basic like Lightroom's Profile: a select grouped
 * Adobe Raw / Camera Matching / Other, the look's Amount, and a note when the profile a sidecar or
 * preset names is not in any profile folder (the name is kept and written back).
 */
export function ProfileSection() {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  const params = paramsForPhoto(state, photo);
  const photoId = photo?.id;

  useEffect(() => {
    if (photoId) store.loadProfileChoices(photoId);
  }, [store, photoId]);

  const choices = photo ? state.profileChoices[photo.id] : undefined;
  const loaded = photo ? state.photoProfiles[photo.id] : undefined;
  const listings = choices?.profiles ?? [];

  const named = namesProfile(params);
  const current: ProfileListing | undefined = params.LookName
    ? listings.find(
        (p) =>
          p.kind === 'look' &&
          (params.LookUUID ? p.uuid === params.LookUUID : p.name === params.LookName),
      )
    : params.CameraProfile
      ? listings.find((p) => p.kind === 'camera' && p.name === params.CameraProfile)
      : undefined;
  const value = current ? current.id : named ? MISSING : '';
  const label = params.LookName ?? params.CameraProfile;

  const select = (id: string): void => {
    if (id === MISSING) return;
    store.setCameraProfile(listings.find((p) => p.id === id) ?? null);
  };

  const note = !photo
    ? undefined
    : loaded?.status === 'loading'
      ? 'Loading profile…'
      : loaded?.status === 'missing'
        ? `${label} is not in the profile folders${loaded.reason ? `: ${loaded.reason}` : ''} The name is kept; the picture uses the camera matrix.`
        : choices && listings.length === 0
          ? `No profiles for ${choices.camera || 'this camera'} in the profile folders.`
          : !named
            ? 'The decoder’s camera matrix.'
            : undefined;

  const supportsAmount = current?.kind === 'look' && current.supportsAmount === true;
  const amount = Math.round((params.LookAmount ?? 1) * 100);

  return (
    <PanelSection title="Profile" testId="camera-profile">
      <label className={styles.selectRow}>
        <span className={styles.label}>Profile</span>
        <Select
          aria-label="Camera profile"
          value={value}
          disabled={!photo || (listings.length === 0 && !named)}
          onChange={(event) => select(event.target.value)}
        >
          <option value="">Camera matrix</option>
          {value === MISSING && <option value={MISSING}>{label} (not found)</option>}
          {GROUPS.map((group) => {
            const members = listings.filter((p) => p.group === group.id);
            if (members.length === 0) return null;
            return (
              <optgroup key={group.id} label={group.label}>
                {members.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </Select>
      </label>
      {supportsAmount && (
        <Slider
          label="Amount"
          value={amount}
          min={0}
          max={200}
          step={1}
          neutral={100}
          display={amount}
          numberMin={0}
          numberMax={200}
          numberStep={1}
          onRange={(v) => store.setLookAmount(v / 100)}
          onNumber={(v) => store.setLookAmount(v === undefined ? undefined : v / 100)}
          onReset={() => store.setLookAmount(undefined)}
        />
      )}
      {loaded?.status === 'missing' ? (
        <p className={styles.missing} role="status" data-testid="profile-note">
          <span className={styles.missingDot} aria-hidden />
          <span>{note}</span>
        </p>
      ) : (
        note && (
          <p className={styles.note} data-testid="profile-note">
            {note}
          </p>
        )
      )}
      <Button
        variant="ghost"
        size="small"
        className={styles.browse}
        onClick={() => store.openDialog('profiles')}
      >
        Browse profile folders…
      </Button>
    </PanelSection>
  );
}
