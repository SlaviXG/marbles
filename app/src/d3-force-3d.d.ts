// d3-force-3d ships no type declarations; we use a single named import.
declare module "d3-force-3d" {
  export function forceCollide(radius?: number | ((node: any) => number)): any;
}
