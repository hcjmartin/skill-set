// @ts-check
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { rehypeHeadingIds } from '@astrojs/markdown-remark'
import { defineConfig } from 'astro/config'

const SPEC_ROOT = fileURLToPath(new URL('../../spec', import.meta.url))
const PUBLIC_SCHEMA_ROOT = fileURLToPath(new URL('./public/schema', import.meta.url))
const CODEGEN_DIR = fileURLToPath(new URL('./.astro', import.meta.url))
const REPO_URL = 'https://github.com/hcjmartin/skill-set'

/**
 * Copies every spec/<version>/*.schema.json into public/schema/<version>/ so the built
 * site serves the schemas byte-identically at /schema/<version>/<file>. The copy runs on
 * every dev/build startup and public/schema/ is gitignored — the spec stays the only
 * source of truth, and /schema/v1/ appears automatically when spec/v1/ lands.
 */
function syncSpecSchemas() {
  return {
    name: 'sync-spec-schemas',
    hooks: {
      'astro:config:setup': () => {
        for (const entry of readdirSync(SPEC_ROOT, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const versionDir = join(SPEC_ROOT, entry.name)
          const schemas = readdirSync(versionDir).filter((f) => f.endsWith('.schema.json'))
          if (schemas.length === 0) continue
          const target = join(PUBLIC_SCHEMA_ROOT, entry.name)
          mkdirSync(target, { recursive: true })
          for (const file of schemas) copyFileSync(join(versionDir, file), join(target, file))
        }
      },
    },
  }
}

/**
 * Removes Astro's generated .astro/ codegen directory once a build or the dev server
 * finishes. The workspace lints from the repo root and the generated .d.ts files do not
 * pass its rules; the directory is regenerated from scratch on every astro run, so
 * nothing is lost. Run `astro sync` for editor types when working on the site.
 */
function cleanCodegen() {
  const clean = () => rmSync(CODEGEN_DIR, { recursive: true, force: true })
  return {
    name: 'clean-codegen',
    hooks: { 'astro:build:done': clean, 'astro:server:done': clean },
  }
}

/** Depth-first walk over a hast tree. */
function walk(node, fn) {
  fn(node)
  const children = node.children ?? []
  for (const child of children) walk(child, fn)
}

/**
 * The spec document links relative to its home in the repo (./skill-set.schema.json,
 * ./examples/…). On the site those targets live at the served schema URLs or on GitHub;
 * this plugin maps them so the document renders unmodified.
 */
function rewriteSpecLinks() {
  const rewrites = [
    [/^\.\/(skill-set(?:\.lock)?\.schema\.json)$/, (m) => `/schema/draft/${m[1]}`],
    [/^\.\/(examples\/?.*)$/, (m) => `${REPO_URL}/tree/main/spec/draft/${m[1]}`],
  ]
  return (tree) => {
    walk(tree, (node) => {
      if (node.type !== 'element' || node.tagName !== 'a') return
      const href = node.properties?.href
      if (typeof href !== 'string') return
      for (const [pattern, replace] of rewrites) {
        const match = href.match(pattern)
        if (match) {
          node.properties.href = replace(match)
          return
        }
      }
    })
  }
}

/** Appends a hover-revealed "#" link to every h2/h3 so sections are linkable. */
function anchorHeadings() {
  return (tree) => {
    walk(tree, (node) => {
      if (node.type !== 'element' || !['h2', 'h3'].includes(node.tagName)) return
      const id = node.properties?.id
      if (typeof id !== 'string') return
      node.children.push({
        type: 'element',
        tagName: 'a',
        properties: { href: `#${id}`, className: ['anchor'], 'aria-label': 'Link to this section' },
        children: [{ type: 'text', value: '#' }],
      })
    })
  }
}

export default defineConfig({
  site: 'https://skill-set.md',
  integrations: [syncSpecSchemas(), cleanCodegen()],
  markdown: {
    shikiConfig: { theme: 'github-dark-default' },
    // Astro injects heading ids after user plugins; run its id plugin first so
    // anchorHeadings sees them (and Astro skips re-slugging).
    rehypePlugins: [rehypeHeadingIds, rewriteSpecLinks, anchorHeadings],
  },
})
