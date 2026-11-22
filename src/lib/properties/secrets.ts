/**
 * PRP-12 / X-15: secret custom-field values (door codes, Wi-Fi passwords). Encrypted with
 * AES-256-GCM before they reach the database; the encryption context (AAD) binds a ciphertext to
 * its listing and field, so it cannot be replayed onto another row.
 */
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";

export const SECRET_MASK = "••••••";
/** What exports print instead of a secret value. */
export const SECRET_EXPORT_PLACEHOLDER = "[secret]";

export function customSecretContext(listingId: string, fieldId: string): string {
  return `listing_custom_value:${listingId}:${fieldId}`;
}

export function encryptCustomSecret(plaintext: string, key: Buffer, listingId: string, fieldId: string): string {
  return encryptSecret(plaintext, key, customSecretContext(listingId, fieldId));
}

export function decryptCustomSecret(ciphertext: string, key: Buffer, listingId: string, fieldId: string): string {
  return decryptSecret(ciphertext, key, customSecretContext(listingId, fieldId));
}
