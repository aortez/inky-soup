/**
 * E-Ink Dithering Library
 *
 * Implements dithering algorithms for six- and seven-color Inky Impression displays.
 * Supports Floyd-Steinberg, Atkinson, and Ordered (Bayer) dithering.
 *
 * Based on: https://github.com/pimoroni/inky/blob/main/inky/inky_uc8159.py
 */

// ===========================================================================
// COMPILE-TIME CONFIGURATION
// ===========================================================================
// Set to true to use weighted RGB distance (better perceptual matching).
// Set to false for standard Euclidean RGB distance (matches original Inky lib).
const USE_WEIGHTED_RGB = true;
// ===========================================================================

// Matching colors come from Pimoroni's UC8159 and EL133UF1 drivers.
// Output colors encode ink identities independently of the saturation setting.
// CLEAN is a refresh command, not an additional image color.
const DISPLAY_PALETTES = {
    'impression-5.7': {
        saturated: [
            [57, 48, 57], [255, 255, 255], [58, 91, 70], [61, 59, 94],
            [156, 72, 75], [208, 190, 71], [177, 106, 73]
        ],
        output: [
            [0, 0, 0], [255, 255, 255], [0, 255, 0], [0, 0, 255],
            [255, 0, 0], [255, 255, 0], [255, 140, 0]
        ]
    },
    'impression-13.3-2025': {
        saturated: [
            [0, 0, 0], [161, 164, 165], [208, 190, 71],
            [156, 72, 75], [61, 59, 94], [58, 91, 70]
        ],
        output: [
            [0, 0, 0], [255, 255, 255], [255, 255, 0],
            [255, 0, 0], [0, 0, 255], [0, 255, 0]
        ]
    }
};

function getDisplayPalette(model) {
    const profile = DISPLAY_PALETTES[model];
    if (!profile) throw new Error(`Unsupported display model: ${model}`);
    return profile;
}

/**
 * Generate a blended palette based on saturation level.
 *
 * Uses the Inky library's palette blending formula.
 * Formula: color = (saturated * sat) + (desaturated * (1 - sat))
 *
 * @param {number} saturation - Saturation level (0.0 to 1.0)
 * @param {string} model - Display model from /api/display-config.
 * @returns {Array<Array<number>>} Array of [r, g, b] color values
 */
function generatePalette(saturation, model = 'impression-13.3-2025') {
    saturation = parseFloat(saturation);
    const profile = getDisplayPalette(model);
    const palette = [];

    for (let i = 0; i < profile.output.length; i++) {
        const rs = profile.saturated[i][0] * saturation;
        const gs = profile.saturated[i][1] * saturation;
        const bs = profile.saturated[i][2] * saturation;

        const rd = profile.output[i][0] * (1.0 - saturation);
        const gd = profile.output[i][1] * (1.0 - saturation);
        const bd = profile.output[i][2] * (1.0 - saturation);

        palette.push([
            Math.round(rs + rd),
            Math.round(gs + gd),
            Math.round(bs + bd)
        ]);
    }

    return palette;
}

/**
 * Apply brightness and contrast adjustments to image data.
 *
 * Brightness shifts all pixel values up or down.
 * Contrast increases or decreases the difference from middle gray (128).
 *
 * Formula:
 *   adjusted = (pixel - 128) * contrastFactor + 128 + brightness
 *
 * @param {ImageData} imageData - Input image data (will be modified in place).
 * @param {number} brightness - Brightness adjustment (-100 to +100).
 * @param {number} contrast - Contrast adjustment (-100 to +100).
 * @returns {ImageData} The modified image data (same object).
 */
