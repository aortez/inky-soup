//! Flash queue module for async e-ink display updates.
//!
//! Manages a queue of flash jobs that are processed by a background worker.
//! This allows the HTTP endpoint to return immediately while the actual
//! flashing happens asynchronously.

use log::{debug, error, info, warn};
use rocket::serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time;

use crate::{
    display_settings,
    slideshow::{FlashSource, SlideshowState},
};

/// Shared flash queue state type.
pub type FlashQueueState = Arc<Mutex<FlashQueue>>;

/// Status of a flash job.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(crate = "rocket::serde")]
pub enum FlashJobStatus {
    /// Job is waiting in queue.
    Queued,
    /// Job is currently being flashed to display.
    Flashing,
    /// Job completed successfully.
    Completed,
    /// Job failed with error.
    Failed,
}

const FINISHED_JOB_RETENTION_MS: u64 = 30_000;

/// A single flash job.
#[derive(Debug, Clone, Serialize)]
#[serde(crate = "rocket::serde")]
pub struct FlashJob {
    #[serde(skip)]
    pub automatic_recovery: bool,
    #[serde(skip)]
    pub rescue_display: Option<crate::rescue::DisplayStamp>,
    pub source: FlashSource,
    /// Unique job identifier.
    pub job_id: u64,
    /// Original filename (for display).
    pub filename: String,
    /// Path to immutable flash snapshot image file.
    pub dithered_path: String,
    /// Whether to flash twice.
    pub flash_twice: bool,
    /// Physical display mounting rotation captured at queue time.
    pub rotation_degrees: u16,
    /// Job state.
    pub status: FlashJobStatus,
    /// When the job was created (Unix timestamp in milliseconds).
    pub created_at: u64,
    /// When the job started processing (Unix timestamp in milliseconds).
    pub started_at: Option<u64>,
    /// When the job finished (Unix timestamp in milliseconds).
    pub finished_at: Option<u64>,
    /// Error message (if job failed).
    pub error_message: Option<String>,
}

/// The flash queue and current job state.
#[derive(Debug)]
pub struct FlashQueue {
    pub(crate) rescue: Option<crate::rescue::Rescue>,
    /// Current job being processed (if any).
    current_job: Option<FlashJob>,
    /// Queued jobs waiting to be processed.
    queue: VecDeque<FlashJob>,
    /// Recently finished jobs retained briefly for status polling.
    recent_jobs: VecDeque<FlashJob>,
    /// Monotonically increasing job ID counter.
    next_job_id: u64,
}

impl FlashQueue {
    /// Creates a new empty flash queue.
    pub fn new() -> Self {
        Self {
            rescue: None,
            current_job: None,
            queue: VecDeque::new(),
            recent_jobs: VecDeque::new(),
            next_job_id: 1,
        }
    }

    /// Adds a job to the queue and returns the job ID.
    pub fn enqueue(
        &mut self,
        filename: String,
        dithered_path: String,
        flash_twice: bool,
        rotation_degrees: u16,
    ) -> u64 {
        self.enqueue_with_source(
            filename,
            dithered_path,
            flash_twice,
            rotation_degrees,
            FlashSource::Manual,
        )
    }

    pub fn is_idle(&self) -> bool {
        self.queue.is_empty()
            && !self.current_job.as_ref().is_some_and(|job| {
                matches!(
                    job.status,
                    FlashJobStatus::Queued | FlashJobStatus::Flashing
                )
            })
    }

    pub fn enqueue_with_source(
        &mut self,
        filename: String,
        dithered_path: String,
        flash_twice: bool,
        rotation_degrees: u16,
        source: FlashSource,
    ) -> u64 {
        if source == FlashSource::Manual {
            self.cancel_recovery_jobs(None, false);
            if let Some(rescue) = self.rescue.as_mut() {
                rescue.manual_requested();
            }
        }
        let job_id = self.next_job_id;
        self.next_job_id += 1;

        let job = FlashJob {
            automatic_recovery: false,
            rescue_display: self
                .rescue
                .as_ref()
                .map(|_| crate::rescue::DisplayStamp::current()),
            source,
            job_id,
            filename,
            dithered_path,
            flash_twice,
            rotation_degrees,
            status: FlashJobStatus::Queued,
            created_at: current_time_millis(),
            started_at: None,
            finished_at: None,
            error_message: None,
        };

        self.queue.push_back(job);
        job_id
    }

