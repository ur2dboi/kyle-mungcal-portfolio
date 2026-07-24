// Vercel serverless — returns visitor IP + Vercel geo info
// Safe: does not store anything, just reflects back request metadata.
export const config = { runtime: 'edge' };

export default function handler(req) {
  const xff = req.headers.get('x-forwarded-for') || '';
  const ip = xff.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  const country = req.headers.get('x-vercel-ip-country') || '';
  const region = req.headers.get('x-vercel-ip-country-region') || '';
  const city = req.headers.get('x-vercel-ip-city') || '';
  const ua = req.headers.get('user-agent') || '';
  return new Response(
    JSON.stringify({ ip, country, region, city, ua }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, must-revalidate',
        'access-control-allow-origin': '*'
      }
    }
  );
}
