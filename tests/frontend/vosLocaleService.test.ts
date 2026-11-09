jest.mock('../../frontend/src/i18n', () => ({
  __esModule: true,
  default: { changeLanguage: jest.fn(async () => {}) },
}));
jest.mock('../../frontend/src/services/vosAuthService', () => ({ isVosMode: () => true }));

const originalWindow = global.window;
const originalStorage = global.localStorage;
const originalDocument = global.document;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
let store: Map<string, string>;
let bridge: { getState: jest.Mock; broadcast: { on: jest.Mock; off: jest.Mock } };
let receive: (data: { locale: unknown }) => void;
let unsubscribe: jest.Mock;
let changeLanguage: jest.Mock;

beforeEach(async () => {
  jest.resetModules();
  store = new Map([['i18nextLng', 'en']]);
  global.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  } as unknown as Storage;
  global.document = { documentElement: { lang: '' } } as unknown as Document;
  Object.defineProperty(global, 'navigator', { value: { language: 'en-US' }, configurable: true });
  unsubscribe = jest.fn();
  bridge = {
    getState: jest.fn(async () => ({ locale: 'zh-CN' })),
    broadcast: {
      on: jest.fn((_event, handler) => {
        receive = handler;
        return unsubscribe;
      }),
      off: jest.fn(),
    },
  };
  global.window = { parent: {}, setTimeout, vos_platform: bridge } as unknown as Window &
    typeof globalThis;
  changeLanguage = (await import('../../frontend/src/i18n')).default.changeLanguage as jest.Mock;
});
afterAll(() => {
  global.window = originalWindow;
  global.localStorage = originalStorage;
  global.document = originalDocument;
  if (navigatorDescriptor) Object.defineProperty(global, 'navigator', navigatorDescriptor);
  else Reflect.deleteProperty(global, 'navigator');
});

it('follows the initial VOS language instead of an old browser detector cache', async () => {
  const { initializeVosLocale } = await import('../../frontend/src/services/vosLocaleService');
  const stop = await initializeVosLocale();
  expect(changeLanguage).toHaveBeenLastCalledWith('zh');
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(bridge.broadcast.on).toHaveBeenCalledWith('locale-change', expect.any(Function));
  stop();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
it.each([
  ['zh-CN', 'zh'],
  ['zh_TW', 'zh'],
  ['zh-Hant', 'zh'],
  ['en-US', 'en'],
  ['EN_gb', 'en'],
  ['fr-FR', null],
  [null, null],
])('maps platform language %s to %s', async (input, expected) => {
  const { normalizeVosLanguage } = await import('../../frontend/src/services/vosLocaleService');
  expect(normalizeVosLanguage(input)).toBe(expected);
});
it('switches live, supports a persistent override, and can return to following VOS', async () => {
  const { initializeVosLocale, setVosLanguagePreference } = await import(
    '../../frontend/src/services/vosLocaleService'
  );
  const stop = await initializeVosLocale();
  receive({ locale: 'en-US' });
  await new Promise(setImmediate);
  expect(changeLanguage).toHaveBeenLastCalledWith('en');
  await setVosLanguagePreference('en');
  receive({ locale: 'zh-CN' });
  await new Promise(setImmediate);
  expect(changeLanguage).toHaveBeenLastCalledWith('en');
  expect(store.get('mcphub.vos.language')).toBe('en');
  await setVosLanguagePreference('auto');
  expect(changeLanguage).toHaveBeenLastCalledWith('zh');
  expect(store.has('mcphub.vos.language')).toBe(false);
  stop();
});
it('does not let a slow initial snapshot overwrite a newer platform event', async () => {
  let resolve!: (state: { locale: string }) => void;
  bridge.getState.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { initializeVosLocale } = await import('../../frontend/src/services/vosLocaleService');
  const ready = initializeVosLocale();
  receive({ locale: 'en-US' });
  resolve({ locale: 'zh-CN' });
  const stop = await ready;
  expect(changeLanguage).toHaveBeenLastCalledWith('en');
  stop();
});
it('honors an explicit language on initial load and falls back for unsupported VOS languages', async () => {
  store.set('mcphub.vos.language', 'zh');
  bridge.getState.mockResolvedValue({ locale: 'en-US' });
  const { initializeVosLocale, setVosLanguagePreference } = await import(
    '../../frontend/src/services/vosLocaleService'
  );
  const stop = await initializeVosLocale();
  expect(changeLanguage).toHaveBeenLastCalledWith('zh');
  await setVosLanguagePreference('auto');
  receive({ locale: 'fr-FR' });
  await new Promise(setImmediate);
  expect(changeLanguage).toHaveBeenLastCalledWith('en');
  stop();
});
it('keeps a usable language if the platform state request fails', async () => {
  bridge.getState.mockRejectedValue(new Error('bridge unavailable'));
  const { initializeVosLocale } = await import('../../frontend/src/services/vosLocaleService');
  const stop = await initializeVosLocale();
  expect(changeLanguage).toHaveBeenLastCalledWith('en');
  stop();
});
it('stops applying events after cleanup', async () => {
  const { initializeVosLocale } = await import('../../frontend/src/services/vosLocaleService');
  const stop = await initializeVosLocale();
  stop();
  const calls = changeLanguage.mock.calls.length;
  receive({ locale: 'en-US' });
  await new Promise(setImmediate);
  expect(changeLanguage).toHaveBeenCalledTimes(calls);
});
