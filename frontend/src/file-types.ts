import type { Extension } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascript as jsLang } from '@codemirror/lang-javascript';
import { html as htmlLang } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { json as jsonLang } from '@codemirror/lang-json';

export const TEXT_EXTS = [
  'md', 'markdown', 'mkd',
  'txt', 'log', 'csv', 'tsv',
  'json', 'yml', 'yaml', 'toml', 'toon',
  'cfg', 'conf', 'ini', 'env', 'properties',
  'js', 'ts', 'jsx', 'tsx',
  'html', 'css', 'svg', 'xml',
] as const;

export const TEXT_EXT_RE = new RegExp(`\\.(${TEXT_EXTS.join('|')})$`, 'i');

export function isTextFile(path: string): boolean {
  return TEXT_EXT_RE.test(path);
}

export const DIALOG_FILTERS = [
  { name: 'Text Files', extensions: [...TEXT_EXTS] },
  { name: 'All Files', extensions: ['*'] },
];

const tsxLang = () => jsLang({ typescript: true, jsx: true });
const LANG_MAP: Record<string, () => Extension> = {
  js: jsLang, mjs: jsLang, cjs: jsLang,
  json: jsonLang,
  ts: tsxLang, tsx: tsxLang, jsx: tsxLang,
  html: htmlLang, htm: htmlLang, svg: htmlLang,
  css: cssLang, scss: cssLang,
};

export function getLanguageFor(path: string | null): Extension {
  const ext = path?.split('.').pop()?.toLowerCase() || 'md';
  return LANG_MAP[ext]?.() ?? markdown({ base: markdownLanguage });
}
