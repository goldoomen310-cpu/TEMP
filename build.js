const fs = require('fs');
const path = require('path');

let renderApiUrl = process.env.RENDER_API_URL || '';
const indexPath = path.join(__dirname, 'index.html');

// Automatically append /api if not present
if (renderApiUrl && !renderApiUrl.endsWith('/api')) {
  renderApiUrl = renderApiUrl + '/api';
}

try {
  let html = fs.readFileSync(indexPath, 'utf8');

  // Inject the API_BASE_OVERRIDE at the very beginning of <head>
  const encoded = renderApiUrl ? Buffer.from(renderApiUrl, 'utf8').toString('base64') : '';
  const scriptTag = `<script>window.API_BASE_OVERRIDE = atob("${encoded}");</script>`;

  // Insert right after <head> tag
  if (html.includes('<head>')) {
    html = html.replace('<head>', `<head>\n    ${scriptTag}`);
  } else {
    console.error('Could not find <head> tag in index.html');
    process.exit(1);
  }

  // Write the modified HTML back to the file
  fs.writeFileSync(indexPath, html, 'utf8');

  if (!renderApiUrl) {
    console.warn('RENDER_API_URL not set. Using relative path for API calls.');
  }

  console.log('Build completed successfully');
  console.log('Injected API_BASE_OVERRIDE:', renderApiUrl || '(empty)');
} catch (error) {
  console.error('Build error:', error.message);
  process.exit(1);
}
