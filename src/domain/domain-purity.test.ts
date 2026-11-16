import { expect, test } from 'bun:test';
import { dirname, join, normalize } from 'node:path';

/** Única dependência externa permitida no domínio. */
const ALLOWED_PACKAGES = new Set(['decimal.js']);

test('o domínio não importa Nest, ORM nem nenhuma outra camada', async () => {
  const violations: string[] = [];
  let inspected = 0;

  for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: import.meta.dir })) {
    if (file.endsWith('.test.ts')) continue;
    inspected += 1;

    const source = await Bun.file(join(import.meta.dir, file)).text();
    for (const [, specifier] of source.matchAll(/from\s+'([^']+)'/g)) {
      if (specifier === undefined) continue;
      // Relativo só é aceito se, resolvido, continuar dentro de src/domain.
      const staysInDomain =
        specifier.startsWith('.') && !normalize(join(dirname(file), specifier)).startsWith('..');
      if (!staysInDomain && !ALLOWED_PACKAGES.has(specifier)) {
        violations.push(`${file} importa "${specifier}"`);
      }
    }
  }

  expect(inspected).toBeGreaterThan(5);
  expect(violations).toEqual([]);
});
