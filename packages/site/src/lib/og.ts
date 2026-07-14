import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'

/** Open Graph card dimensions — the size link unfurlers expect. */
const WIDTH = 1200
const HEIGHT = 630

// Brand palette, mirrored from the site's dark code surface (Base.astro).
const BG = '#101418'
const NAME = '#f4f2ee'
const BRACE = '#ff6b4a'
const DESC = '#aab1b9'
const FAINT = '#6e7681'
const CHIP_BG = '#1b2027'
const CHIP_INK = '#9aa3ad'

// Resolved from the project root (cwd during `astro build`); import.meta.url is
// unreliable here because Astro bundles this module into dist/chunks/.
const mono = (file: string) => readFileSync(join(process.cwd(), 'src/assets/og', file))
const FONTS = [
  { name: 'JetBrains Mono', data: mono('JetBrainsMono-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  { name: 'JetBrains Mono', data: mono('JetBrainsMono-Bold.ttf'), weight: 700 as const, style: 'normal' as const },
]

/** A satori element node. Kept loose so the tree reads like plain markup. */
type Node = { type: string; props: { style: Record<string, unknown>; children?: unknown } }
const el = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
  type,
  props: { style, children },
})

/** The `{skill-set}` wordmark with brace-coloured accents and a "spec" sub-label. */
function wordmark(fontSize: number): Node {
  return el('div', { display: 'flex', alignItems: 'baseline', gap: 18, fontWeight: 700, letterSpacing: '-0.02em' }, [
    el('div', { display: 'flex', fontSize }, [
      el('span', { color: BRACE }, '{'),
      el('span', { color: NAME }, 'skill-set'),
      el('span', { color: BRACE }, '}'),
    ]),
    el('span', { fontSize: fontSize * 0.42, fontWeight: 400, color: FAINT }, 'spec'),
  ])
}

/** Site-wide default card used as the social preview across the site. */
export function renderDefaultCard(): Promise<Buffer> {
  const description =
    'Named, versioned sets of agent skills, defined in a single JSON manifest. An open format and CLI for sharing, installing, and verifying skill-sets.'
  const tree = el(
    'div',
    {
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      background: BG,
      color: DESC,
      fontFamily: 'JetBrains Mono',
      padding: '68px 76px',
    },
    [
      el('div', { display: 'flex', flexDirection: 'column', gap: 34 }, [
        el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }, [
          wordmark(66),
          el(
            'div',
            { display: 'flex', fontSize: 28, color: CHIP_INK, background: CHIP_BG, borderRadius: 10, padding: '8px 18px' },
            'draft',
          ),
        ]),
        el('div', { display: 'flex', fontSize: 33, lineHeight: 1.45, color: DESC, maxWidth: 940 }, description),
      ]),
      el(
        'div',
        {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          width: '100%',
          fontSize: 27,
          color: FAINT,
          borderTop: `1px solid ${CHIP_BG}`,
          paddingTop: 26,
        },
        [el('div', { display: 'flex' }, 'manifest · resolve · lock · verify'), el('div', { display: 'flex' }, 'skill-set.md')],
      ),
    ],
  )

  return satori(tree as never, { width: WIDTH, height: HEIGHT, fonts: FONTS }).then(
    (svg) => new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng(),
  )
}
