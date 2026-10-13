/**
 * The extension's bundle: one ES module, `dist/main.js`, exporting `activate`, and one stylesheet,
 * `dist/main.css`, which the Client adopts into the shadow root of each Calendar Events tab and each
 * Journal Panel.
 *
 * Everything is bundled, Svelte's runtime and EventCalendar included, because a precompiled Svelte
 * component must run against the exact Svelte that compiled it. The Extension API is imported for
 * its types only, so nothing of it lands in the bundle.
 */
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    plugins: [svelte()],
    base: './',
    // A library build leaves `process.env.NODE_ENV` for its consumer, but this bundle has none: the
    // browser imports it as it is.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
        lib: {
            entry: 'src/main.ts',
            formats: ['es'],
            fileName: () => 'main.js',
            cssFileName: 'main',
        },
        cssCodeSplit: false,
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
        target: 'es2022',
    },
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
})
