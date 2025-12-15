/**
 * Utility functions for formatting display values.
 */

/**
 * Format bytes into human-readable size.
 * @param {number} bytes - The number of bytes.
 * @returns {string} Formatted size string (e.g., "1.5 KB", "2.43 MB").
 */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format bytes per second into human-readable speed.
 * @param {number} bytesPerSec - The number of bytes per second.
 * @returns {string} Formatted speed string (e.g., "150.0 KB/s").
 */
export function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

/**
 * Format seconds into MM:SS time format.
 * @param {number} seconds - The number of seconds.
 * @returns {string} Formatted time string (e.g., "1:05", "12:30").
 */
export function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}
