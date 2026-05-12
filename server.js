/**
 * AniView server — powered by Senshi.live API
 *
 * All anime data, episode lists, and stream URLs are sourced from senshi.live.
 * The /api/media proxy handles CORS for m3u8 playlists and video segments.
 */
const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

// ─── Supabase ────────────────────────────────────────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// ─── JWT ────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
const JWT_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds
const COOKIE_NAME = 'token';

function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_MAX_AGE });
}

function verifyToken(token) {
    try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function getAuthUser(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies[COOKIE_NAME];
    if (!token) return null;
    return verifyToken(token);
}

function parseCookies(cookieHeader) {
    const result = {};
    if (!cookieHeader) return result;
    cookieHeader.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        if (key) result[key] = decodeURIComponent(val);
    });
    return result;
}

function setCookie(res, name, value, maxAgeSeconds) {
    const isProd = process.env.NODE_ENV === 'production';
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        `HttpOnly`,
        `Path=/`,
        `SameSite=${isProd ? 'None' : 'Lax'}`,
        `Max-Age=${maxAgeSeconds}`
    ];
    if (isProd) parts.push('Secure');
    const existing = res.getHeader('Set-Cookie') || [];
    const header = Array.isArray(existing) ? existing : [existing];
    header.push(parts.join('; '));
    res.setHeader('Set-Cookie', header);
}

function clearCookie(res, name) {
    const isProd = process.env.NODE_ENV === 'production';
    const existing = res.getHeader('Set-Cookie') || [];
    const header = Array.isArray(existing) ? existing : [existing];
    header.push(`${name}=; HttpOnly; Path=/; SameSite=${isProd ? 'None' : 'Lax'}; Max-Age=0${isProd ? '; Secure' : ''}`);
    res.setHeader('Set-Cookie', header);
}

// ─── CORS with credentials support ───────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',').map(s => s.trim()).filter(Boolean);

function corsForOrigin(req) {
    const origin = req?.headers?.origin;
    // Same-origin request (no Origin header)
    if (!origin) return {};
    // If the origin is in our allowed list, echo it back
    if (ALLOWED_ORIGINS.includes(origin)) {
        return {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Credentials': 'true',
            'Vary': 'Origin'
        };
    }
    // In production, if ALLOWED_ORIGINS is set but origin not in list, deny
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.some(o => o.includes('localhost'))) {
        return { 'Access-Control-Allow-Origin': 'null' };
    }
    // For unknown origins during development, still allow with credentials
    // This makes local dev easier while staying secure in production
    return {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin'
    };
}

const SENSHI  = 'https://senshi.live';
const CONSUMET = 'https://api-consumet-org-taupe.vercel.app';
const ANIMEPULSE = 'https://aniverse.omkapi.click/api';
const CORS_PROXY = 'https://api.milkywiffle.workers.dev';

// ─── In-memory cache ─────────────────────────────────────────────────────────
const apiCache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
function cacheGet(key) {
    const entry = apiCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) { apiCache.delete(key); return null; }
    return entry.data;
}
function cacheSet(key, data) { apiCache.set(key, { data, ts: Date.now() }); }
function cacheKey(...parts) { return parts.join('::'); }

// ─── Shared helpers ───────────────────────────────────────────────────────────

function send(res, status, body, headers = {}) {
    res.writeHead(status, {
        'Access-Control-Allow-Origin' : '*',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        ...headers
    });
    res.end(body);
}
function sendJson(res, status, payload, extraHeaders = {}) {
    send(res, status, JSON.stringify(payload),
        { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
}
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js'  : 'text/javascript; charset=utf-8',
    '.css' : 'text/css; charset=utf-8',  '.json': 'application/json; charset=utf-8',
    '.svg' : 'image/svg+xml',            '.png' : 'image/png',
    '.jpg' : 'image/jpeg',               '.jpeg': 'image/jpeg', '.webp': 'image/webp'
};
function absoluteUrl(value, base) {
    try { return new URL(value, base).toString(); } catch { return value; }
}
function safeHeaders(h) {
    const blocked = new Set(['host','connection','content-length','accept-encoding']);
    return Object.fromEntries(
        Object.entries(h || {})
            .filter(([k,v]) => v != null && !blocked.has(k.toLowerCase()))
            .map(([k,v]) => [k, String(v)])
    );
}
function decodeHeaders(v) {
    if (!v) return {};
    try { return JSON.parse(Buffer.from(v,'base64url').toString('utf8')) || {}; } catch { return {}; }
}
function encodeHeaders(h) {
    return Buffer.from(JSON.stringify(h || {}), 'utf8').toString('base64url');
}
function proxiedUrl(target, headers = {}) {
    let url = `${CORS_PROXY}?url=${encodeURIComponent(target)}`;
    const h = encodeHeaders(headers);
    if (h) url += `&headers=${encodeURIComponent(h)}`;
    return url;
}
function rewritePlaylist(text, playlistUrl, headers) {
    return text.split(/\r?\n/).map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#'))
            return line.replace(/URI="([^"]+)"/g, (_, u) =>
                `URI="${proxiedUrl(absoluteUrl(u, playlistUrl), headers)}"`);
        return proxiedUrl(absoluteUrl(t, playlistUrl), headers);
    }).join('\n');
}
function readBody(req) {
    return new Promise((res, rej) => {
        const c = [];
        req.on('data', d => c.push(d));
        req.on('end',  () => res(Buffer.concat(c).toString('utf8')));
        req.on('error', rej);
    });
}

// ─── Senshi.live API helpers ──────────────────────────────────────────────────

async function senshiFetch(endpoint, opts = {}) {
    const url = `${CORS_PROXY}?url=${encodeURIComponent(`${SENSHI}${endpoint}`)}`;
    const r = await fetch(url, {
        ...opts,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            ...(opts.headers || {})
        }
    });
    if (!r.ok) throw new Error(`Senshi HTTP ${r.status} on ${endpoint}`);
    return r.json();
}

