import type { APIRoute } from 'astro'
import { renderDefaultCard } from '../../lib/og'

export const GET: APIRoute = async () => {
  const png = await renderDefaultCard()
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
  })
}
