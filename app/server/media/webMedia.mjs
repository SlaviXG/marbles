// Keyless web lookups for things the user asks to see. Both functions return
// plain data for the app to display; nothing is downloaded or stored here.
const AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const clean = (value, max = 160) => String(value ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const validQuery = query => {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Supply a search under 200 characters.');
  return query.trim();
};

async function commons(query, limit, fetchImpl) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.search = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6',
    gsrlimit: String(limit * 2), prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1280', origin: '*' }).toString();
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'MarblesDesktop/0.1 (local assistant)' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Image search failed (${response.status}).`);
  const pages = Object.values((await response.json()).query?.pages ?? {});
  return pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(page => {
    const info = page.imageinfo?.[0];
    if (!info?.url || !/^image\/(jpeg|png|webp|gif)$/.test(info.mime ?? '') || (info.width ?? 0) < 400) return null;
    return { url: info.thumburl ?? info.url, full: info.url, width: info.thumbwidth ?? info.width, height: info.thumbheight ?? info.height,
      title: clean(info.extmetadata?.ObjectName?.value || page.title?.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')),
      credit: clean(info.extmetadata?.Artist?.value, 80), source: info.descriptionurl };
  }).filter(Boolean);
}

async function openverse(query, limit, fetchImpl) {
  const url = `https://api.openverse.org/v1/images/?page_size=${limit}&q=${encodeURIComponent(query)}`;
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'MarblesDesktop/0.1 (local assistant)' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Image search failed (${response.status}).`);
  return ((await response.json()).results ?? []).filter(item => item.url).map(item => ({ url: item.url, full: item.url, width: item.width, height: item.height,
    title: clean(item.title), credit: clean(item.creator, 80), source: item.foreign_landing_url }));
}

/** Openly licensed pictures for a spoken query. */
export async function searchImages(query, { fetchImpl = fetch, limit = 12 } = {}) {
  query = validQuery(query);
  let images = [];
  try { images = await commons(query, limit, fetchImpl); } catch { /* fall through to the second source */ }
  if (images.length < 4) {
    try { const more = await openverse(query, limit, fetchImpl); images = [...images, ...more.filter(item => !images.some(have => have.full === item.full))]; }
    catch (error) { if (!images.length) throw error; }
  }
  if (!images.length) throw new Error(`No pictures found for “${query}”.`);
  return images.slice(0, limit);
}

export function youtubeId(value) {
  try {
    const url = new URL(value);
    if (url.hostname.endsWith('youtu.be')) return /^[\w-]{11}$/.test(url.pathname.slice(1)) ? url.pathname.slice(1) : null;
    if (url.hostname.endsWith('youtube.com')) {
      const id = url.searchParams.get('v') ?? url.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
  } catch { /* not a URL */ }
  return null;
}

// Walk the results page data for video entries, in ranking order.
function collectVideos(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40 || out.length >= 8) return;
  if (node.videoRenderer?.videoId) {
    const video = node.videoRenderer;
    out.push({ videoId: video.videoId, title: clean(video.title?.runs?.map(run => run.text).join('') ?? video.title?.simpleText),
      channel: clean(video.ownerText?.runs?.[0]?.text ?? video.longBylineText?.runs?.[0]?.text, 80), duration: clean(video.lengthText?.simpleText, 12) });
    return;
  }
  for (const value of Array.isArray(node) ? node : Object.values(node)) collectVideos(value, out, depth + 1);
}

/** The best matching YouTube videos for a spoken query, or the video a link points at. */
export async function searchYouTube(query, { fetchImpl = fetch } = {}) {
  query = validQuery(query);
  const direct = youtubeId(query);
  if (direct) return [{ videoId: direct, title: '', channel: '', duration: '' }];
  const response = await fetchImpl(`https://www.youtube.com/results?hl=en&search_query=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': AGENT, 'Accept-Language': 'en', Cookie: 'CONSENT=YES+1; SOCS=CAI' }, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`Video search failed (${response.status}).`);
  const html = await response.text();
  const videos = [];
  const data = html.match(/var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s)?.[1];
  if (data) { try { collectVideos(JSON.parse(data), videos); } catch { /* use the plain scan below */ } }
  if (!videos.length) for (const match of html.matchAll(/"videoId":"([\w-]{11})"/g)) {
    if (!videos.some(video => video.videoId === match[1])) videos.push({ videoId: match[1], title: '', channel: '', duration: '' });
    if (videos.length >= 8) break;
  }
  if (!videos.length) throw new Error(`No video found for “${query}”.`);
  return videos;
}
