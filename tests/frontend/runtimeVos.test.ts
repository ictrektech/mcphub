import { getPublicBaseUrl } from '../../frontend/src/utils/runtime';
const originalWindow = global.window;
afterAll(() => {
  global.window = originalWindow;
});
it('uses the current VOS HTTPS origin and app path for copied endpoints', () => {
  global.window = {
    location: { origin: 'https://device.example:1180' },
    __MCPHUB_CONFIG__: { vosAuthEnabled: true, basePath: '/app/com.ictrek.mcphub' },
  } as unknown as Window & typeof globalThis;
  expect(getPublicBaseUrl('http://localhost:3000')).toBe(
    'https://device.example:1180/app/com.ictrek.mcphub',
  );
});
it('preserves a configured endpoint in standalone mode', () => {
  global.window = {
    __MCPHUB_CONFIG__: { vosAuthEnabled: false, basePath: '' },
  } as unknown as Window & typeof globalThis;
  expect(getPublicBaseUrl('https://gateway.example/')).toBe('https://gateway.example');
});
