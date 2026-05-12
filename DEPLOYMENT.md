# Deployment Guide for AnimePulse

## Architecture: Split Deployment

This guide covers deploying with:
- **Render** = Backend API server
- **Vercel** = Frontend static site

## Required Environment Variables

### On Render (Backend)
Set these in Render dashboard → Settings → Environment:

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key
- `JWT_SECRET` - A random secret string (at least 32 characters)
- `ALLOWED_ORIGINS` - Must include your Vercel frontend URL (e.g., `https://your-app.vercel.app`)

### On Vercel (Frontend)
Set this in Vercel dashboard → Settings → Environment Variables:

- `RENDER_API_URL` - Your Render backend URL (e.g., `https://your-app.onrender.com`)

## Render Deployment (Backend)

1. Push your code to GitHub
2. Create new Web Service in Render
3. Set environment variables (see above)
4. Set build command: `npm install`
5. Set start command: `node server.js`
6. Deploy
7. Note your Render URL (e.g., `https://your-app.onrender.com`)

## Vercel Deployment (Frontend)

1. Push your code to GitHub
2. Import project in Vercel
3. Set `RENDER_API_URL` environment variable to your Render backend URL
4. Deploy

The build script will automatically inject the Render API URL into your frontend.

## Critical: CORS Configuration

On Render, the `ALLOWED_ORIGINS` environment variable is critical. It must include your Vercel frontend domain, otherwise the frontend will be blocked by CORS.

**Example:**
```
ALLOWED_ORIGINS=https://myapp.vercel.app
```

If you want to also allow local development:
```
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173,https://myapp.vercel.app
```

## How It Works

1. **Frontend (Vercel)**: The build script injects `RENDER_API_URL` into `index.html` as `window.API_BASE_OVERRIDE`
2. **Backend (Render)**: The server checks `ALLOWED_ORIGINS` to verify requests from your Vercel domain
3. **API Calls**: Frontend makes requests to Render backend, which proxies to external APIs

## Troubleshooting

**Episodes not loading / Anime not showing:**
1. Check that `ALLOWED_ORIGINS` on Render includes your Vercel domain
2. Verify `RENDER_API_URL` is set correctly on Vercel
3. Check browser console for CORS errors
4. Check Render logs for API errors

**API requests failing:**
1. Ensure Render backend is running and accessible
2. Verify the Render URL in browser network tab matches `RENDER_API_URL`
3. Check that external APIs (senshi.live, consumet) are accessible

**Build errors on Vercel:**
1. Ensure `build.js` script exists in the app directory
2. Check that Node.js version is compatible (>=18.0.0)
