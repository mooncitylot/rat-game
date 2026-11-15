/**
 * Resolve a public/ asset path against Vite's base URL, so the game works both at the site root (dev)
 * and under a subpath (GitHub Pages serves it from /<repo>/).
 * `asset('/models/x.gltf')` → '/rat-game/models/x.gltf' on Pages, '/models/x.gltf' locally.
 */
export function asset(path: string): string {
  const base = import.meta.env?.BASE_URL ?? '/'; // (undefined when run outside Vite, e.g. node scripts)
  return base.replace(/\/?$/, '/') + path.replace(/^\//, '');
}
