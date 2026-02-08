//! Image locking system for multi-user edit protection.
//!
//! Provides exclusive edit access to images in detail view.
//! Only one user can edit an image at a time.

use log::{debug, warn};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Lock duration before automatic expiry.
/// Can be overridden via LOCK_DURATION_SECS environment variable for testing.
pub fn get_lock_duration_secs() -> u64 {
    std::env::var("LOCK_DURATION_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30)
}

pub const LOCK_DURATION_SECS: u64 = 30;

/// Represents a lock on a specific image.
#[derive(Debug, Clone)]
pub struct ImageLock {
    /// Session ID that owns the lock.
    pub session_id: String,
    /// When the lock expires (auto-released if not refreshed).
    pub expires_at: Instant,
}

/// Shared state for image locks.
pub type ImageLocksState = Arc<Mutex<HashMap<String, ImageLock>>>;

/// Attempts to acquire a lock on an image.
///
/// Returns Ok(true) if lock acquired.
/// Returns Ok(false) if already locked by another session.
pub async fn try_acquire_lock(
    locks: &ImageLocksState,
    filename: &str,
    session_id: &str,
    refresh_only: bool,
) -> Result<bool, String> {
    let mut locks_map = locks.lock().await;

    // Clean up expired locks first.
    let now = Instant::now();
    locks_map.retain(|_, lock| lock.expires_at > now);

    // Check if image is already locked.
    if let Some(existing_lock) = locks_map.get(filename) {
        // Same session can refresh their own lock.
        if existing_lock.session_id == session_id {
            locks_map.insert(
                filename.to_string(),
                ImageLock {
                    session_id: session_id.to_string(),
                    expires_at: now + Duration::from_secs(get_lock_duration_secs()),
                },
            );
            debug!("Lock refreshed: {} (session: {})", filename, session_id);
            return Ok(true);
        }

        // Different session - lock is held by someone else.
        let remaining = existing_lock.expires_at.saturating_duration_since(now);
        debug!(
            "Lock denied: {} already locked by {} (expires in {}s)",
            filename,
            existing_lock.session_id,
            remaining.as_secs()
        );
        return Ok(false);
    }

    // Keepalive refresh should not reacquire a missing lock.
    if refresh_only {
        debug!("Lock refresh denied: {} has no active lock", filename);
        return Ok(false);
    }

    // No existing lock - acquire it.
    locks_map.insert(
        filename.to_string(),
        ImageLock {
            session_id: session_id.to_string(),
            expires_at: now + Duration::from_secs(get_lock_duration_secs()),
        },
    );

    debug!("Lock acquired: {} (session: {})", filename, session_id);
    Ok(true)
}

/// Releases a lock on an image.
///
/// Only the session that owns the lock can release it.
pub async fn release_lock(
    locks: &ImageLocksState,
    filename: &str,
    session_id: &str,
) -> Result<bool, String> {
    let mut locks_map = locks.lock().await;

    if let Some(existing_lock) = locks_map.get(filename) {
        if existing_lock.session_id == session_id {
            locks_map.remove(filename);
            debug!("Lock released: {} (session: {})", filename, session_id);
            return Ok(true);
        }

        warn!(
            "Lock release denied: {} owned by {}, requested by {}",
            filename, existing_lock.session_id, session_id
        );
        return Ok(false);
    }

    // No lock exists - that's fine.
    Ok(true)
}

/// Checks if a session owns the lock for an image.
pub async fn verify_lock_ownership(
    locks: &ImageLocksState,
    filename: &str,
    session_id: &str,
) -> Result<bool, String> {
    let mut locks_map = locks.lock().await;

    // Clean up expired locks first.
    let now = Instant::now();
    locks_map.retain(|_, lock| lock.expires_at > now);

    if let Some(existing_lock) = locks_map.get(filename) {
        return Ok(existing_lock.session_id == session_id);
    }

    // No lock exists - operation not allowed.
    Ok(false)
}

/// Gets remaining lock time in seconds for an image.
pub async fn get_lock_remaining_secs(
    locks: &ImageLocksState,
    filename: &str,
) -> Option<u64> {
    let locks_map = locks.lock().await;
    let now = Instant::now();

    locks_map.get(filename).map(|lock| {
        lock.expires_at
            .saturating_duration_since(now)
            .as_secs()
    })
}
