export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'URL video tidak boleh kosong' });
  }

  try {
    let videoDirectUrl = url;

    if (url.includes('labs.google/fx/tools/flow/shared/video/')) {
      try {
        console.log(`🔍 Mengekstrak tautan video langsung dari Google Labs: ${url}`);
        
        // Try parsing ID directly from URL
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        const videoIndex = pathParts.indexOf('video');
        const videoId = videoIndex !== -1 ? pathParts[videoIndex + 1] : null;
        
        if (videoId && /^[a-f0-9-]{36}$/i.test(videoId)) {
          videoDirectUrl = `https://labs.google/fx/api/og-video/shared/${videoId}`;
          console.log(`✅ Berhasil mengekstrak tautan video langsung (direct ID extraction): ${videoDirectUrl}`);
        } else {
          // Fallback to fetching HTML and parsing meta tag
          console.log('🔄 Memulai pengambilan HTML untuk pencarian meta tag...');
          const pageResponse = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Referer': 'https://labs.google/'
            }
          });
          if (!pageResponse.ok) {
            throw new Error(`Gagal memuat halaman: ${pageResponse.status} ${pageResponse.statusText}`);
          }
          const html = await pageResponse.text();
          const metaMatch = html.match(/<meta property="og:video" content="([^"]+)"/i) || 
                            html.match(/<meta name="twitter:player:stream" content="([^"]+)"/i);
          
          if (metaMatch && metaMatch[1]) {
            videoDirectUrl = metaMatch[1];
            console.log(`✅ Berhasil mengekstrak tautan video langsung dari meta tag: ${videoDirectUrl}`);
          } else {
            throw new Error('Tidak dapat menemukan tautan video langsung dalam metadata halaman.');
          }
        }
      } catch (extractError) {
        console.warn('⚠️ Gagal mengekstrak direct URL secara otomatis:', extractError.message);
        // Fall back to original URL if extraction fails
      }
    }

    return res.status(200).json({
      success: true,
      videoDirectUrl: videoDirectUrl,
      runClientSide: true
    });
  } catch (err) {
    console.error('❌ Gagal memproses video:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Terjadi kesalahan sistem saat mengekstrak URL'
    });
  }
}
