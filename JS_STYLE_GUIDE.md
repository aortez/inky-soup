# JavaScript Style Guide

## Async Code

**Use `async/await` over promise chains.**

```javascript
// Good
async function saveImage() {
  try {
    const result = await uploadCache(filename, blob);
    statusEl.textContent = '✓ Saved';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

// Avoid
function saveImage() {
  uploadCache(filename, blob)
    .then((result) => { statusEl.textContent = '✓ Saved'; })
    .catch((err) => { statusEl.textContent = `Error: ${err.message}`; });
}
```

Raw Promises are fine for wrapping callbacks:

```javascript
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}
```

## Exports

**Use named exports. No default exports.**

```javascript
// Good
export function applyFilter() { }
export const DEFAULT_FILTER = 'bicubic';

// Avoid
export default function applyFilter() { }
```

## Functions

Arrow functions for callbacks and simple getters. Function declarations for exported functions.

```javascript
// Callbacks
worker.onmessage = (e) => { };
items.forEach((item) => process(item));

// Simple getters/setters in state.js
export const getCurrentFilter = () => currentFilter;
export const setCurrentFilter = (filter) => { currentFilter = filter; };

// Exported functions
export function initFilterWorker() { }
export async function applyFilter() { }
```

## Module Organization

```
core/          → Foundation (constants, state, dom) - no cross-dependencies
services/      → Business logic - depends on core only
ui/            → UI components - depends on core + services
utils/         → Pure utility functions
lib/           → Legacy standalone scripts (Web Workers)
```

Import from less dependent to more dependent:

```javascript
import { DISPLAY_WIDTH } from '../core/constants.js';
import { getCurrentFilter } from '../core/state.js';
import { elements } from '../core/dom.js';
import { uploadCache } from '../services/api-client.js';
```

## State

All application state lives in `core/state.js`. Access via getters/setters.

```javascript
// Good - explicit state access.
import { getCurrentFilter, setCurrentFilter } from '../core/state.js';
const filter = getCurrentFilter();
setCurrentFilter('lanczos');

// Avoid - scattered state.
let currentFilter = 'bicubic'; // Don't do this in other modules.
```

## DOM

Query elements once in `core/dom.js`, reuse the cached references.

```javascript
// Good - use cached reference
import { elements } from '../core/dom.js';
elements.flashButton.disabled = true;

// Avoid - repeated queries.
document.getElementById('flash-button').disabled = true;
```

## Comments

End comments with periods. Conveys intent of ending the sentence,
rather than leaving it ambiguous and up to the reader to guess -
intentional sentence end or incorrectly copied/moved comment?

Explain why, not just what.

```javascript
// Good.
// Flash twice to overcome e-ink ghosting on high-contrast images.
if (flashTwice) { ... }

// Avoid
// flash twice
if (flashTwice) { ... }
```

## Alphabetical Ordering

Use alphabetical ordering when no other extremely obvious order exists.
Name things from higher to lower order, like ComponentYButtonEnd and ModualXButtonStart.


## Error Handling

- `try/catch` for async operations
- `console.error()` for debugging with context prefix
- `alert()` sparingly for blocking user errors

```javascript
try {
  await flashImage(filename);
} catch (err) {
  console.error('[Flash] Failed:', err);
  alert('Flash failed. Is the display connected?');
}
```

## Tooling

- **ESLint**: Airbnb base config. Run `npm run lint` before committing.
- **Vitest**: Unit tests in `tests/`. Run `npm test`.
