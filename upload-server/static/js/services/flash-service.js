/**
 * Flash service for managing flash jobs.
 * Handles job submission, status polling, and UI updates.
 */

import { FLASH_DURATION_MS } from '../core/constants.js';
import {
  getCurrentFilename,
  setCurrentFilename,
  getCurrentFilter,
  getCurrentSaturation,
  getCurrentBrightness,
  getCurrentContrast,
  getCurrentDitherAlgorithm,
  setCurrentJobId,
  getPollInterval,
  setPollInterval,
} from '../core/state.js';
import { elements, query } from '../core/dom.js';
import {
  uploadDithered, submitFlashJob, getJobStatus, getFlashStatus,
} from './api-client.js';

/**
 * Flash the current dithered image to the e-ink display.
 */
export async function flashImage() {
  const { flashBtn } = elements;
  flashBtn.disabled = true;

  const flashTwice = elements.flashTwiceCheckbox.checked;
  const filename = getCurrentFilename();
  const filter = getCurrentFilter();
  const saturation = getCurrentSaturation();
  const brightness = getCurrentBrightness();
  const contrast = getCurrentContrast();
  const ditherAlgorithm = getCurrentDitherAlgorithm();

  try {
    // Convert dithered canvas to blob.
    const blob = await new Promise((resolve) => {
      elements.ditherCanvas.toBlob(resolve, 'image/png');
    });

    // Upload dithered image with all settings.
    const uploadData = await uploadDithered(
      filename,
      blob,
      filter,
      saturation,
      brightness,
      contrast,
      ditherAlgorithm,
    );

    if (!uploadData.success) {
      alert(`Failed to upload dithered image: ${uploadData.message}`);
      flashBtn.disabled = false;
      return;
    }

    // Update gallery thumbnail data attributes (so reopening restores settings).
    const galleryThumb = query(`img[data-filename="${filename}"]`);
    if (galleryThumb) {
      galleryThumb.dataset.filter = filter;
      galleryThumb.dataset.saturation = saturation.toString();
      galleryThumb.dataset.brightness = brightness.toString();
      galleryThumb.dataset.contrast = contrast.toString();
      galleryThumb.dataset.dither = ditherAlgorithm;
    }

    // Submit flash job.
    const flashData = await submitFlashJob(filename, flashTwice);

    if (!flashData.success) {
      alert(`Failed to queue flash: ${flashData.message}`);
      flashBtn.disabled = false;
      return;
    }

    // Start tracking the job.
    setCurrentJobId(flashData.job_id);
    startFlashTracking(flashData.job_id, flashTwice);
    // Button stays disabled until flash completes.
  } catch (err) {
    alert(`Error: ${err.message}`);
    flashBtn.disabled = false;
  }
}

/**
 * Start tracking a flash job.
 * Shows status bar and begins polling.
 * @param {string} jobId - The flash job ID.
 * @param {boolean} flashTwice - Whether flashing twice.
 */
export function startFlashTracking(jobId, flashTwice) {
  const filename = getCurrentFilename();

  // Show status bar.
  elements.flashStatusBar.classList.add('visible');
  elements.statusText.textContent = `Queued: ${filename}`;
  elements.statusProgress.style.width = '0%';
  elements.statusProgress.classList.remove('complete', 'failed');
  elements.statusIcon.textContent = '⏳';

  // Set up flash modal.
  elements.flashModalImage.src = `images/cache/${filename}.png`;
  elements.flashModalFilename.textContent = filename;
  elements.flashModalTitle.textContent = 'Flash Job Queued';
  elements.flashModalTitle.style.color = '#B8956A';
  elements.flashModalNote.textContent = 'Waiting in queue...';
  elements.flashModalClose.style.display = 'none';
  elements.flashProgress1.style.width = '0%';
  elements.flashProgress1.classList.remove('complete');
  elements.flashProgress2.style.width = '0%';
  elements.flashProgress2.classList.remove('complete');
  elements.flashProgress2Container.style.display = flashTwice ? 'block' : 'none';

  const flashProgress1Label = query('#flashProgress1Container .progress-label');
  if (flashProgress1Label) {
    flashProgress1Label.textContent = flashTwice ? 'Flash 1' : 'Flashing...';
  }

  // Start polling.
  const existingInterval = getPollInterval();
  if (existingInterval) clearInterval(existingInterval);

  const interval = setInterval(() => pollJobStatus(jobId, flashTwice), 1000);
  setPollInterval(interval);
}

/**
 * Poll the status of a flash job.
 * @param {string} jobId - The flash job ID.
 * @param {boolean} flashTwice - Whether flashing twice.
 */
