import { chmod } from 'node:fs/promises'

// npm supplies command shims on Windows; Unix installations need executable bins.
if (process.platform !== 'win32') {
  await Promise.all(['cli.js', 'ck.js'].map(file =>
    chmod(new URL(`../dist/${file}`, import.meta.url), 0o755),
  ))
}
