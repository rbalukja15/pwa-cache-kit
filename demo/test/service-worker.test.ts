import { describe, expect, it } from 'vitest';
import { shellVersion, writeServiceWorker, type ShellFile } from '../build/service-worker.js';

const build: readonly ShellFile[] = [
  { fileName: 'index.html', content: '<title>Ticket Wallet</title>' },
  { fileName: 'assets/main-abc.js', content: 'console.log(1)' },
  { fileName: 'icons/icon-192.png', content: new Uint8Array([1, 2, 3]) },
];

function replace(fileName: string, content: ShellFile['content']): ShellFile[] {
  return build.map((file) => (file.fileName === fileName ? { fileName, content } : file));
}

describe('shellVersion', () => {
  it('is stable for the same files in any order', () => {
    expect(shellVersion([...build].reverse())).toBe(shellVersion(build));
  });

  it.each([
    ['index.html', '<title>Tickets</title>'],
    ['icons/icon-192.png', new Uint8Array([1, 2, 4])],
  ])('changes when %s changes but keeps its name', (fileName, content) => {
    expect(shellVersion(replace(fileName, content))).not.toBe(shellVersion(build));
  });

  it('changes when a file is renamed', () => {
    const renamed = build.map((file) =>
      file.fileName === 'assets/main-abc.js' ? { ...file, fileName: 'assets/main-def.js' } : file,
    );
    expect(shellVersion(renamed)).not.toBe(shellVersion(build));
  });
});

describe('writeServiceWorker', () => {
  it.each(['"', "'", '`'])('fills in a placeholder quoted with %s and every version token', (q) => {
    const code = `var a=${q}__PRECACHE_MANIFEST__${q},b=\`x-__SHELL_VERSION__\`,c="__SHELL_VERSION__";`;
    expect(writeServiceWorker(code, ['./', 'a.js'], 'v1')).toBe(
      'var a=["./","a.js"],b=`x-v1`,c="v1";',
    );
  });

  it('fails when a placeholder is missing', () => {
    expect(() => writeServiceWorker('"__SHELL_VERSION__"', [], 'v1')).toThrow('PRECACHE');
    expect(() => writeServiceWorker('"__PRECACHE_MANIFEST__"', [], 'v1')).toThrow('VERSION');
  });
});
