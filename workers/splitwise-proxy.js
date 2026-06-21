/**
 * Cloudflare Worker — Splitwise CORS proxy
 *
 * Forwards requests to the Splitwise v3.0 API and adds CORS headers so
 * the transaction-splitter web app can call it from the browser.
 *
 * Deploy with:
 *   npx wrangler deploy splitwise-proxy.js --name splitwise-proxy --compatibility-date 2025-01-01
 *
 * Then paste the worker URL (e.g. https://splitwise-proxy.<you>.workers.dev)
 * into the Proxy URL field on the Splitwise tab.
 */

const ALLOWED_ORIGINS = [
  'https://adamgagorik.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

const SW_BASE = 'https://secure.splitwise.com/api/v3.0';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':'));

    const corsHeaders = {
      'Access-Control-Allow-Origin':  allowed ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age':       '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (!allowed) {
      return new Response('Forbidden', { status: 403, headers: corsHeaders });
    }

    const url          = new URL(request.url);
    const splitwiseUrl = SW_BASE + url.pathname + url.search;

    const upstream = new Request(splitwiseUrl, {
      method:  request.method,
      headers: {
        'Authorization': request.headers.get('Authorization') || '',
        'Content-Type':  request.headers.get('Content-Type')  || 'application/json',
      },
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });

    const res     = await fetch(upstream);
    const newHdrs = new Headers(res.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => newHdrs.set(k, v));

    return new Response(res.body, {
      status:     res.status,
      statusText: res.statusText,
      headers:    newHdrs,
    });
  },
};
