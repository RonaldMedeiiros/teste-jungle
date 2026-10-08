const PORT = Number(process.env.FRONTEND_PORT ?? 8080);
const TARGETS: Record<string, string> = {
  api1: process.env.API1_URL ?? 'http://localhost:3001',
  api2: process.env.API2_URL ?? 'http://localhost:3002',
};

const html = Bun.file(new URL('./index.html', import.meta.url));

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const [, prefix, ...rest] = url.pathname.split('/');
    const target = prefix ? TARGETS[prefix] : undefined;

    if (!target) {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.delete('content-length');
    try {
      const upstream = await fetch(`${target}/${rest.join('/')}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      });
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
      });
    } catch (error) {
      return Response.json({ error: 'PROXY_ERROR', message: String(error) }, { status: 502 });
    }
  },
});

console.log(`frontend em http://localhost:${PORT}`);
