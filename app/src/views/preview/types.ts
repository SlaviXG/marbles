import type { ReactNode } from "react";

// A LivePreview renders some action for a URL inside the PreviewFrame: today a
// video player; later, e.g., an autoscrolled-and-visualized website. Register an
// implementation in index.ts; first match wins (mirrors the resolver registry in
// core/detail.ts). No speculative base class until a second implementation
// actually exists.
export interface LivePreview {
  match(url: string): boolean;
  render(url: string): ReactNode;
}
