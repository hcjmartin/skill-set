import type { APIRoute } from 'astro'
// Raw spec markdown, read at build time — the same source the /spec/ page renders.
import spec from '../../../../spec/draft/README.md?raw'

export const GET: APIRoute = () =>
  new Response(spec, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