async function senshiPost(endpoint, body) {
    return senshiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

// ─── AnimePulse API helpers ────────────────────────────────────────────────────

async function animepulseFetch(endpoint) {
    const url = `${CORS_PROXY}?url=${encodeURIComponent(`${ANIMEPULSE}${endpoint}`)}`;
    const r = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) return null;
    return r.json();
}
function normAnimepulsePost(p) {
    return {
        id       : String(p.id),
        title    : p.title || '',
        poster   : p.poster || '',
        type     : p.type || 'TV',
        score    : p.score ? String(p.score) : '',
        genres   : p.genres || '',
        overview : p.overview || '',
        status   : p.status || 'Unknown',
        premiered: p.premiered || '',
        malId    : null,
        hasKyoto : !!(p.playerConfig && p.playerConfig.packageName === 'com.kyotoplayer'),
        source   : 'animepulse'
    };
}
function decodeHtmlEntities(s) {
    return String(s || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
        .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&#x27;/g,"'")
        .replace(/&#x2F;/g,'/').replace(/&#x60;/g,'`').replace(/&#x3D;/g,'=');
}

// Check if a single AnimePulse post has KYOTO player
async function checkAnimepulsePost(postId) {
    try {
        const detail = await animepulseFetch(`/post?id=${postId}`);
        return detail?.playerConfig?.packageName === 'com.kyotoplayer';
    } catch { return false; }
}

// Batch-check which Anilist results exist in AnimePulse
// For each result, searches AnimePulse by title, checks first 5 results for KYOTO player
async function animepulseBatchCheck(anilistResults) {
    if (!anilistResults?.length) return new Map();
    const titleMap = new Map();
    const all = anilistResults.slice(0, 50);

    await Promise.allSettled(all.map(async r => {
        const title = r.title || r.japaneseTitle || '';
        if (!title) return;
        const key = normTitle(title);
        if (titleMap.has(key)) return;

        try {
            const search = await animepulseFetch(`/search?query=${encodeURIComponent(title)}&page=1`);
            if (!search?.posts?.length) return;
            for (const p of search.posts.slice(0, 5)) {
                if (await checkAnimepulsePost(p.id)) {
                    titleMap.set(key, p.id);
                    return;
                }
            }
        } catch { /* not found on animepulse */ }
    }));

    return titleMap;
}

// ─── KYOTO Player API helpers ─────────────────────────────────────────────────

const KYOTO_API = 'https://app.kyotoplayer.com/api/v4';
const KYOTO_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'os-version': '35',
    'app-id': 'com.kyotoplayer',
    'app-version': '124',
    'User-Agent': 'Mozilla/5.0'
};

async function kyotoplayerPost(postId) {
    const r = await fetch(`${KYOTO_API}/post?id=${encodeURIComponent(postId)}`, {
        headers: KYOTO_HEADERS
    });
    if (!r.ok) return null;
    return r.json();
}

async function kyotoplayerPlayer(embedUrl) {
    const r = await fetch(`${KYOTO_API}/kai/player?embed=${encodeURIComponent(embedUrl)}&source=zoro`, {
        headers: KYOTO_HEADERS
    });
    if (!r.ok) return null;
    return r.json();
}

async function kyotoplayerFetchHls(postId, episodeNum = '1', lang = 'sub') {
    try {
        // 1. Get post → episodes URL
        const post = await kyotoplayerPost(postId);
        if (!post?.episodes) return null;

        // 2. Fetch episodes list
        const epsRes = await fetch(post.episodes, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (!epsRes.ok) return null;
        const epsData = await epsRes.json();
        const eps = epsData?.list || [];
        const ep = eps.find(e => e.number === episodeNum) || eps[0];
        if (!ep) return null;

        // 3. Get servers for episode
        const serversUrl = post.servers?.replace('%id%', ep.id);
        if (!serversUrl) return null;
        const srvRes = await fetch(serversUrl, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (!srvRes.ok) return null;
        const srvData = await srvRes.json();
        const servers = srvData?.list || [];
        // Match requested language, fall back to any
        const server = servers.find(s => s.lang === lang) || servers[0];
        if (!server) return null;

        // 4. Get iframe embed link
        const srvObj = typeof post.server === 'string' ? { url: post.server } : (post.server || {});
        const iframeUrl = srvObj.url?.replace('%id%', server.id);
        if (!iframeUrl) return null;
        const iframeRes = await fetch(iframeUrl, {
            headers: {
                'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': iframeUrl
            }
        });
        if (!iframeRes.ok) return null;
        const iframeData = await iframeRes.json();
        const embedLink = iframeData?.link;
        if (!embedLink) return null;

        // 5. Fetch embed page and extract HLS URL from JWPlayer setup
        const embedRes = await fetch(embedLink, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!embedRes.ok) return null;
        const html = await embedRes.text();

        // Extract HLS URL from JWPlayer sources array
        const match = html.match(/file:\s*'([^']+\.m3u8[^']*)'/);
        if (!match) return null;

        const videoHeaders = {};
        return {
            url: match[1],
            isM3U8: true,
            quality: 'default',
            headers: { Referer: 'https://anidb.app/' }
        };
    } catch { return null; }
}

// ─── Normalize Senshi data to our card format ─────────────────────────────────

function normSenshiAnime(a) {
    return {
        id      : a.public_id || String(a.id),
        malId   : a.id,
        title   : a.title_english || a.title || 'Anime',
        japaneseTitle: a.title || '',
        poster  : a.anime_picture ? `${SENSHI}${a.anime_picture}` : '',
        backdrop: a.anime_picture ? `${SENSHI}${a.anime_picture}` : '',
        score   : a.score != null ? String(a.score) : '',
        status  : a.ani_status || 'Unknown',
        type    : a.type || 'TV',
        genres  : a.genres || '',
        episodes: a.ani_episodes || '?',
        overview: a.ani_description || '',
        premiered: a.ani_season && a.ani_year ? `${a.ani_season} ${a.ani_year}` : '',
        studios : a.studios || '',
        producers: a.producers || '',
        airing_date: a.airing_date || '',
        rating  : a.rating || '',
        source  : 'senshi'
    };
}

function normSenshiEpisode(ep) {
    return {
        id     : String(ep.ep_id),
        number : String(ep.ep_id),
        title  : ep.ep_title || `Episode ${ep.ep_id}`,
        filler : !!ep.ep_filler,
        recap  : !!ep.ep_recap,
        intro_start: ep.intro_start,
        intro_end  : ep.intro_end,
        outro_start: ep.outro_start,
        outro_end  : ep.outro_end
    };
}

// ─── Consumet (GogoAnime) fallback helpers ────────────────────────────────────

async function consumetSearch(query, page = 1) {
    try {
        const r = await fetch(
            `${CONSUMET}/anime/gogoanime/${encodeURIComponent(query)}?page=${page}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!r.ok) return [];
        const data = await r.json();
        return (data.results || []).map(a => ({
            id      : `gogo:${a.id}`,
            malId   : null,
            title   : a.title || '',
            japaneseTitle: '',
            poster  : a.image || '',
            backdrop: a.image || '',
            score   : '',
            status  : a.status || 'Unknown',
            type    : a.type || 'TV',
            genres  : '',
            episodes: a.totalEpisodes || 0,
            overview: '',
            premiered: a.releaseDate || '',
            studios : '',
            subOrDub: a.subOrDub || 'Sub',
            source  : 'gogoanime'
        }));
    } catch { return []; }
}

async function consumetInfo(gogoId) {
    const r = await fetch(`${CONSUMET}/anime/gogoanime/info/${encodeURIComponent(gogoId)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Consumet info HTTP ${r.status}`);
    const data = await r.json();
    const eps = (data.episodes || []).map(e => ({
        id    : `gogo:${e.id}`,
        number: String(e.number),
        title : e.title || `Episode ${e.number}`,
        filler: false,
        recap : false
    }));
    return {
        id      : `gogo:${data.id}`,
        malId   : null,
        title   : data.title || '',
        japaneseTitle: data.otherName || '',
        poster  : data.image || '',
        backdrop: data.image || '',
        score   : data.score || '',
        status  : data.status || 'Unknown',
        type    : data.type || 'TV',
        genres  : Array.isArray(data.genres) ? data.genres.join(', ') : (data.genres || ''),
        episodes: data.totalEpisodes || eps.length,
        overview: data.description || '',
        premiered: data.releaseDate || '',
        studios : '',
        subOrDub: data.subOrDub || 'Sub',
        source  : 'gogoanime',
        episodeList: eps,
        hasHardSub: false,
        hasDub  : data.subOrDub === 'Dub' || data.hasSub === false
    };
}

async function consumetWatch(gogoEpId) {
    const r = await fetch(`${CONSUMET}/anime/gogoanime/watch/${encodeURIComponent(gogoEpId)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const data = await r.json();
    const srcs = (data.sources || []).map(s => ({
        url    : s.url,
        isM3U8 : s.isM3U8 !== false,
        quality: s.quality || 'default'
    }));
    return srcs.map(s => ({
        ...s,
        url: s.isM3U8 ? proxiedUrl(s.url, { Referer: CONSUMET }) : s.url
    }));
}

function dedupe(arr) {
    return Array.from(new Map(arr.map(i => [i.id, i])).values());
}

function normTitle(t) {
    return String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function dedupeByTitle(arr) {
    const seen = new Set();
    return arr.filter(item => {
        const key = normTitle(item.title);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─── Anilist GraphQL direct search (fallback when Consumet is broken) ──

const ANILIST_GRAPHQL = 'https://graphql.anilist.co';

async function anilistGraphQLSearch(query, page = 1, format = '', genre = '', year = '', season = '', sort = '', status = '') {
    const ck = cacheKey('gql', query, page, format, genre, year, season, sort, status);
    const cached = cacheGet(ck);
    if (cached) return cached;
    try {
        const statusVar = status ? `status: ${status}` : '';
        const searchQuery = `
            query ($s: String, $page: Int, $perPage: Int, $format: MediaFormat, $genre: String, $year: Int, $season: MediaSeason, $sort: [MediaSort${status ? ', $stat: MediaStatus' : ''}]) {
                Page(page: $page, perPage: $perPage) {
                    media(search: $s, format: $format, genre: $genre, seasonYear: $year, season: $season, sort: $sort, type: ANIME, isAdult: false${status ? ', status: $stat' : ''}) {
                        id
                        idMal
                        title { romaji english native userPreferred }
                        coverImage { extraLarge large medium color }
                        bannerImage
                        seasonYear
                        season
                        format
                        status
                        genres
                        averageScore
                        meanScore
                        episodes
                        description
                        studios { nodes { name } }
                    }
                }
            }`;
        const sortMap = {
            'TRENDING_DESC': 'TRENDING_DESC',
            'POPULARITY_DESC': 'POPULARITY_DESC',
            'SCORE_DESC': 'SCORE_DESC',
            'START_DATE_DESC': 'START_DATE_DESC',
            'UPDATED_AT_DESC': 'UPDATED_AT_DESC'
        };
        const sortVal = sortMap[sort] || (query ? 'SEARCH_MATCH' : 'TRENDING_DESC');
        const variables = {
            s: query || null,
            page,
            perPage: 50,
            format: format || null,
            genre: genre || null,
            year: year ? parseInt(year) : null,
            season: season || null,
            sort: sortVal !== 'SEARCH_MATCH' ? [sortVal] : ['TRENDING_DESC', 'SCORE_DESC']
        };
        if (status) variables.stat = status;
        // Clean nulls
        Object.keys(variables).forEach(k => { if (variables[k] == null) delete variables[k]; });
        const r = await fetch(ANILIST_GRAPHQL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: searchQuery, variables })
        });
        if (!r.ok) {
            const txt = await r.text().catch(() => '');
            console.error(`Anilist GraphQL HTTP ${r.status}: ${txt}`);
            return [];
        }
        const data = await r.json();
        const media = data?.data?.Page?.media || [];
        const results = media.map(a => {
            const t = a.title || {};
            return {
                id      : `anilist:${a.id}`,
                malId   : a.idMal || null,
                title   : t.english || t.romaji || t.userPreferred || t.native || '',
                japaneseTitle: t.native || t.romaji || '',
                poster  : a.coverImage?.extraLarge || a.coverImage?.large || '',
                backdrop: a.bannerImage || a.coverImage?.extraLarge || '',
                score   : a.averageScore ? String(Math.round(a.averageScore / 10)) : '',
                status  : a.status || 'Unknown',
                type    : a.format || 'TV',
                genres  : Array.isArray(a.genres) ? a.genres.join(', ') : '',
                episodes: a.episodes || 0,
                overview: (a.description || '').replace(/<[^>]*>/g, ''),
                premiered: a.season && a.seasonYear ? `${a.season} ${a.seasonYear}` : String(a.seasonYear || ''),
                studios : (a.studios?.nodes || []).map(s => s.name).join(', '),
                subOrDub: 'Sub',
                source  : 'anilist',
                servers : []
            };
        });
        cacheSet(ck, results);
        return results;
    } catch (err) {
        console.error('Anilist GraphQL error:', err.message);
        return [];
    }
}

async function anilistGraphQLTrending(page = 1) {
    return anilistGraphQLSearch('', page, '', '', '', '', 'TRENDING_DESC');
}

async function anilistGraphQLPopular(page = 1) {
    return anilistGraphQLSearch('', page, '', '', '', '', 'POPULARITY_DESC');
}

// ─── Anilist (Meta) fallback helpers ──────────────────────────────────

async function anilistFetch(endpoint) {
    const r = await fetch(`${CONSUMET}/meta/anilist${endpoint}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) { console.error(`Anilist HTTP ${r.status} on ${endpoint}`); return null; }
    return r.json();
}

function normAnilistAnime(a) {
    const t = a.title || {};
    return {
        id      : `anilist:${a.id}`,
        malId   : a.malId || null,
        title   : t.english || t.romaji || t.userPreferred || t.native || '',
        japaneseTitle: t.native || t.romaji || '',
        poster  : a.image || '',
        backdrop: a.cover || a.image || '',
        score   : a.rating ? String(Math.round(a.rating / 10)) : '',
        status  : a.status || 'Unknown',
        type    : a.type || 'TV',
        genres  : Array.isArray(a.genres) ? a.genres.join(', ') : '',
        episodes: a.totalEpisodes || 0,
        overview: (a.description || '').replace(/<[^>]*>/g, ''),
        premiered: a.releaseDate || '',
        studios : '',
        subOrDub: 'Sub',
        source  : 'anilist'
    };
}

async function anilistAdvancedSearch(query, page = 1, format = '', genres = '', yearStart = '', yearEnd = '') {
    try {
        let url = `/advanced-search?page=${page}&perPage=20`;
        if (query)  url += `&query=${encodeURIComponent(query)}`;
        if (format) url += `&format=${encodeURIComponent(format)}`;
        if (genres) url += `&genres=${encodeURIComponent(genres)}`;
        if (yearStart) url += `&yearStart=${encodeURIComponent(yearStart)}`;
        if (yearEnd)   url += `&yearEnd=${encodeURIComponent(yearEnd)}`;
        const data = await anilistFetch(url);
        return (data?.results || []).map(normAnilistAnime);
    } catch { return []; }
}

async function anilistSearch(query, page = 1, format = '', genres = '') {
    try {
        let url = `/advanced-search?query=${encodeURIComponent(query)}&page=${page}&perPage=50`;
        if (format) url += `&format=${encodeURIComponent(format)}`;
        const data = await anilistFetch(url);
        return (data?.results || []).map(normAnilistAnime);
    } catch { return []; }
}

async function anilistTrending(page = 1) {
    try {
        const data = await anilistFetch(`/trending?page=${page}&perPage=50`);
        return (data?.results || []).map(normAnilistAnime);
    } catch { return []; }
}

async function anilistPopular(page = 1) {
    try {
        const data = await anilistFetch(`/popular?page=${page}&perPage=50`);
        return (data?.results || []).map(normAnilistAnime);
    } catch { return []; }
}

async function anilistInfo(anilistId) {
    // Try Consumet first, fall back to direct Anilist GraphQL
    let data, eps = [], characters = [], nextAiringEpisode = null, globalId = null, malId = null;

    const consumetData = await anilistFetch(`/info/${encodeURIComponent(anilistId)}`);
    if (consumetData) {
        data = consumetData;
        eps = (data.episodes || []).map(e => ({
            id    : `anilist:${e.id}`,
            number: String(e.number),
            title : e.title || `Episode ${e.number}`,
            filler: e.filler || false,
            recap : e.recap || false
        }));
        characters = (data.characters || []).slice(0, 20).map(c => ({
            id: c.id,
            name: c.name?.full || c.name || '',
            image: c.image || c.poster || '',
            role: c.role || 'MAIN',
            voiceActors: (c.voiceActors || []).slice(0, 2).map(va => ({
                name: va.name?.full || va.name || '',
                image: va.image || ''
            }))
        }));
        globalId = data.id;
        malId = data.malId || null;
        // Generate episodes from total count if Consumet didn't return any
        if (!eps.length && (data.totalEpisodes || data.episodes?.length)) {
            const total = data.totalEpisodes || data.episodes?.length;
            for (let i = 1; i <= total; i++) {
                eps.push({ id: `anilist:${globalId}-${i}`, number: String(i), title: `Episode ${i}`, filler: false, recap: false });
            }
        }
    } else {
        // GraphQL fallback for metadata — try Anilist ID first, then MAL ID
        try {
            const idNum = parseInt(anilistId, 10);
            if (isNaN(idNum)) throw new Error('Invalid ID');
            let m;
            // Attempt 1: query by Anilist ID
            const qById = `query ($id: Int) { Media(id: $id, type: ANIME) {
                id idMal
                title { romaji english native }
                coverImage { extraLarge large medium }
                bannerImage
                format status genres averageScore meanScore episodes description
                seasonYear season
                studios { nodes { name isAnimationStudio } }
                characters(role: MAIN, perPage: 12) {
                    edges { node { id name { full } image { large } } role voiceActors { id name { full } image { large } } }
                }
                nextAiringEpisode { airingAt timeUntilAiring episode }
            }}`;
            const r1 = await fetch(ANILIST_GRAPHQL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ query: qById, variables: { id: idNum } })
            });
            if (r1.ok) {
                const gql1 = await r1.json();
                m = gql1?.data?.Media;
            }
            // Attempt 2: query by MAL ID if first attempt failed
            if (!m) {
                const qByMal = `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) {
                    id idMal
                    title { romaji english native }
                    coverImage { extraLarge large medium }
                    bannerImage
                    format status genres averageScore meanScore episodes description
                    seasonYear season
                    studios { nodes { name isAnimationStudio } }
                    characters(role: MAIN, perPage: 12) {
                        edges { node { id name { full } image { large } } role voiceActors { id name { full } image { large } } }
                    }
                    nextAiringEpisode { airingAt timeUntilAiring episode }
                }}`;
                const r2 = await fetch(ANILIST_GRAPHQL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ query: qByMal, variables: { idMal: idNum } })
                });
                if (r2.ok) {
                    const gql2 = await r2.json();
                    m = gql2?.data?.Media;
                }
            }
            if (!m) throw new Error('Not found');
            const t = m.title || {};
            malId = m.idMal;
            globalId = m.id;
            nextAiringEpisode = m.nextAiringEpisode || null;
            if (m.characters?.edges) {
                characters = m.characters.edges.map(e => ({
                    id: e.node?.id,
                    name: e.node?.name?.full || '',
                    image: e.node?.image?.large || '',
                    role: e.role || 'MAIN',
                    voiceActors: (e.voiceActors || []).slice(0, 2).map(va => ({
                        name: va.name?.full || '',
                        image: va.image?.large || ''
                    }))
                })).filter(c => c.name);
            }
            data = {
                id: m.id, malId: m.idMal,
                title: t,
                image: m.coverImage?.extraLarge || m.coverImage?.large || '',
                cover: m.bannerImage || '',
                rating: m.averageScore || null,
                status: m.status || '',
                type: m.format || '',
                genres: m.genres || [],
                totalEpisodes: m.episodes || 0,
                description: m.description || '',
                releaseDate: m.season && m.seasonYear ? `${m.seasonYear}` : '',
                studios: (m.studios?.nodes || []).filter(s => s.isAnimationStudio).map(s => s.name),
                episodes: []
            };
            // Generate episodes from total count for GraphQL fallback
            if (m.episodes) {
                for (let i = 1; i <= m.episodes; i++) {
                    eps.push({ id: `anilist:${m.id}-${i}`, number: String(i), title: `Episode ${i}`, filler: false, recap: false });
                }
            }
        } catch (e) {
            throw new Error('Anilist info failed: ' + e.message);
        }
    }

    if (!data) throw new Error('Anilist info failed');

    const t = data.title || {};

    return {
        id      : `anilist:${globalId || data.id}`,
        malId   : malId || data.malId || null,
        title   : t.english || t.romaji || '',
        japaneseTitle: t.native || '',
        poster  : data.image || '',
        backdrop: data.cover || data.image || '',
        score   : data.rating ? String(Math.round(data.rating / 10)) : '',
        status  : data.status || 'Unknown',
        type    : data.type || 'TV',
        genres  : Array.isArray(data.genres) ? data.genres.join(', ') : '',
        episodes: data.totalEpisodes || data.episodes || eps.length,
        overview: (data.description || '').replace(/<[^>]*>/g, ''),
        premiered: data.releaseDate || '',
        studios : Array.isArray(data.studios) ? data.studios.join(', ') : (data.studios || ''),
        subOrDub: 'Sub',
        source  : 'anilist',
        episodeList: eps,
        characters,
        nextAiringEpisode,
        hasHardSub: false,
        hasDub  : false
    };
}

async function anilistWatch(anilistId, episode) {
    try {
        const data = await anilistFetch(`/watch/${encodeURIComponent(anilistId)}?episode=${encodeURIComponent(episode)}`);
        if (!data) return [];
        const srcs = (data.sources || []).map(s => ({
            url    : s.url,
            isM3U8 : s.isM3U8 !== false,
            quality: s.quality || 'default',
            headers: s.headers || {}
        }));
        return srcs.map(s => ({
            ...s,
            url: s.isM3U8 ? proxiedUrl(s.url, { ...s.headers, Referer: s.headers?.Referer || CONSUMET }) : s.url
        }));
    } catch { return []; }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleBrowse(reqUrl, res) {
    try {
        const keyword = reqUrl.searchParams.get('keyword') || '';
        const sort    = (reqUrl.searchParams.get('sort') || 'trending').toLowerCase();
        const page    = Math.max(1, parseInt(reqUrl.searchParams.get('page') || '1', 10));

        // Search by keyword
        if (keyword) {
            // Same fast-path approach as handleSearch
            let posts = [];
            try {
                const senshiData = await senshiPost('/anime/filter', { searchTerm: keyword, page, limit: 50 });
                posts = (senshiData.data || []).map(normSenshiAnime);
            } catch { /* senshi unreachable */ }

            if (posts.length < 30) {
                const anilistResults = await anilistSearch(keyword, page);
                if (anilistResults.length) {
                    const existingTitles = new Set(posts.map(r => normTitle(r.title)));
                    const unknown = anilistResults.filter(a => !existingTitles.has(normTitle(a.title)));
                    if (unknown.length && posts.length > 0) {
                        const checks = await Promise.allSettled(
                            unknown.map(async r => ({
                                result: r,
                                available: r.malId ? await senshiCheck(r.malId) : false
                            }))
                        );
                        const extra = checks
                            .filter(c => c.status === 'fulfilled' && c.value.available)
                            .map(c => ({ ...c.value.result, id: String(c.value.result.malId), source: 'senshi' }));
                        posts = [...posts, ...extra];
                    } else if (!posts.length) {
                        posts = anilistResults;
                    }
                }
            }

            if (posts.length < 10) {
                const gogo = await consumetSearch(keyword, page);
                const existingTitles = new Set(posts.map(r => normTitle(r.title)));
                const extra = gogo.filter(g => !existingTitles.has(normTitle(g.title)));
                posts = [...posts, ...extra];
            }

            return sendJson(res, 200, {
                posts, results: posts, source: posts.some(p => p.source !== 'senshi') ? 'mixed' : 'senshi', page,
                hasNext: posts.length >= 50
            });
        }

        // Sort-based browse
        if (sort === 'recent' || sort === 'updated_date') {
            const items = await senshiFetch('/anime/recently-added');
            const posts = (Array.isArray(items) ? items : []).map(normSenshiAnime);
            return sendJson(res, 200, { posts, results: posts, source: 'senshi', page: 1, hasNext: false });
        }
        if (sort === 'upcoming') {
            const items = await senshiFetch('/anime/upcoming');
            const posts = (Array.isArray(items) ? items : []).map(normSenshiAnime);
            return sendJson(res, 200, { posts, results: posts, source: 'senshi', page: 1, hasNext: false });
        }
        if (sort === 'score' || sort === 'favorite') {
            // Use trending/month as a proxy for "top rated"
            const items = await senshiFetch('/anime/trending/month');
            const posts = (Array.isArray(items) ? items : []).map(normSenshiAnime);
            return sendJson(res, 200, { posts, results: posts, source: 'senshi', page: 1, hasNext: false });
        }

        // Default: trending
        const period = sort === 'week' ? 'week' : sort === 'month' ? 'month' : 'day';
        const items = await senshiFetch(`/anime/trending/${period}`);
        const posts = (Array.isArray(items) ? items : []).map(normSenshiAnime);
        return sendJson(res, 200, { posts, results: posts, source: 'senshi', page: 1, hasNext: false });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

async function handleDetail(reqUrl, res) {
    try {
        const id = reqUrl.searchParams.get('id');
        if (!id) return sendJson(res, 400, { error: 'Missing id' });

        // GogoAnime source
        if (id.startsWith('gogo:')) {
            const info = await consumetInfo(id.slice(5));
            return sendJson(res, 200, { ...info, servers: ['senshi'] });
        }

        // Anilist source
        if (id.startsWith('anilist:')) {
            const info = await anilistInfo(id.slice(8));
            return sendJson(res, 200, { ...info, servers: ['senshi'] });
        }

        // AnimePulse source
        if (id.startsWith('animepulse:')) {
            const rawId = id.slice(11);
            const data = await animepulseFetch(`/post?id=${rawId}`);
            if (!data) return sendJson(res, 404, { error: 'Not found' });
            const post = normAnimepulsePost(data);
            // Try fetching episode list from KYOTO Player API
            let episodeList = [];
            let hasDub = false;
            try {
                const kp = await kyotoplayerPost(rawId);
                if (kp?.episodes) {
                    const epsRes = await fetch(kp.episodes, {
                        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
                    });
                    if (epsRes.ok) {
                        const epsData = await epsRes.json();
                        episodeList = (epsData?.list || []).map(e => ({
                            id: String(e.id),
                            number: String(e.number),
                            title: e.name || `Episode ${e.number}`,
                            filler: !!e.filler
                        }));
                    }
                    // Check if dub servers exist for episode 1
                    if (kp.servers) {
                        const firstEp = episodeList[0];
                        if (firstEp) {
                            const srvUrl = kp.servers.replace('%id%', firstEp.id);
                            const srvRes = await fetch(srvUrl, {
                                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
                            });
                            if (srvRes.ok) {
                                const srvData = await srvRes.json();
                                hasDub = (srvData?.list || []).some(s => s.lang === 'dub');
                            }
                        }
                    }
                }
            } catch { /* kyoto episodes optional */ }

            // Also try senshi so Server 1 button appears
            let senshiMalId = null;
            try {
                const searchTitle = decodeHtmlEntities(post.title || '');
                if (searchTitle) {
                    const senshiSearch = await senshiFetch(`/search?query=${encodeURIComponent(searchTitle)}`);
                    if (Array.isArray(senshiSearch) && senshiSearch.length > 0) {
                        const match = senshiSearch[0];
                        if (match?.id) {
                            senshiMalId = String(match.id);
                        }
                    }
                }
            } catch { /* senshi search optional */ }

            const servers = senshiMalId ? ['senshi', 'animepulse'] : ['animepulse'];
            return sendJson(res, 200, {
                ...post,
                id: `animepulse:${rawId}`,
                malId: senshiMalId,
                episodeList,
                subEpisodes: episodeList.map(e => e.number),
                dubEpisodes: hasDub ? episodeList.map(e => e.number) : [],
                hasHardSub: false,
                hasDub,
                servers,
                playerConfig: post.playerConfig || null
            });
        }

        // Try senshi first
        try {
            const anime = await senshiFetch(`/anime/${encodeURIComponent(id)}`);
            if (!anime || !anime.id) throw new Error('Not found');

            let episodes = [];
            try {
                const epData = await senshiFetch(`/episodes/${anime.id}`);
                episodes = (Array.isArray(epData) ? epData : []).map(normSenshiEpisode);
            } catch { /* no episodes */ }

            let hasHardSub = false, hasDub = false;
            if (episodes.length > 0) {
                try {
                    const embeds = await senshiFetch(`/episode-embeds/${anime.id}/1`);
                    const statuses = (Array.isArray(embeds) ? embeds : []).map(e => e.status);
                    hasHardSub = statuses.some(s => s === 'HardSub');
                    hasDub     = statuses.some(s => s === 'Dub');
                } catch { /* ignore */ }
            }

            const norm = normSenshiAnime(anime);
            // Overlay accurate fields from Anilist metadata
            try {
                const al = await anilistGraphQLSearch(norm.title, 1, '', '', '', '', '');
                if (al?.[0]) {
                    const m = al[0];
                    norm.status = m.status || norm.status;
                    norm.genres = m.genres || norm.genres;
                    norm.score  = m.score || norm.score;
                    norm.type   = m.type || norm.type;
                    norm.overview = m.overview || norm.overview;
                    norm.premiered = m.premiered || norm.premiered;
                    norm.studios = m.studios || norm.studios;
                }
            } catch { /* optional */ }

            // Fetch characters + next airing from AniList GraphQL
            let characters = [];
            let nextAiringEpisode = null;
            try {
                const alId = anime.id; // MAL ID
                if (alId) {
                    const ck2 = cacheKey('detail-gql', String(alId));
                    const cachedDetail = cacheGet(ck2);
                    if (cachedDetail) {
                        characters = cachedDetail.characters;
                        nextAiringEpisode = cachedDetail.nextAiringEpisode;
                    } else {
                        const gql = await fetch('https://graphql.anilist.co', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                            body: JSON.stringify({
                                query: `query($idMal:Int){Media(idMal:$idMal,type:ANIME){id characters(role:MAIN,perPage:12){edges{node{id name{full}image{large}}role voiceActors{id name{full}image{large}}}}nextAiringEpisode{airingAt timeUntilAiring episode}}}}`,
                                variables: { idMal: Number(alId) }
                            })
                        });
                        if (gql.ok) {
                            const gqlData = await gql.json();
                            const media = gqlData?.data?.Media;
                            if (media?.characters?.edges) {
                                characters = media.characters.edges.map(e => ({
                                    id: e.node?.id,
                                    name: e.node?.name?.full || '',
                                    image: e.node?.image?.large || '',
                                    role: e.role || 'MAIN',
                                    voiceActors: (e.voiceActors || []).slice(0, 2).map(va => ({
                                        name: va.name?.full || '',
                                        image: va.image?.large || ''
                                    }))
                                })).filter(c => c.name);
                            }
                            nextAiringEpisode = media?.nextAiringEpisode || null;
                        }
                        cacheSet(ck2, { characters, nextAiringEpisode });
                    }
                }
            } catch { /* optional */ }

            let servers = ['senshi'];
            let animepulseId = reqUrl.searchParams.get('animepulseId') || null;
            if (animepulseId) {
                if (await checkAnimepulsePost(animepulseId)) {
                    servers.push('animepulse');
                } else {
                    animepulseId = null;
                }
            }
            if (!animepulseId) {
                try {
                    const searchTitle = norm.title || norm.japaneseTitle || '';
                    if (searchTitle) {
                        const apSearch = await animepulseFetch(`/search?query=${encodeURIComponent(searchTitle)}&page=1`);
                        if (apSearch?.posts?.length) {
                            for (const p of apSearch.posts.slice(0, 5)) {
                                if (await checkAnimepulsePost(p.id)) {
                                    servers.push('animepulse');
                                    animepulseId = p.id;
                                    break;
                                }
                            }
                        }
                    }
                } catch { /* optional */ }
            }
            return sendJson(res, 200, {
                ...norm,
                malId: anime.id,
                episodes: episodes.length,
                episodeList: episodes,
                subEpisodes: episodes.map(e => e.number),
                dubEpisodes: hasDub ? episodes.map(e => e.number) : [],
                hasHardSub, hasDub,
                servers,
                animepulseId,
                characters,
                nextAiringEpisode,
                playerConfig: { activityName: 'senshi' }
            });
        } catch { /* senshi failed */ }

        // Fallback: try Anilist by numeric MAL ID or anilist: prefix
        let anilistId = '';
        if (id.startsWith('anilist:')) {
            anilistId = id.slice(8);
        } else if (/^\d+$/.test(id)) {
            anilistId = id;
        }
        if (anilistId) {
            try {
                const info = await anilistInfo(anilistId);
                return sendJson(res, 200, { ...info, servers: ['senshi'] });
            } catch { /* anilist also failed */ }
        }

        // Last fallback: try as bare animepulse ID
        if (/^\d+$/.test(id)) {
            try {
                const data = await animepulseFetch(`/post?id=${id}`);
                if (data) {
                    const post = normAnimepulsePost(data);
                    let episodeList = [], hasDub = false;
                    try {
                        const kp = await kyotoplayerPost(id);
                        if (kp?.episodes) {
                            const epsRes = await fetch(kp.episodes, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
                            if (epsRes.ok) {
                                const epsData = await epsRes.json();
                                episodeList = (epsData?.list || []).map(e => ({ id: String(e.id), number: String(e.number), title: e.name || `Episode ${e.number}`, filler: !!e.filler }));
                            }
                            if (kp.servers && episodeList[0]) {
                                const srvUrl = kp.servers.replace('%id%', episodeList[0].id);
                                const srvRes = await fetch(srvUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
                                if (srvRes.ok) { const srvData = await srvRes.json(); hasDub = (srvData?.list || []).some(s => s.lang === 'dub'); }
                            }
                        }
                    } catch { /* kyoto optional */ }
                    return sendJson(res, 200, { ...post, id: `animepulse:${id}`, malId: null, episodeList, subEpisodes: episodeList.map(e => e.number), dubEpisodes: hasDub ? episodeList.map(e => e.number) : [], hasHardSub: false, hasDub, servers: ['animepulse'], playerConfig: post.playerConfig || null });
                }
            } catch { /* animepulse fallback failed */ }
        }

        return sendJson(res, 404, { error: 'Not found on any source' });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// Helper to get anime title by MAL ID for fallback searches
async function getAnimeTitleByMalId(malId) {
    try {
        const r = await fetch(ANILIST_GRAPHQL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                query: 'query($idMal:Int){Media(idMal:$idMal,type:ANIME){title{english romaji}}}',
                variables: { idMal: Number(malId) }
            })
        });
        if (!r.ok) return null;
        const data = await r.json();
        const title = data?.data?.Media?.title;
        return title?.english || title?.romaji || null;
    } catch {
        return null;
    }
}

async function handleStream(reqUrl, res) {
    try {
        const malId = reqUrl.searchParams.get('malId');
        const ep    = reqUrl.searchParams.get('ep') || '1';
        const lang  = reqUrl.searchParams.get('lang') || 'sub';
        if (!malId) return sendJson(res, 400, { error: 'Missing malId' });

        // GogoAnime source — ep holds the full episode slug (e.g., "steins-gate-episode-1")
        // or falls back to constructing from malId + ep number
        if (malId.startsWith('gogo:')) {
            const baseId = malId.slice(5);
            const cleanEp = ep.startsWith('gogo:') ? ep.slice(5) : ep;
            const episodeSlug = cleanEp.includes('-episode-') ? cleanEp : `${baseId}-episode-${cleanEp}`;
            const srcs = await consumetWatch(episodeSlug);
            if (!srcs.length) return sendJson(res, 404, { error: 'No streams' });
            return sendJson(res, 200, {
                sources: srcs,
                streams: srcs.map(s => ({ url: s.url, status: s.quality }))
            });
        }

        // Anilist source
        if (malId.startsWith('anilist:')) {
            const baseId = malId.slice(8);
            const srcs = await anilistWatch(baseId, ep);
            if (!srcs.length) return sendJson(res, 404, { error: 'No streams' });
            return sendJson(res, 200, {
                sources: srcs,
                streams: srcs.map(s => ({ url: s.url, status: s.quality }))
            });
        }

        // AnimePulse source — stream via KYOTO Player API
        if (malId.startsWith('animepulse:')) {
            const rawId = malId.slice(11);
            const src = await kyotoplayerFetchHls(rawId, ep, lang);
            if (!src) {
                console.error(`[handleStream] KYOTO Player returned no source for id=${rawId} ep=${ep} lang=${lang}`);
                return sendJson(res, 404, { error: 'No streams from KYOTO Player' });
            }
            const proxiedUrl_src = proxiedUrl(src.url, { Referer: 'https://anidb.app/' });
            return sendJson(res, 200, {
                url: proxiedUrl_src,
                type: 'hls',
                sources: [{ ...src, url: proxiedUrl_src }],
                streams: [{ url: proxiedUrl_src, status: 'default' }]
            });
        }

        let embeds;
        try {
            embeds = await senshiFetch(`/episode-embeds/${encodeURIComponent(malId)}/${encodeURIComponent(ep)}`);
        } catch (err) {
            console.error(`[handleStream] Senshi fetch failed for ${malId}/${ep}:`, err.message);
            // Try AnimePulse fallback if Senshi fails
            try {
                const searchTitle = await getAnimeTitleByMalId(malId);
                if (searchTitle) {
                    const apSearch = await animepulseFetch(`/search?query=${encodeURIComponent(searchTitle)}&page=1`);
                    if (apSearch?.posts?.length) {
                        for (const p of apSearch.posts.slice(0, 5)) {
                            if (await checkAnimepulsePost(p.id)) {
                                const src = await kyotoplayerFetchHls(p.id, ep, lang);
                                if (src) {
                                    const proxiedUrl_src = proxiedUrl(src.url, { Referer: 'https://anidb.app/' });
                                    return sendJson(res, 200, {
                                        url: proxiedUrl_src,
                                        type: 'hls',
                                        sources: [{ ...src, url: proxiedUrl_src }],
                                        streams: [{ url: proxiedUrl_src, status: 'animepulse' }]
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (fallbackErr) {
                console.error(`[handleStream] AnimePulse fallback also failed:`, fallbackErr.message);
            }
            return sendJson(res, 404, { error: 'No streams available (Senshi unavailable, AnimePulse fallback failed)' });
        }

        if (!Array.isArray(embeds) || !embeds.length) {
            return sendJson(res, 404, { error: 'No streams for this episode' });
        }

        // Pick preferred stream: dub→Dub, sub→any non-Dub embed
        const statuses = embeds.map(e => e.status);
        console.log(`[handleStream] ${malId} ep=${ep} lang=${lang} statuses=${JSON.stringify(statuses)}`);
        const isDub = e => e.status?.toLowerCase() === 'dub';
        const nonDub = embeds.filter(e => !isDub(e));
        const preferred = lang === 'dub'
            ? embeds.find(e => isDub(e)) || nonDub[0] || embeds[0]
            : nonDub[0] || embeds[0];

        if (!preferred?.url) return sendJson(res, 404, { error: 'No stream URL' });

        const isM3U8 = /\.m3u8/i.test(preferred.url);
        const url    = isM3U8 ? proxiedUrl(preferred.url, { Referer: 'https://senshi.live/' }) : preferred.url;

        // Return all available sources for UI
        const allSources = embeds
            .filter(e => e.url)
            .map(e => {
                const m = /\.m3u8/i.test(e.url);
                return {
                    url    : m ? proxiedUrl(e.url, { Referer: 'https://senshi.live/' }) : e.url,
                    isM3U8 : m,
                    quality: e.status || 'default'
                };
            });

        return sendJson(res, 200, {
            url, type: 'hls', embed: false,
            status: preferred.status,
            headers: {},
            sources: allSources.length ? allSources : [{ url, isM3U8: true, quality: preferred.status || 'default' }],
            streams: embeds.map(e => ({ url: e.url, status: e.status }))
        });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

async function handleLatest(reqUrl, res) {
    try {
        const data = await senshiFetch('/episode-embeds/latest');
        const items = (Array.isArray(data) ? data : []).map(item => ({
            id        : item.anime?.public_id || String(item.mal_id),
            malId     : item.mal_id,
            title     : item.anime?.title_english || item.anime?.title || 'Anime',
            poster    : item.anime?.anime_picture ? `${SENSHI}${item.anime.anime_picture}` : '',
            episode   : item.ep_id,
            epTitle   : item.episode?.ep_title || `Episode ${item.ep_id}`,
            status    : item.status,
            type      : item.anime?.type || 'TV',
            aniStatus : item.anime?.ani_status || '',
            createdAt : item.created_at
        }));
        return sendJson(res, 200, { items, source: 'senshi' });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

async function handleTrending(reqUrl, res) {
    try {
        const period = reqUrl.searchParams.get('period') || 'day';
        const valid  = ['day','week','month'];
        const p      = valid.includes(period) ? period : 'day';
        const items  = await senshiFetch(`/anime/trending/${p}`);
        const posts  = (Array.isArray(items) ? items : []).map(normSenshiAnime);
        return sendJson(res, 200, { posts, results: posts, source: 'senshi' });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

async function handleSchedule(reqUrl, res) {
    try {
        const data = await senshiFetch('/schedule');
        return sendJson(res, 200, { schedule: data, source: 'senshi' });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

async function handleSliders(reqUrl, res) {
    try {
        const data = await senshiFetch('/sliders');
        const items = (Array.isArray(data) ? data : []).map(s => ({
            id     : s.id,
            title  : s.anime?.title_english || s.anime?.title || '',
            poster : s.anime?.anime_picture ? `${SENSHI}${s.anime.anime_picture}` : '',
            image  : s.image_url ? `${SENSHI}${s.image_url}` : '',
            animeId: s.anime?.public_id || String(s.anime?.id || ''),
            overview: s.anime?.ani_description || '',
            type   : s.anime?.type || 'TV',
            status : s.anime?.ani_status || '',
            score  : s.anime?.score != null ? String(s.anime.score) : '',
            genres : s.anime?.genres || ''
        }));
        return sendJson(res, 200, { items, source: 'senshi' });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

async function handleRandom(reqUrl, res) {
    try {
        const anime = await senshiFetch('/anime/random');
        return sendJson(res, 200, normSenshiAnime(anime));
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// ─── Sliders (hero carousel) ──────────────────────────────────────────────────

async function handleSlidersV2(reqUrl, res) {
    try {
        const data = await senshiFetch('/sliders');
        const items = (Array.isArray(data) ? data : []).map(s => ({
            id     : s.id,
            title  : s.anime?.title_english || s.anime?.title || '',
            image  : s.image_url ? `${SENSHI}${s.image_url}` : (s.anime?.anime_picture ? `${SENSHI}${s.anime.anime_picture}` : ''),
            animeId: s.anime?.public_id || String(s.anime?.id || ''),
            overview: s.anime?.ani_description || '',
            type   : s.anime?.type || 'TV',
            status : s.anime?.ani_status || '',
            score  : s.anime?.score != null ? String(s.anime.score) : '',
            genres : s.anime?.genres || ''
        }));
        sendJson(res, 200, { items });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// ─── Trending with period support + merge multiple periods ────────────────────

async function handleTrendingV2(reqUrl, res) {
    try {
        const period = reqUrl.searchParams.get('period') || 'day';
        const valid  = ['day','week','month'];
        const p      = valid.includes(period) ? period : 'day';

        const [day, week, month, anilistTrend] = await Promise.allSettled([
            senshiFetch('/anime/trending/day'),
            senshiFetch('/anime/trending/week'),
            senshiFetch('/anime/trending/month'),
            anilistTrending(1)
        ]);

        const toArr = r => r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];
        const primary   = toArr(p === 'day' ? day : p === 'week' ? week : month);
        const secondary = toArr(p === 'day' ? week : p === 'week' ? month : day);
        const tertiary  = toArr(p === 'day' ? month : p === 'week' ? day : week);

        const senshi = [...primary, ...secondary, ...tertiary].map(normSenshiAnime);
        const anilist = anilistTrend.status === 'fulfilled' ? anilistTrend.value : [];

        const merged = dedupeByTitle([...senshi, ...anilist]);
        sendJson(res, 200, { results: merged });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// ─── Top Airing (merged trending) ─────────────────────────────────────────────

async function handleTopAiring(reqUrl, res) {
    try {
        const [senshiDay, senshiWeek, senshiMonth, anilistPop, anilistTrend] = await Promise.allSettled([
            senshiFetch('/anime/trending/day'),
            senshiFetch('/anime/trending/week'),
            senshiFetch('/anime/trending/month'),
            anilistPopular(1),
            anilistTrending(1)
        ]);

        const toArr = r => r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];
        const senshi = [
            ...toArr(senshiDay), ...toArr(senshiWeek), ...toArr(senshiMonth)
        ].map(normSenshiAnime);

        const anilistPopArr = anilistPop.status === 'fulfilled' ? anilistPop.value : [];
        const anilistTrendArr = anilistTrend.status === 'fulfilled' ? anilistTrend.value : [];
        const anilist = dedupeByTitle([...anilistPopArr, ...anilistTrendArr]);

        const ids = new Set(senshi.map(s => normTitle(s.title)));
        const extra = anilist.filter(a => !ids.has(normTitle(a.title)));

        const merged = dedupeByTitle([...senshi, ...extra]);
        sendJson(res, 200, { results: merged });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// ─── Latest episodes (stream feed) ────────────────────────────────────────────

async function handleLatestV2(reqUrl, res) {
    try {
        const data = await senshiFetch('/episode-embeds/latest');
        const items = (Array.isArray(data) ? data : []).map(item => ({
            id      : item.anime?.public_id || String(item.mal_id),
            malId   : item.mal_id,
            title   : item.anime?.title_english || item.anime?.title || 'Anime',
            poster  : item.anime?.anime_picture ? `${SENSHI}${item.anime.anime_picture}` : '',
            episode : item.ep_id,
            epTitle : item.episode?.ep_title || `Episode ${item.ep_id}`,
            status  : item.status,
            type    : item.anime?.type || 'TV',
            aniStatus: item.anime?.ani_status || '',
            releaseDate: '',
            subOrDub: 'Sub',
            source  : 'senshi'
        }));
        sendJson(res, 200, { results: items });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// ─── Recent episodes ──────────────────────────────────────────────────────────

async function handleRecentEpisodes(reqUrl, res) {
    try {
        const [recentData, latestData, anilistPop] = await Promise.allSettled([
            senshiFetch('/anime/recently-added'),
            senshiFetch('/episode-embeds/latest'),
            anilistPopular(1),
        ]);

        const recent = recentData.status === 'fulfilled' && Array.isArray(recentData.value)
            ? recentData.value.map(normSenshiAnime) : [];
        const latest = latestData.status === 'fulfilled' && Array.isArray(latestData.value)
            ? latestData.value.map(item => ({
                id      : item.anime?.public_id || String(item.mal_id),
                malId   : item.mal_id,
                title   : item.anime?.title_english || item.anime?.title || 'Anime',
                poster  : item.anime?.anime_picture ? `${SENSHI}${item.anime.anime_picture}` : '',
                releaseDate: '',
                subOrDub: 'Sub',
                source  : 'senshi'
            })) : [];
        const anilist = anilistPop.status === 'fulfilled' ? anilistPop.value : [];

        const merged = dedupeByTitle([...recent, ...latest, ...anilist]);
        sendJson(res, 200, { results: merged });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// ─── Upcoming anime ───────────────────────────────────────────────────────────

async function handleUpcoming(reqUrl, res) {
    try {
        const [senshiUp, anilistTrend] = await Promise.allSettled([
            senshiFetch('/anime/upcoming'),
            anilistTrending(1)
        ]);

        const senshi = senshiUp.status === 'fulfilled' && Array.isArray(senshiUp.value)
            ? senshiUp.value.map(normSenshiAnime) : [];
        const anilist = anilistTrend.status === 'fulfilled' ? anilistTrend.value : [];

        const merged = dedupeByTitle([...senshi, ...anilist]);
        sendJson(res, 200, { results: merged });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// ─── Random anime ─────────────────────────────────────────────────────────────

async function handleRandomV2(reqUrl, res) {
    try {
        const anime = await senshiFetch('/anime/random');
        sendJson(res, 200, normSenshiAnime(anime));
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// ─── Senshi availability check (fast) ───────────────────────────────────────

const _senshiCheckCache = new Map();
async function senshiCheck(malId) {
    const sk = `sc::${malId}`;
    const cached = cacheGet(sk);
    if (cached !== null) return cached;
    try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 4000);
        const r = await fetch(`${SENSHI}/anime/${encodeURIComponent(malId)}`, {
            signal: c.signal,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        clearTimeout(t);
        const ok = r.ok;
        cacheSet(sk, ok);
        return ok;
    } catch { cacheSet(sk, false); return false; }
}

// ─── Similar anime by genre + year ────────────────────────────────────────────

async function handleSimilar(reqUrl, res) {
    try {
        const genres    = reqUrl.searchParams.get('genres') || '';
        const yearStart = reqUrl.searchParams.get('yearStart') || '';
        const yearEnd   = reqUrl.searchParams.get('yearEnd') || '';
        const ck = cacheKey('similar', genres, yearStart, yearEnd);
        const cached = cacheGet(ck);
        if (cached) return sendJson(res, 200, { results: cached });
        let results = await anilistAdvancedSearch('', 1, '', genres, yearStart, yearEnd);
        if (!results || !results.length) {
            results = await anilistGraphQLSearch('', 1, '', genres, yearEnd || '', '');
        }
        cacheSet(ck, results);
        sendJson(res, 200, { results });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// ─── Search: Anilist primary + availability check on senshi & animepulse ─────

async function handleSearch(reqUrl, res) {
    try {
        const queryParam = reqUrl.pathname.replace('/api/search/', '');
        const keyword = decodeURIComponent(queryParam);
        const page    = Math.max(1, parseInt(reqUrl.searchParams.get('page') || '1', 10));
        const genre   = reqUrl.searchParams.get('genre') || '';
        const year    = reqUrl.searchParams.get('year') || '';
        const season  = reqUrl.searchParams.get('season') || '';
        const format  = reqUrl.searchParams.get('format') || '';
        const sort    = reqUrl.searchParams.get('sort') || '';
        const status  = reqUrl.searchParams.get('status') || '';

        const sortMap = {
            'trending' : 'TRENDING_DESC',
            'score'    : 'SCORE_DESC',
            'popular'  : 'POPULARITY_DESC',
            'recent'   : 'START_DATE_DESC',
            'updated'  : 'UPDATED_AT_DESC'
        };
        const anilistSort = sortMap[sort.toLowerCase()] || '';

        // === Unified: Anilist-primary metadata + senshi/animepulse availability ===

        // 1. Search Anilist (accurate metadata, proper filtering)
        let anilistResults = [];
        try {
            anilistResults = await anilistMultiSearch(keyword, page, format, genre, year, season, anilistSort, status);
        } catch { /* anilist unreachable */ }

        // 2. Enrich with server availability (uses enrichWithServers)
        if (anilistResults.length) {
            const results = await enrichWithServers(anilistResults);
            if (results.length) {
                return sendJson(res, 200, { results, page, hasNext: results.length >= 50 });
            }
        }

        // 3. Fallback: senshi search, Anilist-enriched
        let senshiResults = [];
        try {
            const senshiData = await senshiPost('/anime/filter', { searchTerm: keyword, page, limit: 50 });
            senshiResults = (senshiData.data || []).slice(0, 20).map(normSenshiAnime);
        } catch { /* senshi unreachable */ }

        if (senshiResults.length) {
            const metaPromises = senshiResults.slice(0,10).map(s => anilistGraphQLSearch(s.title, 1, '', '', '', '', ''));
            const metaResults = await Promise.allSettled(metaPromises);
            const enriched = senshiResults.map((s, i) => {
                const meta = metaResults[i]?.value?.[0] || {};
                return {
                    id: s.id, malId: s.malId,
                    title: meta.title || s.title,
                    japaneseTitle: meta.japaneseTitle || s.japaneseTitle,
                    poster: meta.poster || s.poster,
                    backdrop: meta.backdrop || s.backdrop,
                    score: meta.score || s.score,
                    status: meta.status || s.status,
                    type: meta.type || s.type,
                    genres: meta.genres || s.genres,
                    episodes: meta.episodes || s.episodes,
                    overview: meta.overview || s.overview,
                    premiered: meta.premiered || s.premiered,
                    studios: meta.studios || s.studios,
                    source: 'senshi', servers: ['senshi']
                };
            });
            return sendJson(res, 200, { results: enriched, page, hasNext: enriched.length >= 50 });
        }

        // 4. Last resort: direct AnimePulse
        try {
            const apSearch = await animepulseFetch(`/search?query=${encodeURIComponent(keyword)}&page=${page}`);
            if (apSearch?.posts?.length) {
                const apDetails = await Promise.allSettled(
                    apSearch.posts.slice(0, 20).map(p => animepulseFetch(`/post?id=${p.id}`))
                );
                const apResults = [];
                for (const d of apDetails) {
                    if (d.status !== 'fulfilled' || !d.value) continue;
                    const post = normAnimepulsePost(d.value);
                    if (post.hasKyoto) {
                        apResults.push({
                            id: `animepulse:${post.id}`, animepulseId: post.id, malId: null,
                            title: post.title, japaneseTitle: post.title,
                            poster: post.poster, backdrop: post.poster,
                            score: post.score, status: post.status, type: post.type,
                            genres: post.genres, episodes: 0, overview: post.overview,
                            premiered: post.premiered, studios: '',
                            subOrDub: 'Sub', source: 'animepulse', servers: ['animepulse']
                        });
                    }
                }
                if (apResults.length) return sendJson(res, 200, { results: apResults, page, hasNext: apResults.length >= 20 });
            }
        } catch { /* animepulse unreachable */ }

        sendJson(res, 200, { results: [], page, hasNext: false });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// Multi-filter Anilist search (all params optional)
// Tries Consumet first, falls back to direct GraphQL
async function anilistMultiSearch(query, page = 1, format = '', genre = '', year = '', season = '', sort = '', status = '') {
    const ck = cacheKey('multisearch', query, page, format, genre, year, season, sort, status);
    const cached = cacheGet(ck);
    if (cached) return cached;
    let results = [];
    // Try Consumet first
    try {
        let url = `/advanced-search?page=${page}&perPage=50`;
        if (query)  url += `&query=${encodeURIComponent(query)}`;
        if (format) url += `&format=${encodeURIComponent(format)}`;
        if (genre)  url += `&genres=${encodeURIComponent(genre)}`;
        if (year)   url += `&year=${encodeURIComponent(year)}`;
        if (season) url += `&season=${encodeURIComponent(season)}`;
        if (sort)   url += `&sort=${encodeURIComponent(sort)}`;
        if (status) url += `&status=${encodeURIComponent(status)}`;
        const data = await anilistFetch(url);
        if (data?.results?.length) {
            results = data.results.map(normAnilistAnime);
        }
    } catch { /* consumet failed */ }

    // Fallback to direct GraphQL
    if (!results.length) {
        results = await anilistGraphQLSearch(query, page, format, genre, year, season, sort, status);
    }
    cacheSet(ck, results);
    return results;
}

// ─── Anilist enrichment: cast & nextAiringEpisode ──────────────────────────

async function handleAnilistEnrich(reqUrl, res) {
    try {
        const title = reqUrl.searchParams.get('title');
        if (!title) return sendJson(res, 200, {});
        const ck = cacheKey('enrich', title);
        const cached = cacheGet(ck);
        if (cached) return sendJson(res, 200, cached);
        const query = `
            query ($s: String) {
                Media(search: $s, type: ANIME) {
                    id
                    characters(page: 1, perPage: 8, sort: ROLE) {
                        edges {
                            role
                            node { name { full } image { medium } }
                            voiceActors(language: JAPANESE) {
                                name { full } image { medium }
                            }
                        }
                    }
                    nextAiringEpisode { airingAt timeUntilAiring episode }
                    studios { nodes { name isAnimationStudio } }
                }
            }`;
        const r = await fetch(ANILIST_GRAPHQL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables: { s: title } })
        });
        if (!r.ok) return sendJson(res, 200, {});
        const data = await r.json();
        const media = data?.data?.Media;
        if (!media) return sendJson(res, 200, {});
        const cast = (media.characters?.edges || []).map(edge => ({
            role: edge.role,
            name: edge.node.name.full,
            image: edge.node.image?.medium,
            va: edge.voiceActors?.[0] ? { name: edge.voiceActors[0].name.full, image: edge.voiceActors[0].image?.medium } : null
        }));
        const studios = (media.studios?.nodes || []).filter(s => s.isAnimationStudio).map(s => s.name);
        const payload = { cast, nextAiringEpisode: media.nextAiringEpisode || null, studios };
        cacheSet(ck, payload);
        sendJson(res, 200, payload);
    } catch { sendJson(res, 200, {}); }
}

// ─── Batch availability enrichment for Anilist results ─────────────────────
// Takes normAnilistAnime results, checks senshi by malId + animepulse by title,
// filters to only results available on ≥1 server, returns with servers[] array.

async function enrichWithServers(anilistResults) {
    if (!anilistResults?.length) return [];

    // Batch-check AnimePulse availability for all results
    const animepulseMap = await animepulseBatchCheck(anilistResults);

    return anilistResults.slice(0, 50).map(a => {
        const title = a.title || a.japaneseTitle || '';
        const key = normTitle(title);
        const animepulseId = animepulseMap.get(key) || null;
        const servers = animepulseId ? ['senshi', 'animepulse'] : ['senshi'];

        return {
            ...a,
            id: String(a.malId || a.id),
            servers,
            animepulseId,
            subEpCount: a.episodes || a.subEpCount || 0,
            dubEpCount: a.dubEpCount || 0,
            source: 'anilist'
        };
    });
}

// ─── Anilist discovery endpoints (trending, popular-season, upcoming, all-time) ─
// All use Anilist for metadata, filtered to only titles available on ≥1 server.

async function handleAnilistTrending(reqUrl, res) {
    try {
        const page = Math.max(1, parseInt(reqUrl.searchParams.get('page') || '1', 10));
        const ck = cacheKey('route-trending', String(page));
        let cached = cacheGet(ck);
        if (!cached) {
            let data = await anilistTrending(page);
            if (!data?.length) data = await anilistGraphQLTrending(page);
            cached = await enrichWithServers(data || []);
            if (cached.length) cacheSet(ck, cached);
        }
        sendJson(res, 200, { results: cached, hasNext: cached.length >= 50 });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}
async function handleAnilistPopularSeason(reqUrl, res) {
    try {
        const page = Math.max(1, parseInt(reqUrl.searchParams.get('page') || '1', 10));
        const ck = cacheKey('route-popseason', String(page));
        let cached = cacheGet(ck);
        if (!cached) {
            const now = new Date(); const m = now.getMonth() + 1; const y = now.getFullYear();
            const season = m <= 2 ? 'WINTER' : m <= 5 ? 'SPRING' : m <= 8 ? 'SUMMER' : 'FALL';
            let data = await anilistMultiSearch('', page, '', '', String(y), season, 'POPULARITY_DESC');
            if (!data?.length) data = await anilistGraphQLSearch('', page, '', '', String(y), season, 'POPULARITY_DESC');
            cached = await enrichWithServers(data || []);
            if (cached.length) cacheSet(ck, cached);
        }
        sendJson(res, 200, { results: cached, hasNext: cached.length >= 50 });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}
async function handleAnilistUpcoming(reqUrl, res) {
    try {
        const page = Math.max(1, parseInt(reqUrl.searchParams.get('page') || '1', 10));
        const ck = cacheKey('route-upcoming', String(page));
        let cached = cacheGet(ck);
        if (!cached) {
            const now = new Date(); const m = now.getMonth() + 1; const y = now.getFullYear();
            const nextSeasons = { WINTER:'SPRING', SPRING:'SUMMER', SUMMER:'FALL', FALL:'WINTER' };
            const curSea = m <= 2 ? 'WINTER' : m <= 5 ? 'SPRING' : m <= 8 ? 'SUMMER' : 'FALL';
            const nextSea = nextSeasons[curSea]; const nextY = curSea === 'FALL' ? y + 1 : y;
            let data = await anilistMultiSearch('', page, '', '', String(nextY), nextSea, 'POPULARITY_DESC');
            if (!data?.length) data = await anilistGraphQLSearch('', page, '', '', String(nextY), nextSea, 'POPULARITY_DESC');
            cached = await enrichWithServers(data || []);
            if (cached.length) cacheSet(ck, cached);
        }
        sendJson(res, 200, { results: cached, hasNext: cached.length >= 50 });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}
async function handleAnilistPopularAlltime(reqUrl, res) {
    try {
        const page = Math.max(1, parseInt(reqUrl.searchParams.get('page') || '1', 10));
        const ck = cacheKey('route-popalltime', String(page));
        let cached = cacheGet(ck);
        if (!cached) {
            let data = await anilistPopular(page);
            if (!data?.length) data = await anilistGraphQLPopular(page);
            cached = await enrichWithServers(data || []);
            if (cached.length) cacheSet(ck, cached);
        }
        sendJson(res, 200, { results: cached, hasNext: cached.length >= 50 });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
}

// ─── Anilist schedule (weekly calendar) ────────────────────────────────────
async function handleAnilistSchedule(reqUrl, res) {
    try {
        const page = Math.max(1, parseInt(reqUrl.searchParams.get('page') || '1', 10));
        const ck = cacheKey('route-schedule', String(page));
        const cached = cacheGet(ck);
        if (cached) return sendJson(res, 200, cached);
        const query = `
            query ($page: Int, $perPage: Int) {
                Page(page: $page, perPage: $perPage) {
                    airingSchedules(notYetAired: true, sort: TIME) {
                        id
                        airingAt
                        timeUntilAiring
                        episode
                        media {
                            id
                            idMal
                            title { romaji english }
                            coverImage { medium }
                            format
                            status
                            nextAiringEpisode { airingAt timeUntilAiring episode }
                        }
                    }
                }
            }`;
        const r = await fetch(ANILIST_GRAPHQL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables: { page, perPage: 50 } })
        });
        if (!r.ok) return sendJson(res, 200, { results: [] });
        const data = await r.json();
        const schedules = data?.data?.Page?.airingSchedules || [];
        // Group by day of week
        const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const grouped = {};
        for (const s of schedules) {
            const d = new Date(s.airingAt * 1000);
            const dayName = days[d.getDay()];
            if (!grouped[dayName]) grouped[dayName] = [];
            grouped[dayName].push({
                id: s.media.id,
                malId: s.media.idMal,
                title: s.media.title?.english || s.media.title?.romaji || 'Unknown',
                poster: s.media.coverImage?.medium || '',
                episode: s.episode,
                airingAt: s.airingAt,
                timeUntilAiring: s.timeUntilAiring,
                format: s.media.format || 'TV',
                status: s.media.status || 'Unknown'
            });
        }
        // Include all schedule items (server availability checked on detail page)
        const payload = { grouped, hasNext: schedules.length >= 50 };
        cacheSet(ck, payload);
        sendJson(res, 200, payload);
    } catch (err) { sendJson(res, 200, { results: [], grouped: {} }); }
}

// ─── Auth handlers ────────────────────────────────────────────────────────────

async function handleRegister(req, reqUrl, res) {
    try {
        const body = JSON.parse(await readBody(req));
        const { username, email, password } = body || {};
        const cors = corsForOrigin(req);

        // Validation
        if (!username || !email || !password) {
            return sendJson(res, 400, { error: 'Username, email, and password are required.' }, cors);
        }
        if (username.length < 3 || username.length > 50) {
            return sendJson(res, 400, { error: 'Username must be 3–50 characters.' }, cors);
        }
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return sendJson(res, 400, { error: 'Username can only contain letters, numbers, and underscores.' }, cors);
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return sendJson(res, 400, { error: 'Invalid email address.' }, cors);
        }
        if (password.length < 6) {
            return sendJson(res, 400, { error: 'Password must be at least 6 characters.' }, cors);
        }

        if (!supabase) {
            return sendJson(res, 500, { error: 'Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' }, cors);
        }

        // Check existing user
        const { data: existing } = await supabase
            .from('users')
            .select('id')
            .or(`email.eq.${email},username.eq.${username}`)
            .maybeSingle();

        if (existing) {
            return sendJson(res, 409, { error: 'A user with this email or username already exists.' }, cors);
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const { data: user, error: insertErr } = await supabase
            .from('users')
            .insert({ username, email, password_hash: passwordHash })
            .select('id, username, email')
            .single();

        if (insertErr || !user) {
            console.error('Register insert error:', insertErr);
            return sendJson(res, 500, { error: 'Failed to create account.' }, cors);
        }

        const token = signToken({ userId: user.id, username: user.username });
        res.setHeader('Set-Cookie', setCookieHeader(COOKIE_NAME, token, JWT_MAX_AGE));
        sendJson(res, 201, { user: { id: user.id, username: user.username, email: user.email } }, cors);
    } catch (err) {
        console.error('Register error:', err);
        sendJson(res, 500, { error: 'Internal server error.' }, corsForOrigin(req));
    }
}

async function handleLogin(req, reqUrl, res) {
    try {
        const body = JSON.parse(await readBody(req));
        const { email, password } = body || {};
        const cors = corsForOrigin(req);

        if (!email || !password) {
            return sendJson(res, 400, { error: 'Email and password are required.' }, cors);
        }

        if (!supabase) {
            return sendJson(res, 500, { error: 'Database not configured.' }, cors);
        }

        const { data: user, error: findErr } = await supabase
            .from('users')
            .select('id, username, email, password_hash')
            .eq('email', email)
            .maybeSingle();

        if (findErr || !user) {
            return sendJson(res, 401, { error: 'Invalid email or password.' }, cors);
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return sendJson(res, 401, { error: 'Invalid email or password.' }, cors);
        }

        const token = signToken({ userId: user.id, username: user.username });
        res.setHeader('Set-Cookie', setCookieHeader(COOKIE_NAME, token, JWT_MAX_AGE));
        sendJson(res, 200, { user: { id: user.id, username: user.username, email: user.email } }, cors);
    } catch (err) {
        console.error('Login error:', err);
        sendJson(res, 500, { error: 'Internal server error.' }, corsForOrigin(req));
    }
}

function handleLogout(req, reqUrl, res) {
    const cors = corsForOrigin(req);
    clearCookie(res, COOKIE_NAME);
    sendJson(res, 200, { message: 'Logged out.' }, cors);
}

async function handleMe(req, reqUrl, res) {
    const cors = corsForOrigin(req);
    const authUser = getAuthUser(req);
    if (!authUser) {
        return sendJson(res, 401, { user: null }, cors);
    }

    if (!supabase) {
        return sendJson(res, 200, { user: { id: authUser.userId, username: authUser.username } }, cors);
    }

    const { data: user } = await supabase
        .from('users')
        .select('id, username, email')
        .eq('id', authUser.userId)
        .maybeSingle();

    sendJson(res, 200, { user: user || { id: authUser.userId, username: authUser.username } }, cors);
}

// Helper to build Set-Cookie header value string
function setCookieHeader(name, value, maxAgeSeconds) {
    const isProd = process.env.NODE_ENV === 'production';
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        `HttpOnly`,
        `Path=/`,
        `SameSite=${isProd ? 'None' : 'Lax'}`,
        `Max-Age=${maxAgeSeconds}`
    ];
    if (isProd) parts.push('Secure');
    return parts.join('; ');
}

// ─── Comment handlers ─────────────────────────────────────────────────────────

async function handleGetComments(req, reqUrl, res) {
    const cors = corsForOrigin(req);
    const authUser = getAuthUser(req);
    const match = reqUrl.pathname.match(/^\/api\/anime\/([^/]+)\/episodes\/([^/]+)\/comments$/);
    if (!match) return sendJson(res, 400, { error: 'Invalid path.' }, cors);
    const animeId = decodeURIComponent(match[1]);
    const episodeNumber = decodeURIComponent(match[2]);

    if (!supabase) {
        return sendJson(res, 200, { comments: [] }, cors);
    }

    try {
        const { data: comments, error } = await supabase
            .from('episode_comments')
            .select('id, anime_id, episode_number, content, created_at, user_id, parent_id, users ( username )')
            .eq('anime_id', animeId)
            .eq('episode_number', episodeNumber)
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) {
            console.error('Get comments error:', error);
            return sendJson(res, 200, { comments: [] }, cors);
        }

        // Fetch all likes for these comments
        const commentIds = (comments || []).map(c => c.id);
        let likesMap = {};
        if (commentIds.length > 0) {
            const { data: likes } = await supabase
                .from('comment_likes')
                .select('comment_id, is_like, user_id')
                .in('comment_id', commentIds);
            if (likes) {
                likes.forEach(l => {
                    if (!likesMap[l.comment_id]) likesMap[l.comment_id] = { likes: 0, dislikes: 0, userVote: null };
                    if (l.is_like) likesMap[l.comment_id].likes++;
                    else likesMap[l.comment_id].dislikes++;
                    if (authUser && l.user_id === authUser.userId) {
                        likesMap[l.comment_id].userVote = l.is_like;
                    }
                });
            }
        }

        const mapped = (comments || []).map(c => {
            const l = likesMap[c.id] || { likes: 0, dislikes: 0, userVote: null };
            return {
                id: c.id,
                anime_id: c.anime_id,
                episode_number: c.episode_number,
                content: c.content,
                created_at: c.created_at,
                parent_id: c.parent_id,
                user: {
                    id: c.user_id,
                    username: c.users?.username || 'unknown'
                },
                likes: l.likes,
                dislikes: l.dislikes,
                userVote: l.userVote
            };
        });

        // Separate parents and replies
        const parents = mapped.filter(c => !c.parent_id);
        const replies = mapped.filter(c => c.parent_id);
        // Attach replies to parents (sorted ascending)
        parents.forEach(p => {
            p.replies = replies.filter(r => r.parent_id === p.id)
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        });

        sendJson(res, 200, { comments: parents }, cors);
    } catch (err) {
        console.error('Get comments error:', err);
        sendJson(res, 200, { comments: [] }, cors);
    }
}

async function handlePostComment(req, reqUrl, res) {
    const cors = corsForOrigin(req);
    const authUser = getAuthUser(req);
    if (!authUser) {
        return sendJson(res, 401, { error: 'You must be logged in to comment.' }, cors);
    }

    const match = reqUrl.pathname.match(/^\/api\/anime\/([^/]+)\/episodes\/([^/]+)\/comments$/);
    if (!match) return sendJson(res, 400, { error: 'Invalid path.' }, cors);
    const animeId = decodeURIComponent(match[1]);
    const episodeNumber = decodeURIComponent(match[2]);

    try {
        const body = JSON.parse(await readBody(req));
        const { content } = body || {};

        if (!content || !content.trim()) {
            return sendJson(res, 400, { error: 'Comment cannot be empty.' }, cors);
        }
        if (content.length > 2000) {
            return sendJson(res, 400, { error: 'Comment must be under 2000 characters.' }, cors);
        }

        if (!supabase) {
            return sendJson(res, 500, { error: 'Database not configured.' }, cors);
        }

        const { parent_id } = body;
        const insertData = {
            user_id: authUser.userId,
            anime_id: animeId,
            episode_number: episodeNumber,
            content: content.trim()
        };
        if (parent_id) insertData.parent_id = parent_id;

        const { data: comment, error: insertErr } = await supabase
            .from('episode_comments')
            .insert(insertData)
            .select('id, anime_id, episode_number, content, created_at, user_id, parent_id')
            .single();

        if (insertErr || !comment) {
            console.error('Post comment error:', insertErr);
            return sendJson(res, 500, { error: 'Failed to post comment.' }, cors);
        }

        sendJson(res, 201, {
            comment: {
                id: comment.id,
                anime_id: comment.anime_id,
                episode_number: comment.episode_number,
                content: comment.content,
                created_at: comment.created_at,
                parent_id: comment.parent_id,
                user: { id: authUser.userId, username: authUser.username }
            }
        }, cors);
    } catch (err) {
        console.error('Post comment error:', err);
        sendJson(res, 500, { error: 'Internal server error.' }, corsForOrigin(req));
    }
}

// ─── Watch progress handlers ──────────────────────────────────────────────────

async function handleGetWatchProgress(req, res) {
    const cors = corsForOrigin(req);
    const authUser = getAuthUser(req);
    if (!authUser) return sendJson(res, 200, { progress: [] }, cors);
    if (!supabase) return sendJson(res, 200, { progress: [] }, cors);

    try {
        const { data, error } = await supabase
            .from('watch_progress')
            .select('anime_id, mal_id, title, poster, episode_number, updated_at')
            .eq('user_id', authUser.userId)
            .order('updated_at', { ascending: false })
            .limit(20);
        if (error) return sendJson(res, 200, { progress: [] }, cors);
        sendJson(res, 200, { progress: data || [] }, cors);
    } catch { sendJson(res, 200, { progress: [] }, cors); }
}

async function handleSaveWatchProgress(req, res) {
    const cors = corsForOrigin(req);
    const authUser = getAuthUser(req);
    if (!authUser) return sendJson(res, 401, { error: 'Not logged in.' }, cors);
    if (!supabase) return sendJson(res, 500, { error: 'Database not configured.' }, cors);

    try {
        const body = JSON.parse(await readBody(req));
        const { anime_id, mal_id, title, poster, episode_number } = body || {};
        if (!anime_id || !title || !episode_number) {
            return sendJson(res, 400, { error: 'Missing required fields.' }, cors);
        }

        await supabase.from('watch_progress').upsert({
            user_id: authUser.userId,
            anime_id,
            mal_id: mal_id || null,
            title,
            poster: poster || null,
            episode_number: String(episode_number),
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,anime_id' });

        sendJson(res, 200, { ok: true }, cors);
    } catch (err) {
        console.error('Save progress error:', err);
        sendJson(res, 500, { error: 'Internal server error.' }, cors);
    }
}

// ─── Like/dislike handler ─────────────────────────────────────────────────────

async function handleLikeComment(req, reqUrl, res) {
    const cors = corsForOrigin(req);
    const authUser = getAuthUser(req);
    if (!authUser) return sendJson(res, 401, { error: 'You must be logged in.' }, cors);

    const match = reqUrl.pathname.match(/^\/api\/anime\/([^/]+)\/episodes\/([^/]+)\/comments\/([^/]+)\/like$/);
    if (!match) return sendJson(res, 400, { error: 'Invalid path.' }, cors);
    const commentId = match[3];

    if (!supabase) return sendJson(res, 500, { error: 'Database not configured.' }, cors);

    try {
        if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const is_like = body?.is_like;
            if (typeof is_like !== 'boolean') return sendJson(res, 400, { error: 'is_like must be boolean.' }, cors);

            // Upsert — if same user votes again, toggle
            const { data: existing } = await supabase
                .from('comment_likes')
                .select('id, is_like')
                .eq('comment_id', commentId)
                .eq('user_id', authUser.userId)
                .maybeSingle();

            if (existing) {
                if (existing.is_like === is_like) {
                    // Same vote → remove (toggle off)
                    await supabase.from('comment_likes').delete().eq('id', existing.id);
                    return sendJson(res, 200, { action: 'removed' }, cors);
                }
                // Different vote → update
                await supabase.from('comment_likes').update({ is_like }).eq('id', existing.id);
                return sendJson(res, 200, { action: 'updated' }, cors);
            }

            await supabase.from('comment_likes').insert({
                comment_id: commentId,
                user_id: authUser.userId,
                is_like
            });
            return sendJson(res, 201, { action: 'created' }, cors);
        }

        if (req.method === 'DELETE') {
            await supabase.from('comment_likes').delete()
                .eq('comment_id', commentId)
                .eq('user_id', authUser.userId);
            return sendJson(res, 200, { action: 'removed' }, cors);
        }

        send(res, 405, 'Method Not Allowed');
    } catch (err) {
        console.error('Like error:', err);
        sendJson(res, 500, { error: 'Internal server error.' }, cors);
    }
}

// ─── Media proxy (CORS bypass for m3u8 / segments) ───────────────────────────

async function handleMedia(req, reqUrl, res) {
    const targetUrl = reqUrl.searchParams.get('url');
    const headers   = decodeHeaders(reqUrl.searchParams.get('headers'));
    if (!targetUrl) return send(res, 400, 'Missing url');
    try {
        const upHeaders = safeHeaders({ ...headers, range: req.headers.range });
        const upstream  = await fetch(targetUrl, { headers: upHeaders, redirect: 'follow' });
        const ct        = upstream.headers.get('content-type') || '';
        if (ct.includes('mpegurl') || /\.m3u8(?:$|\?)/i.test(targetUrl)) {
            const txt = await upstream.text();
            return send(res, upstream.status, rewritePlaylist(txt, targetUrl, headers),
                { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' });
        }
        res.writeHead(upstream.status, {
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges' : upstream.headers.get('accept-ranges') || 'bytes',
            'Content-Type'  : ct || 'application/octet-stream',
            ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length') } : {}),
            ...(upstream.headers.get('content-range')  ? { 'Content-Range' : upstream.headers.get('content-range')  } : {})
        });
        if (upstream.body) {
            const reader = upstream.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
            }
        }
        res.end();
    } catch (err) { send(res, 502, err.message); }
}

// ─── Image proxy (for Senshi poster images) ──────────────────────────────────

async function handleImageProxy(req, reqUrl, res) {
    const imgPath = reqUrl.pathname.replace('/api/image', '');
    if (!imgPath) return send(res, 400, 'Missing path');
    try {
        const upstream = await fetch(`${SENSHI}${imgPath}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (!upstream.ok) return send(res, upstream.status, 'Image not found');
        const ct = upstream.headers.get('content-type') || 'image/webp';
        res.writeHead(upstream.status, {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': ct,
            'Cache-Control': 'public, max-age=86400',
            ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length') } : {})
        });
        if (upstream.body) {
            const reader = upstream.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
            }
        }
        res.end();
    } catch (err) { send(res, 502, err.message); }
}

// ─── Static file server ──────────────────────────────────────────────────────

function serveStatic(reqUrl, res) {
    try {
        const pathname = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
        // SPA fallback: any path without a file extension serves index.html
        if (!path.extname(pathname) && pathname !== '/favicon.ico') {
            return fs.readFile(path.join(ROOT, 'index.html'), (ie, id) => {
                if (ie) return send(res, 404, 'Not found');
                send(res, 200, id, { 'Content-Type': MIME['.html'] });
            });
        }
        const filePath = path.resolve(ROOT, `.${decodeURIComponent(pathname)}`);
        if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');
        fs.readFile(filePath, (err, data) => {
            if (err) return send(res, 404, 'Not found');
            send(res, 200, data, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        });
    } catch { serveFallbackHtml(res); }
}
function serveFallbackHtml(res) {
    fs.readFile(path.join(ROOT, 'index.html'), (ie, id) => {
        if (ie) return send(res, 404, 'Not found');
        send(res, 200, id, { 'Content-Type': MIME['.html'] });
    });
}

// ─── Main router ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        const cors = corsForOrigin(req);
        res.writeHead(204, {
            ...cors,
            'Access-Control-Allow-Headers': 'Content-Type, Range, Cookie',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        });
        return res.end();
    }
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);

    if (reqUrl.pathname === '/favicon.ico') {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#050507"/><path d="M32 8 52 18v28L32 56 12 46V18L32 8Z" fill="#9333ea"/><path d="M32 18 44 24v16l-12 6-12-6V24l12-6Z" fill="#050507"/><circle cx="32" cy="32" r="6" fill="#9333ea"/></svg>`;
        return send(res, 200, svg, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
    }

    // API routes
    if (reqUrl.pathname === '/api/browse')              return handleBrowse(reqUrl, res);
    if (reqUrl.pathname === '/api/detail')              return handleDetail(reqUrl, res);
    if (reqUrl.pathname === '/api/stream')              return handleStream(reqUrl, res);
    if (reqUrl.pathname === '/api/schedule')            return handleSchedule(reqUrl, res);

    // New WEBSITE endpoints (replace old singles)
    if (reqUrl.pathname === '/api/sliders')             return handleSlidersV2(reqUrl, res);
    if (reqUrl.pathname === '/api/trending')            return handleTrendingV2(reqUrl, res);
    if (reqUrl.pathname === '/api/top-airing')          return handleTopAiring(reqUrl, res);
    if (reqUrl.pathname === '/api/latest')              return handleLatestV2(reqUrl, res);
    if (reqUrl.pathname === '/api/recent-episodes')     return handleRecentEpisodes(reqUrl, res);
    if (reqUrl.pathname === '/api/upcoming')            return handleUpcoming(reqUrl, res);
    if (reqUrl.pathname === '/api/random')              return handleRandomV2(reqUrl, res);
    if (reqUrl.pathname.startsWith('/api/search/'))     return handleSearch(reqUrl, res);
    if (reqUrl.pathname === '/api/similar')             return handleSimilar(reqUrl, res);

    // Debug endpoint
    if (reqUrl.pathname === '/api/debug') {
        const id = reqUrl.searchParams.get('id');
        console.error(`[debug] id param = ${JSON.stringify(id)}`);
        const data = await animepulseFetch(`/post?id=${id}`);
        return sendJson(res, 200, { receivedId: id, animepulseData: data ? 'ok' : 'null' });
    }

    // Anilist discovery & enrichment
    if (reqUrl.pathname === '/api/anilist/trending')       return handleAnilistTrending(reqUrl, res);
    if (reqUrl.pathname === '/api/anilist/popular-season') return handleAnilistPopularSeason(reqUrl, res);
    if (reqUrl.pathname === '/api/anilist/upcoming')       return handleAnilistUpcoming(reqUrl, res);
    if (reqUrl.pathname === '/api/anilist/popular-alltime') return handleAnilistPopularAlltime(reqUrl, res);
    if (reqUrl.pathname === '/api/anilist/enrich')          return handleAnilistEnrich(reqUrl, res);
    if (reqUrl.pathname === '/api/anilist/schedule')        return handleAnilistSchedule(reqUrl, res);

    if (reqUrl.pathname === '/api/media')               return handleMedia(req, reqUrl, res);
    if (reqUrl.pathname.startsWith('/api/image/'))      return handleImageProxy(req, reqUrl, res);

    // Auth routes
    if (reqUrl.pathname === '/api/auth/register') {
        if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');
        return handleRegister(req, reqUrl, res);
    }
    if (reqUrl.pathname === '/api/auth/login') {
        if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');
        return handleLogin(req, reqUrl, res);
    }
    if (reqUrl.pathname === '/api/auth/logout') {
        if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');
        return handleLogout(req, reqUrl, res);
    }
    if (reqUrl.pathname === '/api/auth/me') {
        if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed');
        return handleMe(req, reqUrl, res);
    }

    // Watch progress routes
    if (reqUrl.pathname === '/api/watch-progress') {
        if (req.method === 'GET')  return handleGetWatchProgress(req, res);
        if (req.method === 'POST') return handleSaveWatchProgress(req, res);
        return send(res, 405, 'Method Not Allowed');
    }

    // Comments routes
    const commentsMatch = reqUrl.pathname.match(/^\/api\/anime\/([^/]+)\/episodes\/([^/]+)\/comments$/);
    if (commentsMatch) {
        if (req.method === 'GET')  return handleGetComments(req, reqUrl, res);
        if (req.method === 'POST') return handlePostComment(req, reqUrl, res);
        return send(res, 405, 'Method Not Allowed');
    }

    // Like route (more specific pattern)
    const likeMatch = reqUrl.pathname.match(/^\/api\/anime\/([^/]+)\/episodes\/([^/]+)\/comments\/([^/]+)\/like$/);
    if (likeMatch) {
        return handleLikeComment(req, reqUrl, res);
    }

    return serveStatic(reqUrl, res);
});

server.listen(PORT, HOST, () => console.log(`AniView → http://${HOST}:${PORT}/`));