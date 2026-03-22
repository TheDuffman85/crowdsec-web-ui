export function getBasePath(): string {
  return window.__BASE_PATH__ || '';
}

export function withBasePath(path: string): string {
  const base = getBasePath();
  if (!base) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

export const apiUrl = withBasePath;
export const assetUrl = withBasePath;
