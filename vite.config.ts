import { defineConfig } from 'vite';

// top-level await is used to load the baked city before the game starts
export default defineConfig({ build: { target: 'es2022' }, esbuild: { target: 'es2022' } });
