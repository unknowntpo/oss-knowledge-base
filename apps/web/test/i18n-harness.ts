/** Loads the browser i18n script in Bun with the minimal window and document it touches. */
export async function loadTranslations(): Promise<(locale: string) => (key: string, variables?: Readonly<Record<string, string | number>>) => string> {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.document ??= { documentElement: {}, querySelectorAll: () => [] };
  scope.window ??= {
    localStorage: { getItem: () => null, setItem: () => undefined },
    navigator: { language: "en" },
    dispatchEvent: () => true,
  };
  await import("../i18n.js");
  const i18n = (scope.window as { KB_I18N: { setLocale(locale: string): void; t(key: string, variables?: unknown): string } }).KB_I18N;
  return (locale) => (key, variables) => {
    i18n.setLocale(locale);
    return i18n.t(key, variables);
  };
}
