import type { ReactNode } from 'react';
import Tex from './Tex';

// A small, safe Markdown reader for agent deliverables. It builds React
// elements only (never HTML strings), and covers what reports actually use:
// headings, lists, quotes, code, rules, simple tables, inline emphasis,
// pictures (web or beside the file) and LaTeX maths ($…$, $$…$$, \\(…\\), \\[…\\]).
// Where a picture lives: the web, or next to the document in the workspace.
function imageSource(target: string, base: string) {
  if (/^(https?:)?\/\//i.test(target) || target.startsWith('data:image/')) return target;
  const parts = [...base.split('/').filter(Boolean), ...target.split('/')].reduce<string[]>((out, part) => {
    if (part === '..') out.pop(); else if (part && part !== '.') out.push(part);
    return out;
  }, []);
  return `/api/artifacts/file?path=${encodeURIComponent(parts.join('/'))}`;
}
function Picture({ alt, target, base }: { alt: string; target: string; base: string }) {
  // Spans, not <figure>: a picture can sit inside a paragraph or a list item.
  return <span className="md-figure"><img src={imageSource(target, base)} alt={alt} loading="lazy" referrerPolicy="no-referrer" draggable={false} />{alt && <span className="md-caption">{alt}</span>}</span>;
}

function inline(text: string, base = ''): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`|\$\$[^$]+\$\$|\\\([^]+?\\\)|\$(?=\S)[^$\n]*?\S\$(?![\d$])|!\[[^\]]*\]\([^)\s]+\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0; let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0]; const key = out.length;
    if (token.startsWith('**') || token.startsWith('__')) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('$$')) out.push(<Tex key={key} tex={token.slice(2, -2)} display />);
    else if (token.startsWith('$')) out.push(<Tex key={key} tex={token.slice(1, -1)} />);
    else if (token.startsWith('\\(')) out.push(<Tex key={key} tex={token.slice(2, -2)} />);
    else if (token.startsWith('![')) out.push(<Picture key={key} alt={token.slice(2, token.indexOf(']'))} target={token.slice(token.indexOf('](') + 2, -1)} base={base} />);
    else if (token.startsWith('[')) out.push(<span className="md-link" key={key}>{token.slice(1, token.indexOf(']'))}</span>);
    else out.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

export default function Markdown({ text, path = '' }: { text: string; path?: string }) {
  const base = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const lines = text.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  const push = (node: (key: number) => ReactNode) => blocks.push(node(blocks.length));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // Display maths: $$ … $$ or \[ … \], on one line or spread over several.
    const math = line.trim().match(/^(\$\$|\\\[)/);
    if (math) {
      const closer = math[1] === '$$' ? '$$' : '\\]';
      let body = line.trim().slice(math[1].length); i++;
      while (!body.includes(closer) && i < lines.length) body += '\n' + lines[i++];
      const tex = body.split(closer)[0].trim();
      if (tex) push(key => <Tex tex={tex} display key={key} />);
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      push(key => <pre className="md-code" key={key}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (heading) {
      const level = Math.min(4, heading[1].length);
      const Tag = (`h${level + 1}`) as 'h2' | 'h3' | 'h4' | 'h5';
      push(key => <Tag className={`md-h md-h${level}`} key={key}>{inline(heading[2], base)}</Tag>);
      i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { push(key => <hr className="md-rule" key={key} />); i++; continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      push(key => <div className="asset-table-wrap" key={key}><table><thead><tr>{head.map((cell, c) => <th key={c} scope="col">{inline(cell, base)}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell, base)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      push(key => <blockquote className="md-quote" key={key}>{inline(body.join(' '), base)}</blockquote>);
      continue;
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { text: string; depth: number; done?: boolean }[] = [];
      while (i < lines.length && (bullet.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (bullet.test(lines[i])) {
          let body = lines[i].replace(bullet, '');
          const task = body.match(/^\[([ xX])\]\s+/);
          if (task) body = body.slice(task[0].length);
          items.push({ text: body, depth: Math.min(3, Math.floor((lines[i].match(/^\s*/)?.[0].length ?? 0) / 2)), done: task ? task[1] !== ' ' : undefined });
        } else items[items.length - 1].text += ' ' + lines[i].trim();
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      push(key => <List className="md-list" key={key}>{items.map((item, n) => <li key={n} className={item.done === undefined ? undefined : item.done ? 'md-task done' : 'md-task'} style={item.depth ? { marginInlineStart: item.depth * 22 } : undefined}>{inline(item.text, base)}</li>)}</List>);
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s+|\s*(\$\$|\\\[))/.test(lines[i])) body.push(lines[i++].trim());
    push(key => <p className="md-p" key={key}>{inline(body.join(' '), base)}</p>);
  }
  return <article className="md">{blocks}</article>;
}
