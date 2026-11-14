// A small sheet of light that says what kind of file this is, without words.
export type FileKind = 'doc' | 'sheet' | 'slides' | 'image' | 'pdf' | 'media' | 'web';

export function fileKind(name: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (/^(xls|xlsx|ods|csv|tsv)$/.test(ext)) return 'sheet';
  if (/^(ppt|pptx|odp)$/.test(ext)) return 'slides';
  if (/^(png|jpe?g|webp|gif|svg|bmp|avif)$/.test(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (/^(mp3|wav|ogg|m4a|mp4|webm|mov)$/.test(ext)) return 'media';
  if (/^(html|htm)$/.test(ext)) return 'web';
  return 'doc';
}

export const fileExtension = (name: string) => (name.includes('.') ? name.split('.').pop()! : 'file').toUpperCase();
export const fileTitle = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');

export default function FileGlyph({ name, size = 40 }: { name: string; size?: number }) {
  const kind = fileKind(name);
  return <svg className={`file-glyph ${kind}`} width={size} height={size * 1.2} viewBox="0 0 40 48" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path className="file-glyph-sheet" d="M6 3h20l9 9v31a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    <path d="M26 3v9h9" opacity=".7" />
    {kind === 'sheet' ? <path d="M10 20h20M10 27h20M10 34h20M17 20v19M24 20v19" />
      : kind === 'slides' ? <><rect x="10" y="19" width="20" height="12" rx="1.5" /><path d="M14 38h12" /></>
      : kind === 'image' ? <><circle cx="25" cy="22" r="2.4" /><path d="m9 38 8-10 5 6 3-3 6 7" /></>
      : kind === 'pdf' ? <path d="M10 21h20M10 27h20M10 33h20M10 39h9" />
      : kind === 'media' ? <path d="m16 22 11 7-11 7Z" />
      : kind === 'web' ? <><circle cx="20" cy="29" r="9" /><path d="M11 29h18M20 20c-4 5-4 13 0 18M20 20c4 5 4 13 0 18" /></>
      : <path d="M10 21h16M10 27h20M10 33h20M10 39h11" />}
  </svg>;
}
