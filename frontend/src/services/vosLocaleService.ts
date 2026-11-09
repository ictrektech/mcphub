// VOS adaptation: follow the platform locale unless the user explicitly chooses a language.
import i18n from '../i18n';
import { isVosMode } from './vosAuthService';

export type VosLanguagePreference = 'auto' | 'en' | 'zh';
const PREFERENCE_KEY = 'mcphub.vos.language';
let platformLanguage: 'en' | 'zh' | null = null;
let memoryPreference: VosLanguagePreference = 'auto';

export function normalizeVosLanguage(value: unknown): 'en' | 'zh' | null {
  if (typeof value !== 'string') return null;
  const language = value.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  return language === 'zh' || language === 'en' ? language : null;
}

export function getVosLanguagePreference(): VosLanguagePreference {
  try {
    const saved = localStorage.getItem(PREFERENCE_KEY);
    return saved === 'en' || saved === 'zh' ? saved : 'auto';
  } catch {
    return memoryPreference;
  }
}

async function applyLanguage(): Promise<void> {
  const preference = getVosLanguagePreference();
  const language =
    preference === 'auto'
      ? (platformLanguage ?? normalizeVosLanguage(navigator.language) ?? 'en')
      : preference;
  await i18n.changeLanguage(language);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
}

export async function setVosLanguagePreference(preference: VosLanguagePreference): Promise<void> {
  memoryPreference = preference;
  try {
    if (preference === 'auto') localStorage.removeItem(PREFERENCE_KEY);
    else localStorage.setItem(PREFERENCE_KEY, preference);
  } catch {
    /* The current tab still works if browser storage is unavailable. */
  }
  await applyLanguage();
}

export async function initializeVosLocale(timeoutMs = 3000): Promise<() => void> {
  if (!isVosMode()) return () => {};
  const deadline = Date.now() + timeoutMs;
  while (!window.vos_platform?.getState && !window.vos_platform?.broadcast?.on) {
    if (window.parent === window || Date.now() >= deadline) {
      await applyLanguage();
      return () => {};
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  const bridge = window.vos_platform;
  let active = true;
  let revision = 0;
  const receive = async (locale: unknown) => {
    if (!active) return;
    // Unsupported platform languages fall back to English for this bilingual VOS UI.
    platformLanguage = normalizeVosLanguage(locale) ?? 'en';
    await applyLanguage();
  };
  const onChange = (data: { locale?: unknown }) => {
    revision++;
    void receive(data?.locale);
  };
  // Subscribe first: a late initial snapshot must never overwrite a newer event.
  let unsubscribe: void | (() => void) = undefined;
  try {
    unsubscribe = bridge.broadcast?.on('locale-change', onChange);
  } catch {
    /* Older clients may expose a partial broadcast bridge. */
  }
  const snapshotRevision = revision;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const state = await Promise.race([
      bridge.getState?.(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (revision === snapshotRevision) await receive(state?.locale ?? navigator.language);
  } catch {
    if (revision === snapshotRevision) await applyLanguage();
  } finally {
    clearTimeout(timeout);
  }
  return () => {
    active = false;
    if (typeof unsubscribe === 'function') unsubscribe();
    else bridge.broadcast?.off?.('locale-change', onChange);
  };
}
