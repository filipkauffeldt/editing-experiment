import type { ProfileGroup, ProfileListing } from '@ee/contracts';
import { useEffect } from 'react';
import { activePhoto, namesProfile, paramsForPhoto } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { Select } from './ui/Field';
import { Slider } from './ui/Slider';
import styles from './ProfileSection.module.css';

const GROUPS: { id: ProfileGroup; label: string }[] = [
  { id: 'adobe-raw', label: 'Adobe Raw' },
  { id: 'camera-matching', label: 'Camera Matching' },
  { id: 'other', label: 'Other' },
];

/** The select value of a profile choice; `''` is no profile (the decoder's camera matrix). */
const MISSING = '__missing__';
/** The last option of the select: it opens the profile folders instead of choosing a profile. */
const BROWSE = '__browse__';

/**
 * The camera profile of the photo, one row above the sliders like Lightroom's Profile: a select
 * grouped Adobe Raw / Camera Matching / Other (ending in the way to the profile folders), the
 * look's Amount, and a status line when the profile a sidecar or preset names is not in any
 * profile folder (the name is kept and written back) or the default could not be read.
 */
export function ProfileSection() {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  const params = paramsForPhoto(state, photo);
  const photoId = photo?.id;

  const choices = photo ? state.profileChoices[photo.id] : undefined;
  const loaded = photo ? state.photoProfiles[photo.id] : undefined;
  const listings = choices?.profiles ?? [];
  const choicesKnown = choices !== undefined;

  // Loaded again after a rescan of the profile folders has forgotten them.
  useEffect(() => {
    if (photoId) store.loadProfileChoices(photoId);
  }, [store, photoId, choicesKnown]);

  const named = namesProfile(params);
  // Nothing named: the default profile is in effect (and shown as selected) when it was found.
  const defaultName =
    !named && loaded?.status === 'ok' && loaded.isDefault === true
      ? loaded.profile?.camera.name.toLowerCase()
      : undefined;
  const current: ProfileListing | undefined = params.LookName
    ? listings.find(
        (p) =>
          p.kind === 'look' &&
          (params.LookUUID ? p.uuid === params.LookUUID : p.name === params.LookName),
      )
    : params.CameraProfile
      ? listings.find((p) => p.kind === 'camera' && p.name === params.CameraProfile)
      : defaultName
        ? listings.find((p) => p.kind === 'camera' && p.name.toLowerCase() === defaultName)
        : undefined;
  const usingDefault = current !== undefined && defaultName !== undefined;
  const value = current ? current.id : named ? MISSING : '';
  const label = params.LookName ?? params.CameraProfile;
  // The default profile could not be read: the picture uses the camera matrix, and the panel says why.
  const defaultProblem = !named && loaded?.status === 'none' ? loaded.reason : undefined;

  const select = (id: string): void => {
    if (id === BROWSE) {
      store.openDialog('profiles');
      return;
    }
    if (id === MISSING) return;
    store.setCameraProfile(listings.find((p) => p.id === id) ?? null);
  };

  // Only what someone must see: a name this machine does not have, or a default that failed.
  const problem = !photo
    ? undefined
    : loaded?.status === 'missing'
      ? `${label} is not in the profile folders${loaded.reason ? `: ${loaded.reason}` : ''} The name is kept; the picture uses the camera matrix.`
      : defaultProblem !== undefined
        ? `${defaultProblem}. The default profile is not used; the picture uses the camera matrix.`
        : undefined;

  const supportsAmount = current?.kind === 'look' && current.supportsAmount === true;
  const amount = Math.round((params.LookAmount ?? 1) * 100);

  return (
    <div className={styles.profile} data-testid="camera-profile">
      <label className={styles.selectRow}>
        <span className={styles.label}>Profile</span>
        <Select
          aria-label="Camera profile"
          value={value}
          disabled={!photo}
          onChange={(event) => select(event.target.value)}
        >
          <option value="">None</option>
          {value === MISSING && <option value={MISSING}>{label} (not found)</option>}
          {GROUPS.map((group) => {
            const members = listings.filter((p) => p.group === group.id);
            if (members.length === 0) return null;
            return (
              <optgroup key={group.id} label={group.label}>
                {members.map((p) => (
                  <option key={p.id} value={p.id}>
                    {usingDefault && p.id === current?.id ? `${p.name} (default)` : p.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
          <option value={BROWSE}>Browse profile folders</option>
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
          sourceKey={photo?.id}
          onRange={(v) => store.setLookAmount(v / 100)}
          onNumber={(v) => store.setLookAmount(v === undefined ? undefined : v / 100)}
          onReset={() => store.setLookAmount(undefined)}
        />
      )}
      {problem !== undefined && (
        <p className={styles.missing} role="status" data-testid="profile-note">
          <span className={styles.missingDot} aria-hidden />
          <span>{problem}</span>
        </p>
      )}
    </div>
  );
}
