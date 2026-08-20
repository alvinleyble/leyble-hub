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
    // Everything under client/src goes through esbuild: .jsx for the syntax, .js so
    // Vite-only `import.meta.env` (api/client.js) resolves instead of throwing.
    if (url.startsWith('file:') && /\/client\/src\/.*\.jsx?$/.test(url)) {
      const { code } = transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
        loader: url.endsWith('.jsx') ? 'jsx' : 'js',
        format: 'esm',
        sourcefile: url,
        define: { 'import.meta.env': '{}' },
      });
      return { format: 'module', shortCircuit: true, source: code };
    }
    return nextLoad(url, context);
  },
});
