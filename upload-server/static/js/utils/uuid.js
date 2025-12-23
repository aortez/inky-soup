/**
 * UUID generation utility.
 * Provides a cross-browser UUID generator that works in insecure contexts (HTTP).
 */

/**
 * Generate a random UUID v4.
 * Uses crypto.randomUUID() if available (secure context), otherwise falls back
 * to crypto.getRandomValues() which works in both secure and insecure contexts.
 * @returns {string} A random UUID v4 string.
 */
export function generateUUID() {
  // Use native randomUUID if available (requires secure context in most browsers).
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback: generate UUID v4 using crypto.getRandomValues().
  // This works in insecure contexts (HTTP) where randomUUID is not available.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Set version (4) and variant (8, 9, A, or B) bits per RFC 4122.
  /* eslint-disable no-bitwise */
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4.
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10xx.
  /* eslint-enable no-bitwise */

  // Convert to hex string with dashes.
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
