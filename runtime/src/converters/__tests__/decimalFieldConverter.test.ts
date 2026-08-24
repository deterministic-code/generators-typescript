import { describe, expect, it } from 'vitest';
import { makeDecimalFieldConverter } from '../decimalFieldConverter';
import { getDefaultConverters } from '../registry';

describe('decimalFieldConverter', () => {
  it('stringifies whatever the driver returns so the language value is an exact decimal string', () => {
    const conv = makeDecimalFieldConverter('sqlite');
    expect(conv.from(12.5)).toBe('12.5');
    expect(conv.from('12345.6789')).toBe('12345.6789');
    expect(conv.from(null)).toBeNull();
  });

  it('passes the string through on write', () => {
    const conv = makeDecimalFieldConverter('postgres');
    expect(conv.to('99.99')).toBe('99.99');
    expect(conv.to(null)).toBeNull();
  });

  it('is registered for every dialect', () => {
    for (const dialect of ['sqlite', 'mysql', 'postgres'] as const) {
      const map = getDefaultConverters(dialect, 'typescript');
      expect(map.get('decimal')?.datasourceType).toBe('decimal');
      expect(map.get('decimal')?.from('1.5')).toBe('1.5');
    }
  });
});