function applyBrightnessContrast(imageData, brightness = 0, contrast = 0) {
    // Skip if no adjustment needed.
    if (brightness === 0 && contrast === 0) {
        return imageData;
    }

    const data = imageData.data;

    // Convert contrast from -100..+100 to a multiplier.
    // At contrast = 0, factor = 1 (no change).
    // At contrast = 100, factor ≈ 2 (double contrast).
    // At contrast = -100, factor ≈ 0 (flat gray).
    const contrastFactor = (100 + contrast) / 100;

    for (let i = 0; i < data.length; i += 4) {
        // Apply to RGB channels, skip alpha.
        for (let c = 0; c < 3; c++) {
            let value = data[i + c];

            // Apply contrast (deviation from middle gray).
            value = (value - 128) * contrastFactor + 128;

            // Apply brightness.
            value += brightness;

            // Clamp to valid range.
            data[i + c] = Math.max(0, Math.min(255, Math.round(value)));
        }
    }

    return imageData;
}

/**
 * Find the closest color in the palette.
 *
 * Uses either weighted RGB distance (when USE_WEIGHTED_RGB is true) or
 * standard Euclidean RGB distance. Weighted RGB accounts for human
 * perception being more sensitive to green than red or blue.
 *
 * @param {number} r - Red component (0-255)
 * @param {number} g - Green component (0-255)
 * @param {number} b - Blue component (0-255)
 * @param {Array<Array<number>>} palette - Array of [r, g, b] colors
 * @returns {number} Index of closest color in palette
 */
function findClosestPaletteColor(r, g, b, palette) {
    let minDistance = Infinity;
    let closestIndex = 0;

    for (let i = 0; i < palette.length; i++) {
        const pr = palette[i][0];
        const pg = palette[i][1];
        const pb = palette[i][2];

        const dr = r - pr;
        const dg = g - pg;
        const db = b - pb;

        let distance;
        if (USE_WEIGHTED_RGB) {
            // Weighted RGB distance: human eye is more sensitive to green.
            // Weights approximate luminance contribution: R=0.299, G=0.587, B=0.114.
            // Simplified to integer weights: 2*R² + 4*G² + 3*B².
            distance = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        } else {
            // Standard Euclidean distance in RGB color space.
            distance = dr * dr + dg * dg + db * db;
        }

        if (distance < minDistance) {
            minDistance = distance;
            closestIndex = i;
        }
    }

    return closestIndex;
}

/**
 * Apply Floyd-Steinberg dithering to an image.
 *
 * This algorithm distributes quantization error to neighboring pixels:
 *        X    7/16
 *   3/16 5/16 1/16
 *
 * Where X is the current pixel being processed.
 *
 * @param {ImageData} imageData - Input image (RGBA format).
 * @param {Array<Array<number>>} palette - Colors used for matching and error diffusion.
 * @param {Array<Array<number>>} outputPalette - Ink colors written to the result.
 * @returns {ImageData} Dithered image
 */
