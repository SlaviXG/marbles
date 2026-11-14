export interface Section {
  id: string;
  heading: string | null;
  level: number;
  content: string;
  items: string[];
  links: string[];
  urls: string[];
}

export interface Note {
  id: string;
  title: string;
  path: string;
  mtime: number;
  sections: Section[];
}
