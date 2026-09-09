/**
 * The one place the stored theme is read and written.
 *
 * Four pages now share it, and a viewer who picks light on one and gets dark on
 * the next has been told the setting is per-page, which it is not meant to be.
 * Kept tiny and dependency-free so the hub can use it without pulling in the
 * app.
 */
const KEY = 'depthviz.theme';

export function storedTheme() {
  try { return localStorage.getItem(KEY) || 'dark'; } catch { return 'dark'; }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* private window: honour it for this page only */ }
  return theme;
}

export function applyStoredTheme() {
  const t = storedTheme();
  document.documentElement.dataset.theme = t;
  return t;
}
