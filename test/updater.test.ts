import { describe, expect, it } from 'vitest';
import { compareVersions, normalizeVersion, parseVersionJson } from '../src/updater';

describe('normalizeVersion', () => {
  it('strips a leading v', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
  });
  it('handles missing values', () => {
    expect(normalizeVersion('')).toBeNull();
    expect(normalizeVersion(null)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders dotted versions numerically', () => {
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.1.0', '1.0.99')).toBe(1);
    expect(compareVersions('v1.1.0', '1.1.0')).toBe(0);
  });
});

describe('parseVersionJson', () => {
  it('parses raw version.json text', () => {
    expect(parseVersionJson('{"version": "1.2.3"}')).toBe('1.2.3');
  });
  it('parses pre-parsed objects', () => {
    expect(parseVersionJson({ version: '4.5.6' })).toBe('4.5.6');
  });
  it('falls back to regex on arbitrary text', () => {
    expect(parseVersionJson('release 2.0.1 stuff')).toBe('2.0.1');
  });
  it('returns null for garbage', () => {
    expect(parseVersionJson('no version here')).toBeNull();
  });
});