function floydSteinbergDither(imageData, palette, outputPalette = palette) {
    const width = imageData.width;
    const height = imageData.height;
    const data = new Uint8ClampedArray(imageData.data);

    // Process each pixel.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;

            // Get current pixel color.
            const oldR = data[idx];
            const oldG = data[idx + 1];
            const oldB = data[idx + 2];

            // Find closest palette color.
            const paletteIndex = findClosestPaletteColor(oldR, oldG, oldB, palette);
            const newR = palette[paletteIndex][0];
            const newG = palette[paletteIndex][1];
            const newB = palette[paletteIndex][2];

            // Set pixel to palette color.
            data[idx] = outputPalette[paletteIndex][0];
            data[idx + 1] = outputPalette[paletteIndex][1];
            data[idx + 2] = outputPalette[paletteIndex][2];
            // Alpha stays the same.

            // Calculate quantization error.
            const errR = oldR - newR;
            const errG = oldG - newG;
            const errB = oldB - newB;

            // Distribute error to neighboring pixels (Floyd-Steinberg pattern).

            // Right pixel (x+1, y): 7/16 of error.
            if (x + 1 < width) {
                const rightIdx = (y * width + (x + 1)) * 4;
                data[rightIdx] = data[rightIdx] + errR * 7 / 16;
                data[rightIdx + 1] = data[rightIdx + 1] + errG * 7 / 16;
                data[rightIdx + 2] = data[rightIdx + 2] + errB * 7 / 16;
            }

            // Bottom-left pixel (x-1, y+1): 3/16 of error.
            if (x - 1 >= 0 && y + 1 < height) {
                const blIdx = ((y + 1) * width + (x - 1)) * 4;
                data[blIdx] = data[blIdx] + errR * 3 / 16;
                data[blIdx + 1] = data[blIdx + 1] + errG * 3 / 16;
                data[blIdx + 2] = data[blIdx + 2] + errB * 3 / 16;
            }

            // Bottom pixel (x, y+1): 5/16 of error.
            if (y + 1 < height) {
                const bottomIdx = ((y + 1) * width + x) * 4;
                data[bottomIdx] = data[bottomIdx] + errR * 5 / 16;
                data[bottomIdx + 1] = data[bottomIdx + 1] + errG * 5 / 16;
                data[bottomIdx + 2] = data[bottomIdx + 2] + errB * 5 / 16;
            }

            // Bottom-right pixel (x+1, y+1): 1/16 of error.
            if (x + 1 < width && y + 1 < height) {
                const brIdx = ((y + 1) * width + (x + 1)) * 4;
                data[brIdx] = data[brIdx] + errR * 1 / 16;
                data[brIdx + 1] = data[brIdx + 1] + errG * 1 / 16;
                data[brIdx + 2] = data[brIdx + 2] + errB * 1 / 16;
            }
        }
    }

    // Return new ImageData with dithered result.
    return new ImageData(data, width, height);
}

/**
 * Apply Atkinson dithering to an image.
 *
 * Atkinson dithering (used on early Macintosh) only diffuses 6/8 (75%) of the
 * quantization error, which helps preserve contrast and detail in images.
 * Good for high-contrast images and text on e-ink displays.
 *
 * Error distribution pattern:
 *        X    1/8  1/8
 *   1/8  1/8  1/8
 *        1/8
 *
 * @param {ImageData} imageData - Input image (RGBA format).
 * @param {Array<Array<number>>} palette - Colors used for matching and error diffusion.
 * @param {Array<Array<number>>} outputPalette - Ink colors written to the result.
 * @returns {ImageData} Dithered image
 */
function atkinsonDither(imageData, palette, outputPalette = palette) {
    const width = imageData.width;
    const height = imageData.height;
    const data = new Uint8ClampedArray(imageData.data);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;

            const oldR = data[idx];
            const oldG = data[idx + 1];
            const oldB = data[idx + 2];

            const paletteIndex = findClosestPaletteColor(oldR, oldG, oldB, palette);
            const newR = palette[paletteIndex][0];
            const newG = palette[paletteIndex][1];
            const newB = palette[paletteIndex][2];

            data[idx] = outputPalette[paletteIndex][0];
            data[idx + 1] = outputPalette[paletteIndex][1];
            data[idx + 2] = outputPalette[paletteIndex][2];

            // Calculate error (only 6/8 = 75% is distributed).
            const errR = (oldR - newR) / 8;
            const errG = (oldG - newG) / 8;
            const errB = (oldB - newB) / 8;

            // Distribute error to 6 neighboring pixels (1/8 each).
            const offsets = [
                [1, 0], [2, 0],      // Right and far right.
                [-1, 1], [0, 1], [1, 1],  // Bottom row.
                [0, 2]               // Two rows down.
            ];

            for (const [dx, dy] of offsets) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < width && ny < height) {
                    const nIdx = (ny * width + nx) * 4;
                    data[nIdx] = data[nIdx] + errR;
                    data[nIdx + 1] = data[nIdx + 1] + errG;
                    data[nIdx + 2] = data[nIdx + 2] + errB;
                }
            }
        }
    }

    return new ImageData(data, width, height);
}

