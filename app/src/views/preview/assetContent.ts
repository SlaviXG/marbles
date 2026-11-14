import { unzipSync, strFromU8 } from 'fflate';

export type PreviewSection = { title: string; paragraphs?: string[]; rows?: string[][] };
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === delimiter && !quoted) { row.push(value); value = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += c;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

export function officeEntries(bytes: Uint8Array): Record<string, string> {
  if (bytes.byteLength > 24_000_000) throw new Error('This file is too large for the inline Office reader.');
  let total = 0;
  const files = unzipSync(bytes, { filter(file) {
    if (!/^(word\/document\.xml|xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml)|ppt\/slides\/slide\d+\.xml|content\.xml)$/.test(file.name)) return false;
    total += file.originalSize;
    if (file.originalSize > 4_000_000 || total > 12_000_000) throw new Error('This document exceeds the inline reader’s size limit.');
    return true;
  } });
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
}
const elements = (root: Document | Element, name: string) => Array.from(root.getElementsByTagNameNS('*', name));
const xml = (value: string) => {
  const doc = new DOMParser().parseFromString(value, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The document contains unreadable XML.');
  return doc;
};
const texts = (root: Document | Element, tag = 't') => elements(root, tag).map(node => node.textContent ?? '').join('');

export function readOffice(bytes: Uint8Array): PreviewSection[] {
  const files = officeEntries(bytes);
  if (files['word/document.xml']) {
    const paragraphs = elements(xml(files['word/document.xml']), 'p').map(p => texts(p)).filter(Boolean);
    return [{ title: 'Document', paragraphs }];
  }
  const sheets = Object.keys(files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
  if (sheets.length) {
    const shared = files['xl/sharedStrings.xml'] ? elements(xml(files['xl/sharedStrings.xml']), 'si').map(node => texts(node)) : [];
    const names = files['xl/workbook.xml'] ? elements(xml(files['xl/workbook.xml']), 'sheet').map(node => node.getAttribute('name') ?? '') : [];
    return sheets.map((name, index) => ({ title: names[index] || `Sheet ${index + 1}`, rows: elements(xml(files[name]), 'row').slice(0, 2000).map(row => {
      const cells: string[] = [];
      for (const cell of elements(row, 'c')) {
        const letters = cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0] ?? '';
        const column = letters ? Array.from(letters).reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0) - 1 : cells.length;
        if (column > 100) continue;
        while (cells.length <= column) cells.push('');
        // A formula without a cached result still shows what it computes.
        const formula = elements(cell, 'f')[0]?.textContent;
        const value = elements(cell, 'v')[0]?.textContent ?? (formula ? `=${formula}` : '');
        cells[column] = cell.getAttribute('t') === 's' ? shared[Number(value)] ?? value : cell.getAttribute('t') === 'inlineStr' ? texts(cell) : value;
      }
      return cells;
    }) }));
  }
  const slides = Object.keys(files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
  if (slides.length) return slides.map((name, index) => ({ title: `Slide ${index + 1}`, paragraphs: elements(xml(files[name]), 'p').map(p => texts(p)).filter(Boolean) }));
  if (files['content.xml']) {
    const doc = xml(files['content.xml']);
    const tables = elements(doc, 'table');
    if (tables.length) return tables.map((table, index) => ({ title: table.getAttribute('table:name') || `Table ${index + 1}`, rows: elements(table, 'table-row').slice(0, 2000).map(row => elements(row, 'table-cell').map(cell => elements(cell, 'p').map(p => p.textContent ?? '').join('\n'))) }));
    return [{ title: 'Document', paragraphs: elements(doc, 'p').map(p => p.textContent ?? '').filter(Boolean) }];
  }
  throw new Error('No readable document content was found.');
}
