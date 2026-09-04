import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Includes simulator rules and the sampling harness; excludes the generated artifact. */
export function modelSourceHash(root = process.cwd()): string {
  const sourceFiles = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? sourceFiles(join(dir, e.name))
      : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
  const files = [...sourceFiles('shared'), 'scripts/zjh-generate-model.ts',
    'scripts/zjh-model-source.ts', 'tests/zjh-arena.ts'].sort();
  return createHash('sha256').update(files.map(f => f + '\n' + readFileSync(join(root, f), 'utf8'))
    .join('\n')).digest('hex');
}
