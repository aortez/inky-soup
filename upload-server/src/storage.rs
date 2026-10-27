//! The storage lock serializes every change to photo files and metadata with
//! the checks that allow it.
//!
//! Uploads, photo rotation, favorites, deletion, display orientation changes,
//! display snapshots, rescue, the slideshow scheduler and the cleanup worker
//! all take it. Take the flash queue and then the edit locks after it, never
//! before.
use crate::image_locks::{self, ImageLocksState};
use std::sync::Arc;
use tokio::sync::{Mutex, MutexGuard};

pub type StorageLock = Arc<Mutex<()>>;
pub type StorageGuard<'a> = MutexGuard<'a, ()>;

/// Takes the storage lock for a change to `filename` by the session holding
/// its unexpired edit lock. Hold the guard until the change has been written.
pub async fn lock_for_editor<'a>(
    storage: &'a StorageLock,
    locks: &ImageLocksState,
    filename: &str,
    session_id: &str,
) -> Option<StorageGuard<'a>> {
    let guard = storage.lock().await;
    image_locks::is_editor(&*locks.lock().await, filename, session_id).then_some(guard)
}
