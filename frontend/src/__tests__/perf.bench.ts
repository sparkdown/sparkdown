// @vitest-environment jsdom
/**
 * Performance measurement harness — NOT run in CI (vitest bench is opt-in:
 * `npx vitest bench --run`). Times the real render pipeline over documents
 * of increasing size to locate where wall-clock goes on large files.
 *
 * Regenerate the corpus shape by editing makeDoc(); sizes are deterministic.
 */
import { bench, describe } from 'vitest';
import { PreviewPane } from '../preview';
import { EventBus } from '../events';

function makeDoc(sections: number): string {
  const langs = ['javascript', 'python', 'rust', 'json', 'bash'];
  const out: string[] = ['# Performance Test Document\n'];
  for (let s = 1; s <= sections; s++) {
    out.push(`## Section ${s}: Lorem Heading With Some Length\n`);
    for (let p = 0; p < 3; p++) {
      out.push(
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor '.repeat(3) +
          'incididunt ut labore. **Ut enim** ad minim veniam, quis `nostrud` exercitation ' +
          '[ullamco](https://example.com) laboris nisi ut aliquip.\n',
      );
    }
    out.push('### Subsection details\n');
    out.push('- item one with some **bold** text\n- item two with `inline code`\n- item three\n');
    const lang = langs[s % langs.length];
    const code = Array.from(
      { length: 15 },
      (_, i) => `const value_${i} = compute(${i}) + "string literal ${i}"; // comment`,
    ).join('\n');
    out.push(`\`\`\`${lang}\n${code}\n\`\`\`\n`);
    out.push('> A blockquote with some quoted wisdom about performance testing.\n');
    out.push('| Col A | Col B | Col C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n');
  }
  return out.join('\n');
}

const SMALL = makeDoc(10); //   ~33 KB — typical note
const MEDIUM = makeDoc(60); //  ~200 KB — long doc
const LARGE = makeDoc(200); // ~660 KB — stress

function makePane(): { pane: PreviewPane; container: HTMLElement } {
  const pane = new PreviewPane(new EventBus());
  const container = document.createElement('div');
  document.body.appendChild(container);
  pane.init(container);
  pane.setRenderMode('notes.md');
  return { pane, container };
}

describe('full render (parse + highlight + innerHTML)', () => {
  bench('small (~33 KB)', async () => {
    const { pane } = makePane();
    await pane.renderImmediateForExport(SMALL);
  });

  bench('medium (~200 KB)', async () => {
    const { pane } = makePane();
    await pane.renderImmediateForExport(MEDIUM);
  });

  bench('large (~660 KB)', async () => {
    const { pane } = makePane();
    await pane.renderImmediateForExport(LARGE);
  });
});

describe('re-render same pane (highlight cache warm)', () => {
  bench('large, 1-char append per render', async () => {
    const { pane } = makePane();
    await pane.renderImmediateForExport(LARGE);
    // Simulates typing at the end of a large doc: every keystroke re-parses
    // and re-renders the entire document today.
    await pane.renderImmediateForExport(LARGE + 'x');
    await pane.renderImmediateForExport(LARGE + 'xy');
  });
});
