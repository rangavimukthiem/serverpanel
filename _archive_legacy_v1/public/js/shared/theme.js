const THEME_KEY = 'ekafy-theme';
const VALID_THEMES = new Set([
  'system',
  'dark',
  'light',
  'pearl',
  'sepia',
  'night-comfort',
  'ocean',
  'violet',
  'forest',
  'sunset'
]);
const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: light)');

function resolveTheme(preference) {
  return preference === 'system'
    ? (colorSchemeQuery.matches ? 'light' : 'dark')
    : preference;
}

function readThemePreference() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return VALID_THEMES.has(stored) ? stored : 'system';
  } catch (_error) {
    return 'system';
  }
}

function applyTheme(preference) {
  const normalized = VALID_THEMES.has(preference) ? preference : 'system';
  document.documentElement.dataset.themePreference = normalized;
  document.documentElement.dataset.theme = resolveTheme(normalized);
}

export function initThemeSelector() {
  const selector = document.getElementById('themeSelector');
  const preference = readThemePreference();
  applyTheme(preference);

  if (selector) {
    selector.value = preference;
    selector.addEventListener('change', () => {
      const nextPreference = VALID_THEMES.has(selector.value) ? selector.value : 'system';
      try {
        localStorage.setItem(THEME_KEY, nextPreference);
      } catch (_error) {}
      applyTheme(nextPreference);
    });
  }

  colorSchemeQuery.addEventListener('change', () => {
    if (readThemePreference() === 'system') applyTheme('system');
  });
}
