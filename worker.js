/**
 * CarScreen Hub - Cloudflare Worker Proxy
 * 
 * Deploy this to Cloudflare Workers to enable Secure mode.
 * All YouTube search and video traffic gets routed through this proxy,
 * so the car browser only sees traffic to your worker domain.
 * 
 * SETUP:
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 * 2. Paste this code
 * 3. Deploy
 * 4. Update CONFIG.WORKER_URL in index.html with your worker URL
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      // ── PROXY ENDPOINT ──
      // /proxy?url=<encoded_url>
      // Fetches any URL and returns it with CORS headers
      if (url.pathname === '/proxy') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
          return jsonResponse({ error: 'Missing url parameter' }, 400);
        }

        // Validate allowed domains
        const allowed = isAllowedDomain(targetUrl);
        if (!allowed) {
          return jsonResponse({ error: 'Domain not allowed' }, 403);
        }

        const response = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json, text/html, */*',
          },
          cf: { cacheTtl: 300 } // Cache for 5 minutes
        });

        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const body = await response.arrayBuffer();

        return new Response(body, {
          status: response.status,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=300',
          }
        });
      }

      // ── YOUTUBE SEARCH ──
      // /yt/search?q=<query>
      // Searches via Invidious/Piped and returns results
      if (url.pathname === '/yt/search') {
        const query = url.searchParams.get('q');
        if (!query) {
          return jsonResponse({ error: 'Missing q parameter' }, 400);
        }

        const results = await searchYouTube(query);
        return jsonResponse(results);
      }

      // ── YOUTUBE EMBED PROXY ──
      // /yt/embed/<videoId>
      // Returns a page that embeds the video via Invidious
      if (url.pathname.startsWith('/yt/embed/')) {
        const videoId = url.pathname.split('/yt/embed/')[1];
        if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
          return new Response('Invalid video ID', { status: 400 });
        }

        const embedHtml = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{margin:0;padding:0}
  html,body{width:100%;height:100%;background:#000;overflow:hidden}
  iframe{width:100%;height:100%;border:none}
</style>
</head><body>
<iframe src="https://inv.tux.pizza/embed/${videoId}?autoplay=1" 
        allowfullscreen allow="autoplay; encrypted-media"></iframe>
</body></html>`;

        return new Response(embedHtml, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/html; charset=utf-8',
          }
        });
      }

      // ── DEFAULT ──
      return new Response('CarScreen Hub Proxy\n\nEndpoints:\n  /proxy?url=<url>\n  /yt/search?q=<query>\n  /yt/embed/<videoId>', {
        headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS }
      });

    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
};

// ══════════════════════════════════════════
// YOUTUBE SEARCH via Invidious/Piped
// ══════════════════════════════════════════
const INVIDIOUS = [
  'https://inv.tux.pizza',
  'https://invidious.fdn.fr',
  'https://vid.puffyan.us',
  'https://invidious.nerdvpn.de',
];

const PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
];

async function searchYouTube(query) {
  // Try Invidious first
  for (const instance of INVIDIOUS) {
    try {
      const resp = await fetch(
        `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
        { cf: { cacheTtl: 600 } }
      );
      if (!resp.ok) continue;
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) {
        return data.filter(v => v.type === 'video').slice(0, 15).map(v => ({
          videoId: v.videoId,
          title: v.title,
          author: v.author,
          thumbnail: v.videoThumbnails?.[4]?.url || v.videoThumbnails?.[0]?.url || '',
          duration: v.lengthSeconds,
          views: v.viewCount,
        }));
      }
    } catch (e) { continue; }
  }

  // Fallback to Piped
  for (const instance of PIPED) {
    try {
      const resp = await fetch(
        `${instance}/search?q=${encodeURIComponent(query)}&filter=videos`,
        { cf: { cacheTtl: 600 } }
      );
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data?.items?.length > 0) {
        return data.items.slice(0, 15).map(v => ({
          videoId: (v.url || '').replace('/watch?v=', ''),
          title: v.title,
          author: v.uploaderName,
          thumbnail: v.thumbnail || '',
          duration: v.duration,
          views: v.views,
        }));
      }
    } catch (e) { continue; }
  }

  return [];
}

// ══════════════════════════════════════════
// DOMAIN ALLOWLIST
// ══════════════════════════════════════════
function isAllowedDomain(urlStr) {
  try {
    const u = new URL(urlStr);
    const allowed = [
      'inv.tux.pizza', 'invidious.fdn.fr', 'vid.puffyan.us',
      'invidious.nerdvpn.de', 'iv.ggtyler.dev',
      'pipedapi.kavin.rocks', 'pipedapi.adminforge.de',
      'api.piped.projectsegfau.lt',
      'maps.googleapis.com', 'maps.google.com',
      'i.ytimg.com', 'yt3.ggpht.com', // YouTube thumbnails
    ];
    return allowed.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
    }
  });
}
