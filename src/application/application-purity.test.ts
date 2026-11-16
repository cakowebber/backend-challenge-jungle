import { expect, test } from 'bun:test';
import { dirname, join, normalize } from 'node:path';

/** A aplicação conhece o domínio e o Node, mas não o Nest, o ORM nem a infraestrutura. */
const ALLOWED_PACKAGES = new Set(['node:crypto']);

test('a camada de aplicação só importa dela mesma, do domínio e de node:crypto', async () => {
  const violations: string[] = [];
  let inspected = 0;

  for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: import.meta.dir })) {
    if (file.endsWith('.test.ts')) continue;
    inspected += 1;

    const source = await Bun.file(join(import.meta.dir, file)).text();
    for (const [, specifier] of source.matchAll(/from\s+'([^']+)'/g)) {
      if (specifier === undefined) continue;
      // caminho relativo a src/: só "application/..." (sem "..") ou "../domain/..." são aceitos
      const resolved = normalize(join('application', dirname(file), specifier));
      const allowed = specifier.startsWith('.')
        ? resolved.startsWith('application/') || resolved.startsWith('domain/')
        : ALLOWED_PACKAGES.has(specifier);
      if (!allowed) {
        violations.push(`${file} importa "${specifier}"`);
      }
    }
  }

  expect(inspected).toBeGreaterThan(5);
  expect(violations).toEqual([]);
});
