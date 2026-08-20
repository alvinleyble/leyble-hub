// Node module-load hooks: resolve Vite-style extensionless imports and transform the
// app's .jsx sources with esbuild (the same transform Vite uses), so component tests
// can import the real components directly under `node --test`.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { transformSync } from 'esbuild';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.js', '.jsx']) {
        const candidate = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(specifier + ext, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.jsx')) {
      const { code } = transformSync(readFileSync(fileURLToPath(url), 'utf8'),
        { loader: 'jsx', format: 'esm', sourcefile: url });
      return { format: 'module', shortCircuit: true, source: code };
    }
    return nextLoad(url, context);
  },
});
