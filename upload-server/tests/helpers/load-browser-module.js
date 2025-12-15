/**
 * Helper to load browser-style IIFE modules in Node.js tests.
 * Since package.json has "type": "module", we need to evaluate
 * the source files in a CommonJS-like context.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import vm from 'vm';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);

/**
 * Load a browser-style module that uses conditional CommonJS exports.
 * @param {string} relativePath - Path relative to static/js/.
 * @returns {object} The exported module.
 */
export function loadBrowserModule(relativePath) {
  const fullPath = resolve(currentDir, '../../static/js', relativePath);
  const code = readFileSync(fullPath, 'utf-8');

  // Create a context with module.exports available.
  const moduleObj = { exports: {} };
  const context = {
    module: moduleObj,
    exports: moduleObj.exports,
    console,
    Math,
    Infinity,
    parseFloat,
    ImageData: globalThis.ImageData,
    Uint8ClampedArray,
    Float32Array,
  };

  vm.createContext(context);
  vm.runInContext(code, context);

  return moduleObj.exports;
}
