import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { officeEntries, parseDelimited } from '../views/preview/assetContent';
describe('inline asset readers', () => {
  it('preserves quoted delimiters, embedded newlines and escaped quotes', () => {
    expect(parseDelimited('Name,Note\r\n"A, B","first\nsecond"\r\nC,"said ""yes"""')).toEqual([
      ['Name', 'Note'], ['A, B', 'first\nsecond'], ['C', 'said "yes"'],
    ]);
    expect(parseDelimited('A\tB\n1\t2', '\t')).toEqual([['A','B'],['1','2']]);
  });
  it('keeps only readable Office content and excludes executable archive entries', () => {
    const bytes = zipSync({ 'word/document.xml': strToU8('<document/>'), 'word/vbaProject.bin': new Uint8Array([1,2]), '../../script.js': strToU8('not loaded') });
    expect(officeEntries(bytes)).toEqual({ 'word/document.xml': '<document/>' });
  });
  it('rejects oversized expanded XML before extracting it', () => {
    const bytes = zipSync({ 'word/document.xml': strToU8('x'.repeat(4_000_001)) });
    expect(() => officeEntries(bytes)).toThrow('size limit');
  });
});
