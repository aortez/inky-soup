/**
 * Centralized application state management.
 * All state variables are private and accessed via exported getters/setters.
 */

// Display configuration (fetched from server, defaults to 5.7" Inky Impression).
let displayConfig = {
  width: 600,
  height: 448,
  thumbWidth: 150,
  thumbHeight: 112,
  model: 'impression-5.7-default',
  color: 'multi',
};

// View and navigation state.
let currentView = 'gallery';
let currentFilename = null;
let currentPath = null;

// Image processing state.
let currentFilter = 'bicubic';
let currentSaturation = 0.5;
let currentDitherAlgorithm = 'floyd-steinberg';
let currentBrightness = 0; // Range: -100 to +100.
let currentContrast = 0; // Range: -100 to +100.

// Worker state.
let filterWorker = null;
let ditherWorker = null;
let originalImageCache = {};

// Flash job tracking.
let currentJobId = null;
let pollInterval = null;

// Upload workers.
let uploadCacheWorker = null;
let uploadThumbWorker = null;

// Pending thumbnails (for upload coordination).
let pendingThumbnails = { cache: null, thumb: null };

// View state getters/setters.
export const getCurrentView = () => currentView;
export const setCurrentView = (view) => { currentView = view; };

export const getCurrentFilename = () => currentFilename;
export const setCurrentFilename = (filename) => { currentFilename = filename; };

export const getCurrentPath = () => currentPath;
export const setCurrentPath = (path) => { currentPath = path; };

// Image processing state getters/setters.
export const getCurrentFilter = () => currentFilter;
export const setCurrentFilter = (filter) => { currentFilter = filter; };

export const getCurrentSaturation = () => currentSaturation;
export const setCurrentSaturation = (saturation) => {
  currentSaturation = saturation;
};

export const getCurrentDitherAlgorithm = () => currentDitherAlgorithm;
export const setCurrentDitherAlgorithm = (algorithm) => {
  currentDitherAlgorithm = algorithm;
};

export const getCurrentBrightness = () => currentBrightness;
export const setCurrentBrightness = (brightness) => {
  currentBrightness = brightness;
};

export const getCurrentContrast = () => currentContrast;
export const setCurrentContrast = (contrast) => {
  currentContrast = contrast;
};

// Worker state getters/setters.
export const getFilterWorker = () => filterWorker;
export const setFilterWorker = (worker) => { filterWorker = worker; };

export const getDitherWorker = () => ditherWorker;
export const setDitherWorker = (worker) => { ditherWorker = worker; };

export const getOriginalImageCache = () => originalImageCache;
export const setOriginalImageCache = (cache) => { originalImageCache = cache; };

// Flash tracking getters/setters.
export const getCurrentJobId = () => currentJobId;
export const setCurrentJobId = (jobId) => { currentJobId = jobId; };

export const getPollInterval = () => pollInterval;
export const setPollInterval = (interval) => { pollInterval = interval; };

// Upload workers getters/setters.
export const getUploadCacheWorker = () => uploadCacheWorker;
export const setUploadCacheWorker = (worker) => { uploadCacheWorker = worker; };

export const getUploadThumbWorker = () => uploadThumbWorker;
export const setUploadThumbWorker = (worker) => { uploadThumbWorker = worker; };

// Pending thumbnails getters/setters.
export const getPendingThumbnails = () => pendingThumbnails;
export const setPendingThumbnails = (thumbnails) => {
  pendingThumbnails = thumbnails;
};

// Display configuration getters/setters.
export const getDisplayConfig = () => displayConfig;
export const setDisplayConfig = (config) => {
  displayConfig = { ...displayConfig, ...config };
};
export const getDisplayWidth = () => displayConfig.width;
export const getDisplayHeight = () => displayConfig.height;
export const getThumbWidth = () => displayConfig.thumbWidth;
export const getThumbHeight = () => displayConfig.thumbHeight;
