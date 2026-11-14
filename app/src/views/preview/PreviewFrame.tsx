import type { ReactNode } from "react";

// Frames a live preview (e.g. a video player) inside the immersive view. Visual
// lives in .preview-frame in styles.css.
export default function PreviewFrame({ children }: { children: ReactNode }) {
  return <div className="preview-frame">{children}</div>;
}