export async function pollJobStatus(jobId, flashTwice) {
  try {
    const job = await getJobStatus(jobId);
    updateFlashStatus(job, flashTwice);

    // Stop polling if job is done.
    if (job.status === 'Completed' || job.status === 'Failed') {
      const interval = getPollInterval();
      if (interval) clearInterval(interval);
      setPollInterval(null);
    }
  } catch (err) {
    // Job not found - stop polling.
    console.error('Poll error:', err);
    const interval = getPollInterval();
    if (interval) clearInterval(interval);
    setPollInterval(null);
  }
}

/**
 * Update flash status UI based on job data.
 * @param {Object} job - The job data.
 * @param {boolean} flashTwice - Whether flashing twice.
 */
export function updateFlashStatus(job, flashTwice) {
  switch (job.status) {
    case 'Queued':
      elements.statusIcon.textContent = '⏳';
      elements.statusText.textContent = `Queued: ${job.filename}`;
      elements.statusProgress.style.width = '0%';
      elements.flashModalTitle.textContent = 'Flash Job Queued';
      elements.flashModalNote.textContent = 'Waiting in queue...';
      break;

    case 'Flashing':
      elements.statusIcon.textContent = '⚡';
      elements.statusText.textContent = `Flashing: ${job.filename}`;
      elements.flashModalTitle.textContent = 'Flashing to Display';
      elements.flashModalNote.textContent = 'This takes about 40 seconds per flash...';

      // Calculate progress based on elapsed time.
      if (job.started_at) {
        const elapsed = Date.now() - job.started_at;
        const totalDuration = flashTwice ? FLASH_DURATION_MS * 2 : FLASH_DURATION_MS;
        const progress = Math.min(95, (elapsed / totalDuration) * 100);
        elements.statusProgress.style.width = `${progress}%`;

        // Update modal progress bars.
        const progress1 = Math.min(100, (elapsed / FLASH_DURATION_MS) * 100);
        elements.flashProgress1.style.width = `${progress1}%`;

        if (flashTwice && elapsed > FLASH_DURATION_MS) {
          elements.flashProgress1.classList.add('complete');
          const progress2 = Math.min(
            100,
            ((elapsed - FLASH_DURATION_MS) / FLASH_DURATION_MS) * 100,
          );
          elements.flashProgress2.style.width = `${progress2}%`;
        }
      }
      break;

    case 'Completed':
      elements.statusIcon.textContent = '✓';
      elements.statusText.textContent = `Complete: ${job.filename}`;
      elements.statusProgress.style.width = '100%';
      elements.statusProgress.classList.add('complete');
      elements.flashProgress1.style.width = '100%';
      elements.flashProgress1.classList.add('complete');
      if (flashTwice) {
        elements.flashProgress2.style.width = '100%';
        elements.flashProgress2.classList.add('complete');
      }
      elements.flashModalTitle.textContent = '✓ Flash Complete!';
      elements.flashModalTitle.style.color = '#6B8E4E';
      elements.flashModalNote.textContent = 'Image sent to display.';
      elements.flashModalClose.style.display = 'block';

      // Re-enable flash button.
      elements.flashBtn.disabled = false;

      // Hide status bar after 5 seconds.
      setTimeout(() => {
        elements.flashStatusBar.classList.remove('visible');
      }, 5000);
      break;

    case 'Failed':
      elements.statusIcon.textContent = '✗';
      elements.statusText.textContent = `Failed: ${job.filename}`;
      elements.statusProgress.style.width = '100%';
      elements.statusProgress.classList.add('failed');
      elements.flashModalTitle.textContent = '✗ Flash Failed';
      elements.flashModalTitle.style.color = '#ff6b6b';
      elements.flashModalNote.textContent = job.error_message || 'Unknown error';
      elements.flashModalClose.style.display = 'block';

      // Re-enable flash button.
      elements.flashBtn.disabled = false;
      break;

    default:
      break;
  }
}

/**
 * Expand the flash modal to full view.
 */
export function expandFlashModal() {
  elements.flashModal.classList.add('active');
}

/**
 * Close the flash modal.
 */
export function closeFlashModal() {
  elements.flashModal.classList.remove('active');
}

/**
 * Check global flash status on page load.
 * Resumes tracking if there's an active job.
 */
export async function checkGlobalFlashStatus() {
  try {
    const data = await getFlashStatus();

    const currentJob = data.current_job;
    if (currentJob && (currentJob.status === 'Queued' || currentJob.status === 'Flashing')) {
      // There's an active job - show status bar and track it.
      setCurrentJobId(currentJob.job_id);
      setCurrentFilename(currentJob.filename);

      const flashTwice = currentJob.flash_twice;

      elements.flashStatusBar.classList.add('visible');

      // Set up tracking.
      const existingInterval = getPollInterval();
      if (!existingInterval) {
        const interval = setInterval(
          () => pollJobStatus(currentJob.job_id, flashTwice),
          1000,
        );
        setPollInterval(interval);
      }

      // Update status immediately.
      updateFlashStatus(currentJob, flashTwice);
    }
  } catch (err) {
    console.error('Failed to check global flash status:', err);
  }
}
