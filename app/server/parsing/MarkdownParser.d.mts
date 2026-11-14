// Types for the pure RegexMarkdownParser so it can be imported from the browser
// (the PWA LocalFolderSource) as well as the Node server. The module itself is
// plain ESM string-processing with zero Node dependencies, which is exactly why
// it can be shared across both runtimes.
export class RegexMarkdownParser {
  parse(
    raw: string,
    id: string,
    title: string,
  ): {
    id: string;
    title: string;
    sections: {
      id: string;
      heading: string | null;
      level: number;
      content: string;
      items: string[];
      links: string[];
      urls: string[];
    }[];
  };
}
