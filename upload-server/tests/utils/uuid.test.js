/**
 * Tests for UUID generation utility.
 */
import { describe, it, expect } from 'vitest';
import { generateUUID } from '../../static/js/utils/uuid.js';

describe('generateUUID', () => {
  it('returns a string', () => {
    const uuid = generateUUID();
    expect(typeof uuid).toBe('string');
  });

  it('returns a properly formatted UUID v4', () => {
    const uuid = generateUUID();
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuid).toMatch(uuidRegex);
  });

  it('generates unique UUIDs', () => {
    const uuids = new Set();
    for (let i = 0; i < 1000; i += 1) {
      uuids.add(generateUUID());
    }
    expect(uuids.size).toBe(1000);
  });

  it('has correct version nibble (4)', () => {
    const uuid = generateUUID();
    // The 13th character (index 14 after removing dashes) should be '4'.
    expect(uuid[14]).toBe('4');
  });

  it('has correct variant bits (8, 9, a, or b)', () => {
    const uuid = generateUUID();
    // The 17th character (index 19 after removing dashes) should be 8, 9, a, or b.
    const variantChar = uuid[19].toLowerCase();
    expect(['8', '9', 'a', 'b']).toContain(variantChar);
  });

  it('has correct length (36 characters)', () => {
    const uuid = generateUUID();
    expect(uuid.length).toBe(36);
  });

  it('has dashes in correct positions', () => {
    const uuid = generateUUID();
    expect(uuid[8]).toBe('-');
    expect(uuid[13]).toBe('-');
    expect(uuid[18]).toBe('-');
    expect(uuid[23]).toBe('-');
  });
});
