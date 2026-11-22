/**
 * PRP-06 photos. Files live in the Supabase Storage bucket `listing-photos` under
 * "<account_id>/<listing_id>/<uuid>.<ext>"; metadata (order, caption, room) in listing_photos.
 *
 * Variants are produced on the fly by Supabase image transformations (render/image endpoint):
 * no worker, no stored copies, HEIC is decoded server-side and browsers get WebP. If the plan
 * does not include transformations, replace photoUrl() with server-side resizing on upload.
 */

export const PHOTO_BUCKET = "listing-photos";
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

export const PHOTO_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
} as const;
export type PhotoContentType = keyof typeof PHOTO_TYPES;

export const PHOTO_ACCEPT = ".jpg,.jpeg,.png,.heic,.heif,image/jpeg,image/png,image/heic,image/heif";

export const PHOTO_VARIANTS = {
  thumb: { width: 320, height: 240, resize: "cover" },
  medium: { width: 1024, height: 768, resize: "contain" },
  large: { width: 2048, height: 1536, resize: "contain" },
} as const;
export type PhotoVariant = keyof typeof PHOTO_VARIANTS | "original";

const EXT_TYPES: Record<string, PhotoContentType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
};

/** Validates a picked file. Browsers often report HEIC with an empty type, so fall back to the extension. */
export function validatePhotoFile(file: { name: string; type: string; size: number }):
  | { ok: true; contentType: PhotoContentType; extension: string }
  | { ok: false; error: string } {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const contentType = file.type in PHOTO_TYPES ? (file.type as PhotoContentType) : EXT_TYPES[ext];
  if (!contentType) return { ok: false, error: `${file.name}: only JPEG, PNG and HEIC photos are supported.` };
  if (file.size <= 0) return { ok: false, error: `${file.name} is empty.` };
  if (file.size > MAX_PHOTO_BYTES) return { ok: false, error: `${file.name} is larger than 25 MB.` };
  return { ok: true, contentType, extension: PHOTO_TYPES[contentType] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function photoPath(accountId: string, listingId: string, fileId: string, extension: string): string {
  return `${accountId}/${listingId}/${fileId}.${extension}`;
}

/** Same structure rule as private.can_edit_listing_photo_path (permissions are checked in the DB). */
export function isPhotoPathFor(path: string, accountId: string, listingId: string): boolean {
  const parts = path.split("/");
  return (
    parts.length === 3 &&
    UUID.test(accountId) &&
    UUID.test(listingId) &&
    parts[0] === accountId &&
    parts[1] === listingId &&
    /^[A-Za-z0-9_-]{1,100}\.(jpe?g|png|heic|heif)$/.test(parts[2])
  );
}

/** Public URL of a photo variant. */
export function photoUrl(supabaseUrl: string, path: string, variant: PhotoVariant = "medium"): string {
  const base = supabaseUrl.replace(/\/$/, "");
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  if (variant === "original") return `${base}/storage/v1/object/public/${PHOTO_BUCKET}/${encoded}`;
  const v = PHOTO_VARIANTS[variant];
  const qs = new URLSearchParams({ width: String(v.width), height: String(v.height), resize: v.resize, quality: "80" });
  return `${base}/storage/v1/render/image/public/${PHOTO_BUCKET}/${encoded}?${qs}`;
}