    pub(crate) fn mark_automatic_recovery(&mut self, id: u64) {
        if let Some(job) = self.queue.back_mut().filter(|job| job.job_id == id) {
            job.automatic_recovery = true;
        }
    }

    pub(crate) fn cancel_recovery_jobs(
        &mut self,
        source: Option<FlashSource>,
        automatic_only: bool,
    ) {
        let mut remaining = VecDeque::new();
        while let Some(mut job) = self.queue.pop_front() {
            if matches!(job.source, FlashSource::Rescue | FlashSource::Restore)
                && source.is_none_or(|source| source == job.source)
                && (!automatic_only || job.automatic_recovery)
            {
                let _ = std::fs::remove_file(&job.dithered_path);
                job.status = FlashJobStatus::Failed;
                job.finished_at = Some(current_time_millis());
                job.error_message =
                    Some("Recovery job superseded by connectivity or a manual image".into());
                self.recent_jobs.push_back(job);
            } else {
                remaining.push_back(job);
            }
        }
        self.queue = remaining;
    }

    /// Takes the next job from the queue (if any) and marks it as current.
    fn dequeue(&mut self) -> Option<FlashJob> {
        if let Some(ref current) = self.current_job {
            match current.status {
                FlashJobStatus::Flashing | FlashJobStatus::Queued => return None,
                FlashJobStatus::Completed | FlashJobStatus::Failed => {
                    self.recent_jobs.push_back(current.clone());
                    self.current_job = None;
                }
            }
        }

        self.queue.pop_front().map(|mut job| {
            job.status = FlashJobStatus::Flashing;
            job.started_at = Some(current_time_millis());
            self.current_job = Some(job.clone());
            job
        })
    }

    /// Marks the current job as completed.
    fn mark_completed(&mut self) {
        if let Some(ref mut job) = self.current_job {
            job.status = FlashJobStatus::Completed;
            job.finished_at = Some(current_time_millis());
        }
    }

    /// Marks the current job as failed.
    fn mark_failed(&mut self, error: String) {
        if let Some(ref mut job) = self.current_job {
            job.status = FlashJobStatus::Failed;
            job.finished_at = Some(current_time_millis());
            job.error_message = Some(error);
        }
    }

    /// Clears completed/failed job from current_job slot after delay.
    fn clear_current_if_finished(&mut self) {
        self.prune_recent_jobs();

        if let Some(ref job) = self.current_job {
            if matches!(
                job.status,
                FlashJobStatus::Completed | FlashJobStatus::Failed
            ) {
                if let Some(finished_at) = job.finished_at {
                    let now = current_time_millis();
                    if now > finished_at && (now - finished_at) > FINISHED_JOB_RETENTION_MS {
                        self.current_job = None;
                    }
                }
            }
        }
    }

    fn prune_recent_jobs(&mut self) {
        let now = current_time_millis();
        while let Some(job) = self.recent_jobs.front() {
            let is_expired = match job.finished_at {
                Some(finished_at) => {
                    now > finished_at && (now - finished_at) > FINISHED_JOB_RETENTION_MS
                }
                None => true,
            };

            if !is_expired {
                break;
            }

            self.recent_jobs.pop_front();
        }
    }

    /// Gets the queue position for a job ID (0 = currently flashing, 1+ = queued).
    pub fn get_position(&self, job_id: u64) -> Option<usize> {
        if let Some(ref current) = self.current_job {
            if current.job_id == job_id {
                return Some(0);
            }
        }

        self.queue
            .iter()
            .position(|job| job.job_id == job_id)
            .map(|pos| pos + 1)
    }

    /// Gets a clone of the current job (if any).
    pub fn get_current_job(&self) -> Option<FlashJob> {
        self.current_job.clone()
    }

    /// Gets a clone of all queued jobs.
    pub fn get_queued_jobs(&self) -> Vec<FlashJob> {
        self.queue.iter().cloned().collect()
    }

