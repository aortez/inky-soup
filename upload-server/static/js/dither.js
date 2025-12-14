/**
 * E-Ink Dithering Library
 *
 * Implements the exact dithering algorithm from the Pimoroni Inky library
 * for 7-color e-ink displays (Inky Impression).
 *
 * Based on: https://github.com/pimoroni/inky/blob/main/inky/inky_uc8159.py
 */

// 7-color palette constants from Inky library.
// Colors: BLACK, WHITE, GREEN, BLUE, RED, YELLOW, ORANGE, CLEAN.
const SATURATED_PALETTE = [
    [57, 48, 57],      // BLACK
    [255, 255, 255],   // WHITE
    [58, 91, 70],      // GREEN
    [61, 59, 94],      // BLUE
    [156, 72, 75],     // RED
    [208, 190, 71],    // YELLOW
    [177, 106, 73],    // ORANGE
    [255, 255, 255]    // CLEAN
];

const DESATURATED_PALETTE = [
    [0, 0, 0],         // BLACK
    [255, 255, 255],   // WHITE
    [0, 255, 0],       // GREEN
    [0, 0, 255],       // BLUE
    [255, 0, 0],       // RED
    [255, 255, 0],     // YELLOW
    [255, 140, 0],     // ORANGE
    [255, 255, 255]    // CLEAN
];

/**
 * Generate a blended palette based on saturation level.
 *
 * Exactly replicates the Inky library's _palette_blend() method.
 * Formula: color = (saturated * sat) + (desaturated * (1 - sat))
 *
 * @param {number} saturation - Saturation level (0.0 to 1.0)
 * @returns {Array<Array<number>>} Array of [r, g, b] color values
 */
function generatePalette(saturation) {
    saturation = parseFloat(saturation);
    const palette = [];

    // Blend first 7 colors.
    for (let i = 0; i < 7; i++) {
        const rs = SATURATED_PALETTE[i][0] * saturation;
        const gs = SATURATED_PALETTE[i][1] * saturation;
        const bs = SATURATED_PALETTE[i][2] * saturation;

        const rd = DESATURATED_PALETTE[i][0] * (1.0 - saturation);
        const gd = DESATURATED_PALETTE[i][1] * (1.0 - saturation);
        const bd = DESATURATED_PALETTE[i][2] * (1.0 - saturation);

        palette.push([
            Math.round(rs + rd),
            Math.round(gs + gd),
            Math.round(bs + bd)
        ]);
    }

    // Add CLEAN color (always white).
    palette.push([255, 255, 255]);

    return palette;
}

/**
 * Find the closest color in the palette using Euclidean distance.
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

        // Euclidean distance in RGB color space.
        const distance = Math.sqrt(
            (r - pr) * (r - pr) +
            (g - pg) * (g - pg) +
            (b - pb) * (b - pb)
        );

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
 * @param {ImageData} imageData - Input image (600x448 RGBA)
 * @param {Array<Array<number>>} palette - 8-color palette
 * @returns {ImageData} Dithered image
 */
function floydSteinbergDither(imageData, palette) {
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
            data[idx] = newR;
            data[idx + 1] = newG;
            data[idx + 2] = newB;
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
 * High-level function to dither an image for e-ink display.
 *
 * @param {ImageData} imageData - Input image (should be 600x448)
 * @param {number} saturation - Saturation level (0.0 to 1.0, default 0.5)
 * @returns {ImageData} Dithered image ready for e-ink display
 */
function ditherForEInk(imageData, saturation = 0.5) {
    if (imageData.width !== 600 || imageData.height !== 448) {
        console.warn('Image dimensions should be 600x448 for Inky Impression display');
    }

    const palette = generatePalette(saturation);
    return floydSteinbergDither(imageData, palette);
}

// Export functions for use in other scripts and Web Workers.
if (typeof module !== 'undefined' && module.exports) {
    // Node.js/CommonJS.
    module.exports = {
        generatePalette,
        findClosestPaletteColor,
        floydSteinbergDither,
        ditherForEInk
    };
}
