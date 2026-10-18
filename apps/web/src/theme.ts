/**
 * Spec 024 DM2: the reader's theme choice. The inline script in index.html owns the logic (it must
 * run before first paint) and exposes `window.__osskbTheme`; this module is the app's typed handle.
 */
export type ThemeChoice = "light" | "dark" | "system";
export const THEME_CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"];

interface ThemeApi {
  choice(): ThemeChoice;
  choose(next: ThemeChoice): "light" | "dark";
}

declare global {
  interface Window {
    __osskbTheme?: ThemeApi;
  }
}

/** The current choice; `system` when the inline script did not run. */
export function currentThemeChoice(): ThemeChoice {
  return window.__osskbTheme?.choice() ?? "system";
}

/** Stores and applies a choice (for the session only when storage throws); a no-op without the inline script. */
export function chooseTheme(next: ThemeChoice): void {
  window.__osskbTheme?.choose(next);
}
