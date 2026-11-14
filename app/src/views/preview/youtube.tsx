import type { LivePreview } from "./types";
import YouTubePlayer from "./YouTubePlayer";

// Pull the 11-char video id from the common YouTube URL shapes.
function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1) || null;
    if (u.hostname.endsWith("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/);
      if (m) return m[1];
    }
  } catch {
    // not a URL
  }
  return null;
}

export const youTubePreview: LivePreview = {
  match: (url) => youtubeId(url) !== null,
  render: (url) => {
    const id = youtubeId(url);
    if (!id) return null;
    // Deferred player: a click-to-load poster, then the IFrame Player API embed
    // driven by our own overlay controls. See YouTubePlayer for why (the virtual
    // cursor's synthetic events can't reach YouTube's in-iframe controls across
    // the cross-origin boundary, so we build same-origin overlay controls).
    return <YouTubePlayer key={id} id={id} />;
  },
};
