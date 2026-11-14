import { useCallback, useEffect, useRef, useState } from "react";

// A YouTube player that is operable BY THE VIRTUAL (camera) CURSOR as well as the
// real one. The hard constraint: the virtual cursor works by dispatching
// synthetic JS PointerEvents (see input/virtualPointer.ts). Those events CANNOT
// cross into a cross-origin iframe (a browser security boundary), so we can never
// drive YouTube's own in-iframe controls with them. So instead we:
//   1. Load the embed via the IFrame Player API (enablejsapi=1) and drive it
//      programmatically (playVideo/pauseVideo/seek) over postMessage.
//   2. Render our OWN same-origin overlay controls (real DOM buttons in our React
//      tree, above the iframe). Those are same-origin, so the synthetic pointer +
//      click events operate them. Controls are revealed via JS state
//      (onPointerEnter/Leave), NOT CSS :hover, because synthetic events do not
//      trigger CSS :hover.
//
// The iframe itself is deferred behind a click-to-load poster. That keeps the
// heavy work (network + a video compositing layer) OUT of the open transition
// (Problem 1), and gives a clean play affordance the virtual cursor can click.

// Minimal YT IFrame API surface we use. Avoids pulling @types/youtube.
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: YTPlayer }) => void;
        onStateChange?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

// Load https://www.youtube.com/iframe_api once, shared across player mounts.
let apiPromise: Promise<YTNamespace> | null = null;
function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT!);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return apiPromise;
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function YouTubePlayer({ id }: { id: string }) {
  // Deferred: the iframe/player only mounts once the poster is clicked.
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [controls, setControls] = useState(false); // revealed by JS, not CSS :hover
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const pollRef = useRef<number | null>(null);
  const startedRef = useRef(false); // guard: build the player exactly once

  const poster = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  // Build the player when the poster is clicked. Autoplay so the click that
  // dismissed the poster also starts playback (gives sound at full volume inside
  // the immersive view, matching the previous bare-embed behaviour).
  //
  // The YT API REPLACES the element it is given with its <iframe>. If that
  // element were React-managed, React would later reconcile against the now-
  // detached node and could re-insert it next to the iframe (two stacked
  // players). So we hand the API a plain div we append ourselves, inside a
  // container React only ever sees as empty. React never touches the inner node,
  // so it cannot duplicate it.
  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setLoaded(true);
    setControls(true);
    loadYouTubeApi().then((YT) => {
      const host = hostRef.current;
      if (!host) return;
      const inner = document.createElement("div");
      host.appendChild(inner);
      playerRef.current = new YT.Player(inner, {
        videoId: id,
        playerVars: {
          autoplay: 1,
          controls: 0, // our overlay drives it; the native bar can't be reached anyway
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          enablejsapi: 1,
        },
        events: {
          onReady: (e) => {
            setDuration(e.target.getDuration());
          },
          onStateChange: (e) => {
            setPlaying(e.data === YT.PlayerState.PLAYING);
            if (playerRef.current) setDuration(playerRef.current.getDuration() || 0);
          },
        },
      });
    });
  }, [id]);

  // Poll the current time while playing (the API has no time event). Stops when
  // paused/unmounted so no idle work runs behind a closed view.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const p = playerRef.current;
      if (p) {
        setCurrent(p.getCurrentTime());
        if (duration === 0) setDuration(p.getDuration());
      }
      pollRef.current = window.setTimeout(tick, 250);
    };
    tick();
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
      pollRef.current = null;
    };
  }, [playing, duration]);

  // Tear the player down on unmount (closing the view) so playback stops.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
      try {
        playerRef.current?.destroy();
      } catch {
        /* already gone */
      }
      playerRef.current = null;
    };
  }, []);

  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (playing) p.pauseVideo();
    else p.playVideo();
  }, [playing]);

  const seek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const p = playerRef.current;
    if (!p) return;
    const t = Number(e.target.value);
    setCurrent(t);
    p.seekTo(t, true);
  }, []);

  if (!loaded) {
    // Click-to-load poster. A real same-origin button, so the virtual cursor's
    // synthetic click starts the player (and dismisses the poster).
    return (
      <button
        type="button"
        className="yt-poster"
        style={{ backgroundImage: `url(${poster})` }}
        onClick={start}
        aria-label="Play video"
      >
        <span className="yt-play-badge" aria-hidden />
      </button>
    );
  }

  return (
    <div
      className="yt-player"
      // JS-driven reveal: synthetic pointer events DO fire these handlers, but do
      // NOT trigger CSS :hover, so the controls must be gated on state, not :hover.
      onPointerEnter={() => setControls(true)}
      onPointerLeave={() => setControls(false)}
    >
      {/* React-owned wrapper, always empty from React's view; the API's iframe
          lives in a plain node we append into it (see start), so re-renders can
          never duplicate the player. */}
      <div ref={hostRef} className="yt-mount" />
      <div className={`yt-controls${controls ? " show" : ""}`}>
        <button
          type="button"
          className="yt-btn"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="yt-time">{fmt(current)}</span>
        <input
          type="range"
          className="yt-seek"
          min={0}
          max={duration || 0}
          step={0.1}
          value={current}
          onChange={seek}
        />
        <span className="yt-time">{fmt(duration)}</span>
      </div>
    </div>
  );
}
