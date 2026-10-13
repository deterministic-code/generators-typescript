import { describe, it, expect } from 'vitest';
import { assertValidIdentifier, quoteIdentifier } from './sqlIdentifier';

describe('assertValidIdentifier', () => {
  it('accepts lowercase snake_case', () => {
    expect(assertValidIdentifier('contact')).toBe('contact');
    expect(assertValidIdentifier('contact_group')).toBe('contact_group');
    expect(assertValidIdentifier('_internal_v2')).toBe('_internal_v2');
  });

  it('accepts mixed-case legacy identifiers (PascalCase / camelCase)', () => {
    expect(assertValidIdentifier('OldContactsTbl')).toBe('OldContactsTbl');
    expect(assertValidIdentifier('UserAccount')).toBe('UserAccount');
    expect(assertValidIdentifier('legacyTbl')).toBe('legacyTbl');
  });

  it('rejects identifiers with spaces, quotes, semicolons, or other unsafe characters', () => {
    for (const bad of [
      'bad column',
      'bad"col',
      "bad'col",
      'col;DROP',
      'col-name',
      'col.name',
      '1starts_with_digit',
      '',
    ]) {
      expect(() => assertValidIdentifier(bad)).toThrow(/Invalid SQL identifier/);
    }
  });
});

describe('quoteIdentifier', () => {
  it('wraps the validated name in double quotes', () => {
    expect(quoteIdentifier('OldContactsTbl')).toBe('"OldContactsTbl"');
  });
});
