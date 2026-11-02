import { describe, expect, it } from 'vitest';
import { normalizePageInput } from './Pagination.tsx';

describe('pagination page input', () => {
  it('accepts a page inside the available range', () => {
    expect(normalizePageInput(' 8 ', 20, 3)).toBe(8);
  });

  it('clamps pages to the available range', () => {
    expect(normalizePageInput('0', 20, 3)).toBe(1);
    expect(normalizePageInput('99', 20, 3)).toBe(20);
  });

  it('defaults empty input to page one and keeps the current page for invalid input', () => {
    expect(normalizePageInput('', 20, 3)).toBe(1);
    expect(normalizePageInput('1.5', 20, 3)).toBe(3);
    expect(normalizePageInput('abc', 20, 3)).toBe(3);
  });
});
