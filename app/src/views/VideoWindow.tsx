import { useEffect, useRef, useState } from 'react';
import { useDisplay } from '../state/display';
import { useDragMove } from '../hooks/useDragMove';
import YouTubePlayer from './preview/YouTubePlayer';

// A video plays in a small window of its own, off to the side. It blocks
// nothing: the team, their files and the voice core all stay usable, and the
// window can be dragged anywhere or enlarged.
export default function VideoWindow() {
  const video = useDisplay(s => s.video);
  const large = useDisplay(s => s.videoLarge);
  const index = useDisplay(s => s.videoIndex);
  const failed = useDisplay(s => s.videoError);
  const [playing, setPlaying] = useState(false);
  useEffect(() => setPlaying(false), [video?.videoId, index]);
  const frame = useRef<HTMLElement>(null);
  const bar = useRef<HTMLElement>(null);
  useDragMove(frame, bar, video?.videoId ?? null);
  useEffect(() => {
    if (!video) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !useDisplay.getState().display) useDisplay.getState().closeVideo(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [video]);
  if (!video) return null;
  const { closeVideo, resizeVideo, skipVideo } = useDisplay.getState();
  // The first choice, or a runner-up if YouTube would not let it play here.
  const current = index === 0 ? video : { ...video, ...video.alternates![index - 1] };
  return <section className={`video-window${large ? ' large' : ''}`} ref={frame} data-closable="video" role="region" aria-label={`Video: ${current.title || video.query}`}>
    <header className="video-window-bar" ref={bar}>
      <span className="video-window-grip" aria-hidden="true"><i /><i /><i /></span>
      <p title={current.title}>{current.title || video.query}</p>
      <button aria-label={large ? 'Make video smaller' : 'Make video bigger'} aria-pressed={large} onClick={() => resizeVideo(!large)}>
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {large ? <path d="M8 3v5H3M12 17v-5h5" /> : <path d="M12 3h5v5M8 17H3v-5" />}
        </svg>
      </button>
      <button aria-label="Close video" onClick={closeVideo}><span aria-hidden="true">×</span></button>
    </header>
    <div className="preview-frame">
      {!failed && <YouTubePlayer key={current.videoId} id={current.videoId} autoplay onError={skipVideo} onPlaying={() => setPlaying(true)} />}
      {failed ? <p className="video-window-note" role="alert">{failed}</p>
        : !playing && index > 0 && <p className="video-window-note" role="status">Finding one that plays here…</p>}
    </div>
    <i className="holo-corner tl" aria-hidden="true" /><i className="holo-corner tr" aria-hidden="true" /><i className="holo-corner bl" aria-hidden="true" /><i className="holo-corner br" aria-hidden="true" />
  </section>;
}
