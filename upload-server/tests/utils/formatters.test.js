/**
 * Tests for display formatter utilities.
 */

import { describe, it, expect } from 'vitest';
import { formatSize, formatSpeed, formatTime } from '../../static/js/utils/formatters.js';

describe('formatters', () => {
  describe('formatSize', () => {
    it('should format bytes', () => {
      expect(formatSize(0)).toBe('0 B');
      expect(formatSize(500)).toBe('500 B');
      expect(formatSize(1023)).toBe('1023 B');
    });

    it('should format kilobytes', () => {
      expect(formatSize(1024)).toBe('1.0 KB');
      expect(formatSize(1536)).toBe('1.5 KB');
      expect(formatSize(10240)).toBe('10.0 KB');
      expect(formatSize(1024 * 1024 - 1)).toBe('1024.0 KB');
    });

    it('should format megabytes', () => {
      expect(formatSize(1024 * 1024)).toBe('1.00 MB');
      expect(formatSize(1024 * 1024 * 2.5)).toBe('2.50 MB');
      expect(formatSize(1024 * 1024 * 10)).toBe('10.00 MB');
    });
  });

  describe('formatSpeed', () => {
    it('should format bytes per second', () => {
      expect(formatSpeed(0)).toBe('0 B/s');
      expect(formatSpeed(500)).toBe('500 B/s');
      expect(formatSpeed(1023)).toBe('1023 B/s');
    });

    it('should format kilobytes per second', () => {
      expect(formatSpeed(1024)).toBe('1.0 KB/s');
      expect(formatSpeed(1536)).toBe('1.5 KB/s');
      expect(formatSpeed(10240)).toBe('10.0 KB/s');
    });

    it('should format megabytes per second', () => {
      expect(formatSpeed(1024 * 1024)).toBe('1.00 MB/s');
      expect(formatSpeed(1024 * 1024 * 5)).toBe('5.00 MB/s');
    });
  });

  describe('formatTime', () => {
    it('should format zero seconds', () => {
      expect(formatTime(0)).toBe('0:00');
    });

    it('should format seconds under a minute', () => {
      expect(formatTime(5)).toBe('0:05');
      expect(formatTime(30)).toBe('0:30');
      expect(formatTime(59)).toBe('0:59');
    });

    it('should format minutes and seconds', () => {
      expect(formatTime(60)).toBe('1:00');
      expect(formatTime(65)).toBe('1:05');
      expect(formatTime(90)).toBe('1:30');
      expect(formatTime(125)).toBe('2:05');
    });

    it('should format longer durations', () => {
      expect(formatTime(600)).toBe('10:00');
      expect(formatTime(754)).toBe('12:34');
    });

    it('should handle fractional seconds by flooring', () => {
      expect(formatTime(5.7)).toBe('0:05');
      expect(formatTime(65.9)).toBe('1:05');
    });
  });
});
