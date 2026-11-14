#!/usr/bin/env node
// Build a real PowerPoint deck or Excel workbook from a small JSON spec, so any
// agent can deliver slides or a spreadsheet without its own Office tooling.
//
//   node make-office.mjs deck  spec.json out.pptx
//   node make-office.mjs sheet spec.json out.xlsx
//
// Deck spec:  { "title": "...", "subtitle": "...", "slides": [
//                { "title": "...", "bullets": ["..."], "table": [["H1","H2"],["a","b"]], "image": "chart.png", "notes": "..." } ] }
// Sheet spec: { "sheets": [ { "name": "Budget", "columns": ["Month","Revenue"], "rows": [["July", 410000], ["Total", "=SUM(B2:B2)"]] } ] }
// A cell that starts with "=" is written as a live formula.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const fail = message => { console.error(message); process.exit(1); };
const [kind, specPath, outPath] = process.argv.slice(2);
if (!['deck', 'sheet'].includes(kind) || !specPath || !outPath) fail('Usage: node make-office.mjs deck|sheet <spec.json> <output file>');
let spec;
try { spec = JSON.parse(await readFile(specPath, 'utf8')); } catch (error) { fail(`Could not read the spec: ${error.message}`); }
const text = (value, max = 2000) => String(value ?? '').slice(0, max);

async function deck() {
  if (!Array.isArray(spec.slides) || !spec.slides.length) fail('A deck needs a non-empty "slides" array.');
  const { default: Pptx } = await import('pptxgenjs');
  const Deck = Pptx.default ?? Pptx;
  const pptx = new Deck();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.title = text(spec.title || spec.slides[0].title, 200);
  const ink = { bg: '0B1220', title: 'FFFFFF', body: 'D6E2EE', accent: '4FD8EB', muted: '8496AA', panel: '14203A' };
  const font = 'Helvetica Neue';
  if (spec.title) {
    const cover = pptx.addSlide();
    cover.background = { color: ink.bg };
    cover.addShape(pptx.ShapeType.rect, { x: 0.9, y: 3.0, w: 0.08, h: 1.5, fill: { color: ink.accent } });
    cover.addText(text(spec.title, 200), { x: 1.2, y: 2.6, w: 11, h: 1.5, fontFace: font, fontSize: 44, bold: true, color: ink.title, valign: 'middle' });
    if (spec.subtitle) cover.addText(text(spec.subtitle, 300), { x: 1.2, y: 4.1, w: 11, h: 0.8, fontFace: font, fontSize: 20, color: ink.muted, valign: 'top' });
  }
  for (const [index, item] of spec.slides.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: ink.bg };
    slide.addText(text(item.title || `Slide ${index + 1}`, 200), { x: 0.7, y: 0.45, w: 11.9, h: 1.0, fontFace: font, fontSize: 30, bold: true, color: ink.title, valign: 'middle' });
    slide.addShape(pptx.ShapeType.rect, { x: 0.7, y: 1.5, w: 1.2, h: 0.05, fill: { color: ink.accent } });
    const hasSide = item.image || Array.isArray(item.table);
    const bullets = Array.isArray(item.bullets) ? item.bullets.slice(0, 8) : [];
    if (bullets.length) slide.addText(bullets.map(point => ({ text: text(point, 400), options: { bullet: { code: '25C6' }, breakLine: true, paraSpaceAfter: 10 } })),
      { x: 0.7, y: 1.85, w: hasSide ? 5.6 : 11.9, h: 4.9, fontFace: font, fontSize: bullets.length > 5 ? 18 : 22, color: ink.body, valign: 'top' });
    if (Array.isArray(item.table) && item.table.length) {
      const rows = item.table.slice(0, 12).map((row, r) => row.slice(0, 8).map(cell => ({ text: text(cell, 200),
        options: { fontFace: font, fontSize: 14, bold: r === 0, color: r === 0 ? ink.accent : ink.body, fill: { color: r === 0 ? ink.panel : ink.bg } } })));
      slide.addTable(rows, { x: bullets.length ? 6.6 : 0.7, y: 1.95, w: bullets.length ? 6.0 : 11.9, border: { type: 'solid', color: '24344F', pt: 1 } });
    } else if (item.image) {
      slide.addImage({ path: path.resolve(path.dirname(specPath), item.image), x: bullets.length ? 6.6 : 1.7, y: 1.9, w: bullets.length ? 6.0 : 9.9, h: 4.8, sizing: { type: 'contain', w: bullets.length ? 6.0 : 9.9, h: 4.8 } });
    }
    if (item.notes) slide.addNotes(text(item.notes, 4000));
    slide.addText(String(index + 1 + (spec.title ? 1 : 0)).padStart(2, '0'), { x: 12.0, y: 6.9, w: 0.9, h: 0.4, fontFace: font, fontSize: 11, color: ink.muted, align: 'right' });
  }
  await pptx.writeFile({ fileName: outPath });
  console.log(`Wrote ${outPath} (${spec.slides.length + (spec.title ? 1 : 0)} slides)`);
}

async function sheet() {
  if (!Array.isArray(spec.sheets) || !spec.sheets.length) fail('A workbook needs a non-empty "sheets" array.');
  const { default: Excel } = await import('exceljs');
  const book = new Excel.Workbook();
  for (const [index, item] of spec.sheets.entries()) {
    const page = book.addWorksheet(text(item.name || `Sheet ${index + 1}`, 31).replace(/[\\/?*[\]:]/g, ' '), { views: [{ state: 'frozen', ySplit: item.columns ? 1 : 0 }] });
    const rows = [...(Array.isArray(item.columns) ? [item.columns] : []), ...(Array.isArray(item.rows) ? item.rows : [])];
    for (const row of rows) page.addRow(row.map(cell => typeof cell === 'string' && cell.startsWith('=') ? { formula: cell.slice(1) } : cell));
    if (item.columns) {
      const head = page.getRow(1);
      head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14203A' } };
    }
    page.columns.forEach((column, c) => {
      const longest = Math.max(8, ...rows.map(row => String(row[c] ?? '').length));
      column.width = Math.min(48, longest + 3);
    });
  }
  await book.xlsx.writeFile(outPath);
  console.log(`Wrote ${outPath} (${spec.sheets.length} sheet${spec.sheets.length === 1 ? '' : 's'})`);
}

await (kind === 'deck' ? deck() : sheet());
