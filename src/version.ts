import { createRequire } from 'node:module';

// Resolved relative to this file: works from src/ (repo root) and from the
// bundled dist/ (package root) alike.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION: string = version;
