import type { LivePreview } from "./types";
import { youTubePreview } from "./youtube";

// Registry of live previews. First match wins (mirrors core/detail resolvers).
const previews: LivePreview[] = [youTubePreview];

export function pickPreview(url: string): LivePreview | null {
  return previews.find((p) => p.match(url)) ?? null;
}

export type { LivePreview };