    /// Finds a job by ID across current, queued, and recently finished jobs.
    pub fn find_job(&self, job_id: u64) -> Option<FlashJob> {
        if let Some(ref current) = self.current_job {
            if current.job_id == job_id {
                return Some(current.clone());
            }
        }

        if let Some(job) = self.queue.iter().find(|job| job.job_id == job_id) {
            return Some(job.clone());
        }

        self.recent_jobs
            .iter()
            .find(|job| job.job_id == job_id)
            .cloned()
    }
}

impl Default for FlashQueue {
    fn default() -> Self {
        Self::new()
    }
}

/// Gets current time as Unix timestamp in milliseconds.
pub(crate) fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Spawns the background flash worker task.
pub fn spawn_flash_worker(queue_state: FlashQueueState, slideshow: SlideshowState) {
    tokio::spawn(async move {
        info!("Flash queue worker started");
        loop {
            if !process_next(&queue_state, &slideshow).await {
                time::sleep(Duration::from_millis(500)).await;
            }
        }
    });
}

pub(crate) async fn process_next(
    queue_state: &FlashQueueState,
    slideshow: &SlideshowState,
) -> bool {
    // Check for next job.
    let job = {
        let mut queue = queue_state.lock().await;
        queue.clear_current_if_finished();
        queue.dequeue()
    };

    let Some(job) = job else {
        return false;
    };
    let flash_rotation_degrees =
        display_settings::compute_flash_rotation_degrees(job.rotation_degrees);
    info!(
        "Processing flash job {}: {} (flash_twice: {}, mount_rotation: {}, flash_rotation: {})",
        job.job_id, job.filename, job.flash_twice, job.rotation_degrees, flash_rotation_degrees
    );

    let prepare = queue_state
        .lock()
        .await
        .rescue
        .as_mut()
        .map(|rescue| rescue.before_flash(&job))
        .unwrap_or(Ok(()));
    let result = match prepare {
        Ok(()) => execute_flash(&job.dithered_path, job.flash_twice, flash_rotation_degrees).await,
        Err(error) => Err(error),
    };
    // Save the previous display before deleting its immutable queue snapshot.
    if let Some(rescue) = queue_state.lock().await.rescue.as_mut() {
        rescue.finished(&job, result.is_ok());
    }
    if let Err(e) = cleanup_flash_snapshot(&job.dithered_path).await {
        warn!(
            "Failed to clean flash snapshot for job {} ({}): {}",
            job.job_id, job.dithered_path, e
        );
    }

    // Update queue state.
    let mut queue = queue_state.lock().await;
    // Record completion before exposing an idle queue to the scheduler.
    slideshow
        .lock()
        .await
        .flash_finished(&job, result.is_ok(), current_time_millis());
    match result {
        Ok(()) => {
            info!("Flash job {} completed successfully", job.job_id);
            queue.mark_completed();
        }
        Err(e) => {
            error!("Flash job {} failed: {}", job.job_id, e);
            queue.mark_failed(e);
        }
    }
    true
}

/// Executes the actual flash operation by running the Python script.
async fn execute_flash(
    dithered_path: &str,
    flash_twice: bool,
    rotation_degrees: u16,
) -> Result<(), String> {
    debug!("Executing flash script for {}", dithered_path);

    let display_command = std::env::var("INKY_SOUP_DISPLAY_COMMAND")
        .unwrap_or_else(|_| "/usr/bin/inky-soup-update-display".into());
    let output = Command::new(&display_command)
        .arg(dithered_path)
        .arg("--skip-dither")
        .arg("--rotation")
        .arg(rotation_degrees.to_string())
        .output()
        .await
        .map_err(|e| format!("Failed to execute script: {}", e))?;

    if !output.status.success() {
        let exit_code = output.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Flash failed (exit code {}): {}",
            exit_code,
            stderr.trim()
        ));
    }

    // Maybe flash again.
    if flash_twice {
        debug!("Executing second flash for {}", dithered_path);

        let output2 = Command::new(&display_command)
            .arg(dithered_path)
            .arg("--skip-dither")
            .arg("--rotation")
            .arg(rotation_degrees.to_string())
            .output()
            .await
            .map_err(|e| format!("Failed to execute second flash: {}", e))?;

        if !output2.status.success() {
            let exit_code = output2.status.code().unwrap_or(-1);
            let stderr = String::from_utf8_lossy(&output2.stderr);
            return Err(format!(
                "Second flash failed (exit code {}): {}",
                exit_code,
                stderr.trim()
            ));
        }
    }

    Ok(())
}

