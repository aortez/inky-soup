/**
 * Centralized application state management.
 * All state variables are private and accessed via exported getters/setters.
 */

// Display configuration (fetched from server, defaults to 13.3" Inky Impression 2025).
let displayConfig = {
  width: 1600,
  height: 1200,
  thumbWidth: 150,
  thumbHeight: 112,
  logicalWidth: 1600,
  logicalHeight: 1200,
  logicalThumbWidth: 150,
  logicalThumbHeight: 112,
  physicalWidth: 1600,
  physicalHeight: 1200,
  physicalThumbWidth: 150,
  physicalThumbHeight: 112,
  rotationDegrees: 0,
  model: 'impression-13.3-2025',
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
let currentFitMode = 'contain';
let currentCacheVersion = 1;

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

// Upload queue state.
let uploadQueue = [];
let uploadQueueActive = false;
let uploadQueueCurrentId = null;

// Image lock state.
let currentSessionId = null;
let lockKeepaliveInterval = null;
let isReadOnly = false;

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

export const getCurrentFitMode = () => currentFitMode;
export const setCurrentFitMode = (mode) => {
  currentFitMode = mode;
};

export const getCurrentCacheVersion = () => currentCacheVersion;
export const setCurrentCacheVersion = (version) => {
  currentCacheVersion = version;
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

// Upload queue getters/setters.
export const getUploadQueue = () => uploadQueue;
export const setUploadQueue = (queue) => { uploadQueue = queue; };

export const getUploadQueueActive = () => uploadQueueActive;
export const setUploadQueueActive = (active) => { uploadQueueActive = active; };

export const getUploadQueueCurrentId = () => uploadQueueCurrentId;
export const setUploadQueueCurrentId = (id) => { uploadQueueCurrentId = id; };

// Display configuration getters/setters.
export const getDisplayConfig = () => displayConfig;
export const setDisplayConfig = (config) => {
  displayConfig = { ...displayConfig, ...config };
};
export const getDisplayWidth = () => displayConfig.width;
export const getDisplayHeight = () => displayConfig.height;
export const getThumbWidth = () => displayConfig.thumbWidth;
export const getThumbHeight = () => displayConfig.thumbHeight;
export const getPhysicalDisplayWidth = () => displayConfig.physicalWidth;
export const getPhysicalDisplayHeight = () => displayConfig.physicalHeight;
export const getPhysicalThumbWidth = () => displayConfig.physicalThumbWidth;
export const getPhysicalThumbHeight = () => displayConfig.physicalThumbHeight;
export const getLogicalDisplayWidth = () => displayConfig.logicalWidth;
export const getLogicalDisplayHeight = () => displayConfig.logicalHeight;
export const getLogicalThumbWidth = () => displayConfig.logicalThumbWidth;
export const getLogicalThumbHeight = () => displayConfig.logicalThumbHeight;
export const getRotationDegrees = () => displayConfig.rotationDegrees;

// Image lock getters/setters.
export const getCurrentSessionId = () => currentSessionId;
export const setCurrentSessionId = (id) => { currentSessionId = id; };

export const getLockKeepaliveInterval = () => lockKeepaliveInterval;
export const setLockKeepaliveInterval = (interval) => { lockKeepaliveInterval = interval; };

export const getIsReadOnly = () => isReadOnly;
export const setIsReadOnly = (readOnly) => { isReadOnly = readOnly; };
