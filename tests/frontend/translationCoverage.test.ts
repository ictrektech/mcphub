import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const flatten = (object: Record<string, unknown>, prefix = ''): Set<string> => {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(object)) {
    const full = prefix + key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const child of flatten(value as Record<string, unknown>, full + '.')) keys.add(child);
    } else keys.add(full);
  }
  return keys;
};
function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}
it.each(['en', 'zh'])(
  'provides %s translations for every literal frontend translation key',
  (locale) => {
    const translated = flatten(
      JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8')),
    );
    const missing = new Set<string>();
    for (const file of sources(path.join(root, 'frontend/src'))) {
      for (const match of fs
        .readFileSync(file, 'utf8')
        .matchAll(/\bt\(['"]([A-Za-z][\w.-]+)['"]/g)) {
        if (!match[1].endsWith('.') && !translated.has(match[1])) missing.add(match[1]);
      }
    }
    expect([...missing].sort()).toEqual([]);
  },
);
