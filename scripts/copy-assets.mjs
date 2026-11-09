import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/dash', { recursive: true });
cpSync('src/dash', 'dist/dash', { recursive: true });
