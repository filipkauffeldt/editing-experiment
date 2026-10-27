/**
 * Opaque identifiers. They are plain strings at runtime; the brand only stops
 * different kinds of id from being mixed up at compile time. Create them with
 * the `as*` helpers at the boundary where they are minted or parsed.
 */
declare const brand: unique symbol;
type Brand<T extends string> = string & { readonly [brand]: T };

/** Stable identifier of one photo (one file on disk). Assigned at ingest, never reused. */
export type PhotoId = Brand<'PhotoId'>;
/** Identifier of a configured ingest source. */
export type SourceId = Brand<'SourceId'>;
/** Identifier of a configured upload/export destination. */
export type DestinationId = Brand<'DestinationId'>;
/** Identifier of a photo version (a develop or retouch variant of one photo). */
export type VersionId = Brand<'VersionId'>;
/** Identifier of a background job (an ingest run, an export, ...). */
export type JobId = Brand<'JobId'>;
/** Identifier of one entry in the upload queue. */
export type UploadId = Brand<'UploadId'>;
/** Identifier of an imported develop preset. */
export type PresetId = Brand<'PresetId'>;

export const asPhotoId = (value: string): PhotoId => value as PhotoId;
export const asSourceId = (value: string): SourceId => value as SourceId;
export const asDestinationId = (value: string): DestinationId => value as DestinationId;
export const asVersionId = (value: string): VersionId => value as VersionId;
export const asJobId = (value: string): JobId => value as JobId;
export const asUploadId = (value: string): UploadId => value as UploadId;
export const asPresetId = (value: string): PresetId => value as PresetId;