// 4x4 Bayer threshold matrix for ordered dithering.
// Values are normalized to 0-15, will be scaled to palette threshold.
const BAYER_4X4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
];

/**
 * Apply ordered (Bayer) dithering to an image.
 *
 * Ordered dithering uses a threshold matrix to determine color selection.
 * It produces a distinctive cross-hatch pattern and is very fast.
 * Unlike error diffusion, it doesn't spread errors to neighboring pixels.
 *
 * @param {ImageData} imageData - Input image (RGBA format).
 * @param {Array<Array<number>>} palette - Colors used for matching and error diffusion.
 * @param {Array<Array<number>>} outputPalette - Ink colors written to the result.
 * @returns {ImageData} Dithered image
 */
function orderedDither(imageData, palette, outputPalette = palette) {
    const width = imageData.width;
    const height = imageData.height;
    const data = new Uint8ClampedArray(imageData.data);

    // Threshold spread determines how much the Bayer matrix affects color choice.
    // Higher values = more visible dithering pattern.
    const thresholdSpread = 48;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;

            // Get threshold from Bayer matrix (tiled across image).
            const bayerValue = BAYER_4X4[y % 4][x % 4];
            // Normalize to range [-0.5, 0.5] then scale.
            const threshold = (bayerValue / 16 - 0.5) * thresholdSpread;

            // Apply threshold to pixel colors.
            const r = Math.max(0, Math.min(255, data[idx] + threshold));
            const g = Math.max(0, Math.min(255, data[idx + 1] + threshold));
            const b = Math.max(0, Math.min(255, data[idx + 2] + threshold));

            // Find closest palette color for adjusted pixel.
            const paletteIndex = findClosestPaletteColor(r, g, b, palette);

            data[idx] = outputPalette[paletteIndex][0];
            data[idx + 1] = outputPalette[paletteIndex][1];
            data[idx + 2] = outputPalette[paletteIndex][2];
        }
    }

    return new ImageData(data, width, height);
}

// Available dithering algorithms.
const DITHER_ALGORITHMS = {
    'floyd-steinberg': floydSteinbergDither,
    'atkinson': atkinsonDither,
    'ordered': orderedDither
};

/**
 * High-level function to dither an image for e-ink display.
 *
 * @param {ImageData} imageData - Input image (dimensions should match target display).
 * @param {number} saturation - Saturation level (0.0 to 1.0, default 0.5).
 * @param {string} algorithm - Dithering algorithm: 'floyd-steinberg', 'atkinson', or 'ordered'.
 * @param {string} model - Display model from /api/display-config.
 * @returns {ImageData} Dithered image ready for e-ink display.
 */
function ditherForEInk(imageData, saturation = 0.5, algorithm = 'floyd-steinberg', model = 'impression-13.3-2025') {
    const palette = generatePalette(saturation, model);
    const ditherFn = DITHER_ALGORITHMS[algorithm] || floydSteinbergDither;

    // The panel has no alpha channel. Composite on white before choosing inks,
    // so exporting the canvas cannot alter RGB codes through alpha rounding.
    const data = new Uint8ClampedArray(imageData.data);
    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3] / 255;
        for (let channel = 0; channel < 3; channel++) {
            data[i + channel] = Math.round(data[i + channel] * alpha + 255 * (1 - alpha));
        }
        data[i + 3] = 255;
    }
    const opaque = new ImageData(data, imageData.width, imageData.height);
    return ditherFn(opaque, palette, getDisplayPalette(model).output);
}

// Export functions for use in other scripts and Web Workers.
if (typeof module !== 'undefined' && module.exports) {
    // Node.js/CommonJS.
    module.exports = {
        BAYER_4X4,
        DITHER_ALGORITHMS,
        USE_WEIGHTED_RGB,
        applyBrightnessContrast,
        atkinsonDither,
        ditherForEInk,
        findClosestPaletteColor,
        floydSteinbergDither,
        generatePalette,
        orderedDither,
    };
}