async fn cleanup_flash_snapshot(path: &str) -> Result<(), String> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cleanup failed: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_enqueue_increments_job_id() {
        let mut queue = FlashQueue::new();
        let id1 = queue.enqueue("a.jpg".into(), "path/a.jpg.png".into(), false, 0);
        let id2 = queue.enqueue("b.jpg".into(), "path/b.jpg.png".into(), false, 90);
        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
    }

    #[test]
    fn test_get_position() {
        let mut queue = FlashQueue::new();
        let id1 = queue.enqueue("a.jpg".into(), "path/a.jpg.png".into(), false, 0);
        let id2 = queue.enqueue("b.jpg".into(), "path/b.jpg.png".into(), false, 0);
        let id3 = queue.enqueue("c.jpg".into(), "path/c.jpg.png".into(), false, 0);

        // All in queue, positions are 1, 2, 3.
        assert_eq!(queue.get_position(id1), Some(1));
        assert_eq!(queue.get_position(id2), Some(2));
        assert_eq!(queue.get_position(id3), Some(3));

        // Dequeue first job - now it's current (position 0).
        queue.dequeue();
        assert_eq!(queue.get_position(id1), Some(0));
        assert_eq!(queue.get_position(id2), Some(1));
        assert_eq!(queue.get_position(id3), Some(2));
    }

    #[test]
    fn test_dequeue_fifo_order() {
        let mut queue = FlashQueue::new();
        queue.enqueue("first.jpg".into(), "path/first.jpg.png".into(), false, 0);
        queue.enqueue("second.jpg".into(), "path/second.jpg.png".into(), true, 270);

        let job1 = queue.dequeue().unwrap();
        assert_eq!(job1.filename, "first.jpg");
        assert!(!job1.flash_twice);

        // First job is now current, clear it.
        queue.current_job = None;

        let job2 = queue.dequeue().unwrap();
        assert_eq!(job2.filename, "second.jpg");
        assert!(job2.flash_twice);
        assert_eq!(job2.rotation_degrees, 270);
    }

    #[test]
    fn test_job_status_transitions() {
        let mut queue = FlashQueue::new();
        queue.enqueue("test.jpg".into(), "path/test.jpg.png".into(), false, 180);

        // Job starts as Queued.
        let queued_job = queue.queue.front().unwrap();
        assert_eq!(queued_job.status, FlashJobStatus::Queued);

        // Dequeue marks as Flashing.
        let job = queue.dequeue().unwrap();
        assert_eq!(job.status, FlashJobStatus::Flashing);

        // Mark completed.
        queue.mark_completed();
        let current = queue.get_current_job().unwrap();
        assert_eq!(current.status, FlashJobStatus::Completed);
    }

    #[test]
    fn test_nonexistent_job_position() {
        let queue = FlashQueue::new();
        assert_eq!(queue.get_position(999), None);
    }

    #[test]
    fn test_finished_job_retained_while_next_job_flashing() {
        let mut queue = FlashQueue::new();
        let first_id = queue.enqueue("first.jpg".into(), "path/first.jpg.png".into(), false, 0);
        let second_id = queue.enqueue("second.jpg".into(), "path/second.jpg.png".into(), false, 90);

        // Start and complete first job.
        queue.dequeue();
        queue.mark_completed();

        // Start second job; first should move to retained jobs.
        let second = queue.dequeue().unwrap();
        assert_eq!(second.job_id, second_id);
        assert_eq!(second.status, FlashJobStatus::Flashing);

        let first = queue
            .find_job(first_id)
            .expect("first job should still be retained");
        assert_eq!(first.status, FlashJobStatus::Completed);
    }
}
