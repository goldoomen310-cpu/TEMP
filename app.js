/**
 * AnimePulse — client logic
 * Source: Senshi.live API via /api/*
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const API_BASE = window.API_BASE || '/api';

// ─── Popunder ad config (random, max 2 per minute) ────────────────────────────
const AD_URL = 'https://work.ink/direct/3334';
let _adTimestamps = [];
document.addEventListener('click', function(){
  const now = Date.now();
  _adTimestamps = _adTimestamps.filter(t => now - t < 60000);
  if (_adTimestamps.length >= 2) return;
  if (Math.random() < 0.08) {
    _adTimestamps.push(now);
    window.open(AD_URL, '_blank');
  }
});

// ─── State ────────────────────────────────────────────────────────────────────
let currentUser            = null;
let currentTab            = 'home';
let currentTrendingPage   = 1;
let currentTrendingFilter = 'trending';
let currentSearchPage     = 1;
let currentAnimeId        = null;
let currentMalId          = null;
let currentAnimeDetail    = null;
let currentEpisodes       = [];
let currentEpisodeIndex   = 0;
let currentLang           = 'sub';
let currentServer         = 'senshi';
let currentServersAvail   = ['senshi'];
let activeHls             = null;
let activeVideo           = null;
let currentSkipSegments   = [];
let skippedSegmentKeys    = new Set();
let lastDetailPageId      = null;
let currentEnrichData     = null;
let currentAnimepulseId   = null;
let pendingSeekTime       = -1;

const defaultPlayerSettings = { autoSkip: true, autoNext: true, autoPlay: true };
let playerSettings = (() => {
    try { return { ...defaultPlayerSettings, ...JSON.parse(localStorage.getItem('animepulseSettings') || '{}') }; }
    catch { return { ...defaultPlayerSettings }; }
})();

const animeDetailCache = new Map();
const loadingOverlay   = document.getElementById('loadingOverlay');
let loadingTimeout     = null;

let loadingTimer = null;
const showLoading = () => {
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => { loadingOverlay.style.display = 'flex'; clearTimeout(loadingTimeout); loadingTimeout = setTimeout(() => { loadingOverlay.style.display = 'none'; }, 12000); }, 400);
};
const hideLoading = () => {
    clearTimeout(loadingTimer);
    loadingOverlay.style.display = 'none';
    clearTimeout(loadingTimeout);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function clean(v, fb = '') {
    const t = String(v ?? '').trim();
    return t && !/^(unknown|n\/a|0|\?)$/i.test(t) ? t : fb;
}
function slugify(v) {
    return String(v||'anime').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'anime';
}
function splitList(v) {
    return String(v||'').split(/\s*[-•]\s*/g).map(s => s.trim()).filter(Boolean);
}
function normStatus(s) {
    s = String(s || '');
    if (/releasing|airing|ongoing|hiatus/i.test(s)) return 'Ongoing';
    if (/finished|completed|cancelled/i.test(s))    return 'Completed';
    if (/not.yet|upcoming/i.test(s))               return 'Not Yet Aired';
    return s || 'Unknown';
}
function fmtTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}
function setRoute(p) { if (location.pathname !== p) history.pushState({},''  ,p); }
function saveSettings() { localStorage.setItem('animepulseSettings', JSON.stringify(playerSettings)); }

function posterFallbackDataUri(title = 'AniView') {
    const safe = String(title || 'AniView').trim().slice(0, 28) || 'AniView';
    const initials = safe.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || 'AP';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 280">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ff2a5f"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect width="200" height="280" rx="20" fill="#141822"/>
  <rect width="200" height="280" rx="20" fill="url(#g)" opacity="0.14"/>
  <text x="100" y="126" text-anchor="middle" fill="#e2e8f0" font-size="42" font-weight="800" font-family="Inter,Arial,sans-serif">${initials}</text>
  <text x="100" y="172" text-anchor="middle" fill="#94a3b8" font-size="13" font-weight="600" font-family="Inter,Arial,sans-serif">${safe.replace(/[&<>]/g,'')}</text>
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function posterSrc(url, title) {
    const v = String(url || '').trim();
    return v ? v : posterFallbackDataUri(title);
}
function displayTitle(anime) {
    return anime?.title || anime?.name || anime?.japaneseTitle || anime?.englishTitle || anime?.id || 'Anime';
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
    const res  = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = JSON.parse(text).error || msg; } catch { /* ignore */ }
        throw new Error(msg);
    }
    try { return JSON.parse(text); } catch { return text; }
}

async function authFetch(url, opts = {}) {
    return apiFetch(url, { ...opts, credentials: 'include' });
}

function updateAuthUI() {
    const btn = document.getElementById('authBtn');
    const label = document.getElementById('authBtnLabel');
    const userMenu = document.getElementById('userMenu');
    const nameEl = document.getElementById('userMenuName');
    const emailEl = document.getElementById('userMenuEmail');
    if (currentUser) {
        if (label) label.textContent = currentUser.username;
        if (btn) btn.classList.add('logged-in');
        if (userMenu) {
            if (nameEl) nameEl.textContent = currentUser.username;
            if (emailEl) emailEl.textContent = currentUser.email || '';
            userMenu.style.display = 'block';
        }
    } else {
        if (label) label.textContent = 'Sign In';
        if (btn) btn.classList.remove('logged-in');
        if (userMenu) userMenu.style.display = 'none';
    }
    const p = location.pathname;
    if (!p || p === '/' || p.startsWith('/home')) renderContinueWatching();
}

async function checkAuth() {
    try {
        const data = await authFetch(`${API_BASE}/auth/me`);
        currentUser = data?.user || null;
    } catch {
        currentUser = null;
    }
    updateAuthUI();
    const p = location.pathname;
    if (!p || p === '/' || p.startsWith('/home')) renderContinueWatching();
}

let authMode = 'login';
function openAuthModal() {
    if (currentUser) return;
    authMode = 'login';
    document.getElementById('authModal')?.classList.add('active');
    document.body.style.overflow = 'hidden';
    updateAuthForm();
}
function closeAuthModal() {
    document.getElementById('authModal')?.classList.remove('active');
    document.getElementById('authError').style.display = 'none';
    document.body.style.overflow = '';
}
function toggleAuthMode() {
    authMode = authMode === 'login' ? 'register' : 'login';
    updateAuthForm();
}
function updateAuthForm() {
    const title = document.getElementById('authModalTitle');
    const submit = document.getElementById('authSubmitBtn');
    const switchText = document.getElementById('authSwitchText');
    const switchBtn = document.getElementById('authSwitchBtn');
    const usernameField = document.getElementById('authUsername').parentElement;
    const error = document.getElementById('authError');
    error.style.display = 'none';
    if (authMode === 'login') {
        if (title) title.textContent = 'Sign In';
        if (submit) submit.textContent = 'Sign In';
        if (switchText) switchText.textContent = "Don't have an account?";
        if (switchBtn) switchBtn.textContent = 'Sign Up';
        usernameField.style.display = 'none';
        document.getElementById('authUsername').removeAttribute('required');
    } else {
        if (title) title.textContent = 'Sign Up';
        if (submit) submit.textContent = 'Create Account';
        if (switchText) switchText.textContent = 'Already have an account?';
        if (switchBtn) switchBtn.textContent = 'Sign In';
        usernameField.style.display = '';
        document.getElementById('authUsername').setAttribute('required', '');
    }
}
async function handleRegister() {
    const username = document.getElementById('authUsername').value.trim();
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const error = document.getElementById('authError');
    error.style.display = 'none';
    if (!username || !email || !password) {
        error.textContent = 'All fields are required.';
        error.style.display = 'block';
        return;
    }
    if (username.length < 3) {
        error.textContent = 'Username must be at least 3 characters.';
        error.style.display = 'block';
        return;
    }
    if (password.length < 6) {
        error.textContent = 'Password must be at least 6 characters.';
        error.style.display = 'block';
        return;
    }
    try {
        const data = await authFetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });
        currentUser = data.user;
        updateAuthUI();
        closeAuthModal();
    } catch (err) {
        error.textContent = err.message;
        error.style.display = 'block';
    }
}
async function handleLogin() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const error = document.getElementById('authError');
    error.style.display = 'none';
    if (!email || !password) {
        error.textContent = 'Email and password are required.';
        error.style.display = 'block';
        return;
    }
    try {
        const data = await authFetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        currentUser = data.user;
        updateAuthUI();
        closeAuthModal();
    } catch (err) {
        error.textContent = err.message;
        error.style.display = 'block';
    }
}
async function handleLogout() {
    try {
        await authFetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    } catch { /* ignore */ }
    currentUser = null;
    updateAuthUI();
    document.getElementById('userMenu').style.display = 'none';
}

// Handle auth form submit
document.addEventListener('submit', e => {
    if (e.target.id === 'authForm') {
        e.preventDefault();
        if (authMode === 'login') handleLogin();
        else handleRegister();
    }
});

// ─── Comments ─────────────────────────────────────────────────────────────────
async function fetchComments(animeId, episodeNumber) {
    try {
        const data = await authFetch(
            `${API_BASE}/anime/${encodeURIComponent(animeId)}/episodes/${encodeURIComponent(episodeNumber)}/comments`
        );
        renderComments(data?.comments || []);
    } catch {
        renderComments([]);
    }
}

function renderComments(comments) {
    const section = document.getElementById('watchCommentsSection');
    const container = document.getElementById('commentsContainer');
    const form = document.getElementById('commentsForm');
    if (!section || !container) return;

    if (!comments || !comments.length) {
        container.innerHTML = currentUser
            ? '<div class="comments-empty">No comments yet. Be the first to post!</div>'
            : '<div class="comments-empty">No comments yet. <button class="comments-signin-btn" onclick="openAuthModal()">Sign in</button> to post one.</div>';
    } else {
        container.innerHTML = comments.map(c => renderCommentItem(c, false)).join('');
    }

    if (form) {
        form.style.display = currentUser ? '' : 'none';
    }
    section.style.display = '';
}

function renderCommentItem(c, isReply) {
    const voteClass = c.userVote === null ? '' : (c.userVote ? ' voted-up' : ' voted-down');
    return `<div class="comment-item${isReply ? ' comment-reply' : ''}">
        <div class="comment-avatar">${esc((c.user?.username || '?')[0].toUpperCase())}</div>
        <div class="comment-body">
            <div class="comment-header">
                <span class="comment-username">${esc(c.user?.username || 'Anonymous')}</span>
                <span class="comment-time">${fmtCommentTime(c.created_at)}</span>
            </div>
            <div class="comment-text">${esc(c.content)}</div>
            <div class="comment-actions">
                <button class="comment-action-btn${c.userVote === true ? ' active' : ''}" onclick="handleVote('${c.id}', true)" title="Like">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="${c.userVote === true ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
                    <span>${c.likes || 0}</span>
                </button>
                <button class="comment-action-btn${c.userVote === false ? ' active' : ''}" onclick="handleVote('${c.id}', false)" title="Dislike">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="${c.userVote === false ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zM17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg>
                    <span>${c.dislikes || 0}</span>
                </button>
                <button class="comment-action-btn" onclick="toggleReply('${c.id}')" title="Reply">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    <span>Reply</span>
                </button>
            </div>
            <div class="reply-form" id="replyForm-${c.id}" style="display:none">
                <textarea class="comments-textarea reply-textarea" rows="2" placeholder="Write a reply…" maxlength="2000"></textarea>
                <div class="reply-form-actions">
                    <button class="btn btn-primary btn-sm" onclick="postReply('${c.id}')">Reply</button>
                    <button class="btn btn-sm" onclick="cancelReply('${c.id}')">Cancel</button>
                </div>
            </div>
            ${c.replies && c.replies.length ? c.replies.map(r => renderCommentItem(r, true)).join('') : ''}
        </div>
    </div>`;
}

function toggleReply(commentId) {
    if (!currentUser) { openAuthModal(); return; }
    const form = document.getElementById('replyForm-' + commentId);
    if (!form) return;
    const shown = form.style.display !== 'none';
    form.style.display = shown ? 'none' : 'flex';
    if (!shown) form.querySelector('textarea')?.focus();
}

function cancelReply(commentId) {
    const form = document.getElementById('replyForm-' + commentId);
    if (form) { form.style.display = 'none'; form.querySelector('textarea').value = ''; }
}

async function postReply(commentId) {
    if (!currentUser) { openAuthModal(); return; }
    const form = document.getElementById('replyForm-' + commentId);
    if (!form) return;
    const input = form.querySelector('textarea');
    const content = input?.value?.trim();
    if (!content || content.length > 2000) return;

    const animeId = currentAnimeId;
    const ep = currentEpisodes[currentEpisodeIndex];
    if (!animeId || !ep?.number) return;

    try {
        await authFetch(
            `${API_BASE}/anime/${encodeURIComponent(animeId)}/episodes/${encodeURIComponent(ep.number)}/comments`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, parent_id: commentId })
            }
        );
        input.value = '';
        form.style.display = 'none';
        fetchComments(animeId, ep.number);
    } catch (err) {
        console.error('Failed to post reply:', err);
    }
}

async function handleVote(commentId, isLike) {
    if (!currentUser) { openAuthModal(); return; }
    const animeId = currentAnimeId;
    const ep = currentEpisodes[currentEpisodeIndex];
    if (!animeId || !ep?.number) return;

    try {
        await authFetch(
            `${API_BASE}/anime/${encodeURIComponent(animeId)}/episodes/${encodeURIComponent(ep.number)}/comments/${encodeURIComponent(commentId)}/like`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_like: isLike })
            }
        );
        fetchComments(animeId, ep.number);
    } catch (err) {
        console.error('Failed to vote:', err);
    }
}

function fmtCommentTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
}

async function postComment() {
    if (!currentUser) {
        openAuthModal();
        return;
    }
    const input = document.getElementById('commentInput');
    const content = input?.value?.trim();
    if (!content) return;
    if (content.length > 2000) return;

    const animeId = currentAnimeId;
    const ep = currentEpisodes[currentEpisodeIndex];
    if (!animeId || !ep?.number) return;

    try {
        await authFetch(
            `${API_BASE}/anime/${encodeURIComponent(animeId)}/episodes/${encodeURIComponent(ep.number)}/comments`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            }
        );
        if (input) input.value = '';
        fetchComments(animeId, ep.number);
    } catch (err) {
        console.error('Failed to post comment:', err);
    }
}

document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey && document.activeElement?.id === 'commentInput') {
        e.preventDefault();
        postComment();
    }
});

// ─── Schedule normalizer ──────────────────────────────────────────────────────
// ─── Source badge helper ──────────────────────────────────────────────────────
function sourceBadge(src) {
    return '';
}

// ─── Anime card ───────────────────────────────────────────────────────────────
function createAnimeCard(anime) {
    if (anime?.id) animeDetailCache.set(String(anime.id), anime);
    const status = normStatus(anime.status);
    const scls   = status.toLowerCase().replace(/\s+/g,'-');
    const id     = JSON.stringify(String(anime.id));
    const title  = displayTitle(anime);
    const poster = posterSrc(anime.poster, title);
    const fallback = posterFallbackDataUri(title);
    const genres  = clean(anime.genres) || '';
    const synopsis = clean((anime.overview||'').slice(0,200)) || '';
    const studio  = clean(anime.studios) || '';
    const epCount = anime.subEpisodes?.length || anime.subEpCount || anime.episodes || 0;
    return `
        <div class="anime-card" onclick='viewAnimeDetails(${id})'>
            <div class="anime-poster">
                <img src="${esc(poster)}" alt="${esc(title)}" loading="lazy"
                    onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='${esc(fallback)}';}else{this.removeAttribute('onerror');}">
                <div class="anime-overlay"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg></div>
                ${anime.status ? `<div class="anime-status ${esc(scls)}">${esc(status)}</div>` : ''}
                <div class="card-info-trigger" onclick="event.stopPropagation()" data-id="${String(anime.id).replace(/"/g,'&quot;')}" title="Details">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12" stroke="currentColor" stroke-width="2"/><line x1="12" y1="8" x2="12.01" y2="8" stroke="currentColor" stroke-width="2"/></svg>
                </div>
            </div>
            <div class="anime-info">
                <div class="anime-title">${esc(title)}</div>
                ${epCount > 0 ? `<div class="anime-meta-row"><span class="card-ep-badge">${epCount} eps</span></div>` : ''}
            </div>
        </div>`;
}

function renderGrid(gridId, list, empty) {
    const g = document.getElementById(gridId);
    if (!g) return;
    g.innerHTML = list.length
        ? list.map(createAnimeCard).join('')
        : `<div class="player-empty" style="grid-column:1/-1;padding:4rem">${esc(empty)}</div>`;
}

// ─── Tab routing ──────────────────────────────────────────────────────────────
function switchTab(tabId, updateRoute = true) {
    if (currentTab === tabId && tabId !== 'home') return;
    if (currentTab === 'watch' && tabId !== 'watch') { destroyHls(); if (activeVideo) { activeVideo.pause(); activeVideo = null; } }
    document.getElementById('navbar')?.classList.remove('nav-open');
    currentTab = tabId;
    const routes = { home:'/home', trending:'/trending', seasonal:'/seasonal', schedule:'/schedule', search:'/search' };
    if (updateRoute) setRoute(routes[tabId] || '/home');
    document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.tab === tabId));
    document.querySelectorAll('.bottom-nav-item').forEach(l => l.classList.toggle('active', l.dataset.tab === tabId));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`${tabId}Page`)?.classList.add('active');
    loadTabData(tabId);
}
function loadTabData(tabId) {
    if      (tabId === 'home')     { fetchHomeData(); renderContinueWatching(); }
    else if (tabId === 'trending') { currentTrendingPage = 1; fetchTrendingGridV2(); }
    else if (tabId === 'search')   { currentSearchPage = 1; fetchSearchGridV2(); }
    else if (tabId === 'seasonal') fetchSeasonalGrid();
    else if (tabId === 'schedule') fetchScheduleGrid();
}

// ─── Home (only Anilist discover sections, no old data sources) ─────────────
const CAROUSEL_SKELETON = '<div class="carousel-skeleton"><div class="sk-card"></div><div class="sk-card"></div><div class="sk-card"></div><div class="sk-card"></div><div class="sk-card"></div><div class="sk-card"></div></div>';
const DETAIL_SKELETON = '<div class="detail-skeleton"><div class="sk-banner"></div><div class="sk-body"><div class="sk-poster"></div><div class="sk-info"><div class="sk-line w-60"></div><div class="sk-line w-40"></div><div class="sk-line w-80"></div><div class="sk-line w-50"></div><div class="sk-line w-70"></div></div></div></div>';

let _homeDataFetched = 0;
async function fetchHomeData() {
    // Don't re-fetch if loaded within last 2 minutes
    if (_homeDataFetched && Date.now() - _homeDataFetched < 120000) return;
    // Show loading skeleton in all carousels
    ['discoverTrending', 'discoverPopularSeason', 'discoverUpcoming', 'discoverAlltime'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.children.length) el.innerHTML = CAROUSEL_SKELETON;
    });

    try {
        const [discTrend, discPopSea, discUpc, discAll] = await Promise.allSettled([
            apiFetch(`${API_BASE}/anilist/trending?page=1`),
            apiFetch(`${API_BASE}/anilist/popular-season?page=1`),
            apiFetch(`${API_BASE}/anilist/upcoming?page=1`),
            apiFetch(`${API_BASE}/anilist/popular-alltime?page=1`)
        ]);

        const discData = [
            { id: 'discoverTrending',       data: discTrend.status === 'fulfilled' ? discTrend.value.results || [] : [] },
            { id: 'discoverPopularSeason',  data: discPopSea.status === 'fulfilled' ? discPopSea.value.results || [] : [] },
            { id: 'discoverUpcoming',       data: discUpc.status === 'fulfilled' ? discUpc.value.results || [] : [] },
            { id: 'discoverAlltime',        data: discAll.status === 'fulfilled' ? discAll.value.results || [] : [] }
        ];

        discData.flatMap(d => d.data).forEach(a => { if (a?.id) animeDetailCache.set(String(a.id), a); });

        for (const { id, data } of discData) {
            const el = document.getElementById(id);
            if (el) {
                initCarousel(id, data);
            }
        }
        _homeDataFetched = Date.now();

        // Spotlight from popular-season data (pick up to 9 random)
        const popSeaData = discPopSea.status === 'fulfilled' ? discPopSea.value.results || [] : [];
        if (popSeaData.length) initSpotlight(popSeaData);

        // Top 10 Trending sidebar
        const trendData = discTrend.status === 'fulfilled' ? discTrend.value.results || [] : [];
        renderSidebarTrending(trendData.slice(0, 10));
    } catch (e) { console.error('Home data error', e); }
    // Ensure sidebar shows something even on error
    const list = document.getElementById('sidebarTrendingList');
    if (list && list.querySelector('.empty-sidebar')) {
        renderSidebarTrending([]);
    }
}

// ─── Continue Watching ─────────────────────────────────────────────────────────
const CW_KEY = 'animepulse_watch_progress';

function saveWatchProgress(animeId, epNumber, title, poster, malId) {
    const entry = { anime_id: animeId, mal_id: malId || '', title, poster: poster || '', episode_number: String(epNumber), updated_at: Date.now() };
    // Always save to localStorage for guests
    try {
        let list = JSON.parse(localStorage.getItem(CW_KEY) || '[]');
        const idx = list.findIndex(e => e.anime_id === animeId);
        if (idx >= 0) list[idx] = entry;
        else list.unshift(entry);
        list.sort((a, b) => b.updated_at - a.updated_at);
        localStorage.setItem(CW_KEY, JSON.stringify(list.slice(0, 20)));
    } catch { /* ignore */ }
    // Sync to server if signed in
    if (currentUser) {
        authFetch(`${API_BASE}/watch-progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry)
        }).catch(() => {});
    }
}

function getLocalWatchProgress() {
    try { return JSON.parse(localStorage.getItem(CW_KEY) || '[]'); } catch { return []; }
}

async function renderContinueWatching() {
    const section = document.getElementById('continueWatchingSection');
    const carousel = document.getElementById('continueWatchingCarousel');
    if (!section || !carousel) return;
    let items;
    if (currentUser) {
        try {
            const data = await authFetch(`${API_BASE}/watch-progress`);
            items = (data?.progress || []).map(p => ({ ...p, id: p.anime_id }));
        } catch { items = getLocalWatchProgress(); }
    } else {
        items = getLocalWatchProgress();
    }
    if (!items || !items.length) { section.style.display = 'none'; return; }
    initCarousel('continueWatchingCarousel', items, createContinueWatchingCard);
    section.style.display = '';
}

// ─── Spotlight ─────────────────────────────────────────────────────────────────
let _spotIdx = 0, _spotItems = [], _spotTimer = null;
function initSpotlight(items) {
    const shuffled = [...items].sort(() => Math.random() - 0.5).slice(0, 9);
    _spotItems = shuffled;
    _spotIdx = 0;
    const slidesEl = document.getElementById('spotlightSlides');
    const dotsEl = document.getElementById('spotlightDots');
    if (!slidesEl) return;
    slidesEl.innerHTML = shuffled.map((a, i) => `
        <div class="spotlight-slide ${i === 0 ? 'active' : ''}"
            onclick='viewAnimeDetails(${JSON.stringify(String(a.id))})'
            style="background-image:url(${esc(posterSrc(a.poster, displayTitle(a)))})">
            <div class="spotlight-info">
                <div class="spotlight-title">${esc(displayTitle(a))}</div>
                <div class="spotlight-meta">
                    ${a.type ? `<span>${esc(a.type)}</span>` : ''}
                    ${a.score ? `<span>★ ${esc(a.score)}</span>` : ''}
                    ${a.episodes ? `<span>${esc(String(a.episodes))} eps</span>` : ''}
                    ${a.premiered ? `<span>${esc(a.premiered)}</span>` : ''}
                    ${a.genres ? splitList(a.genres).slice(0,3).map(g => `<span class="badge">${esc(g)}</span>`).join('') : ''}
                </div>
                ${a.overview ? `<div class="spotlight-overview">${esc(a.overview)}</div>` : ''}
            </div>
        </div>
    `).join('');
    dotsEl.innerHTML = shuffled.map((_, i) =>
        `<button class="spotlight-dot ${i === 0 ? 'active' : ''}" onclick="spotlightGo(${i})"></button>`
    ).join('');
    document.getElementById('spotlight').style.display = '';
    _startSpotTimer();
}
function _startSpotTimer() {
    clearInterval(_spotTimer);
    _spotTimer = setInterval(() => { spotlightNext(); }, 5000);
}
function spotlightGo(idx) {
    if (idx === _spotIdx || !_spotItems.length) return;
    clearInterval(_spotTimer);
    document.querySelectorAll('.spotlight-slide').forEach((el, i) => el.classList.toggle('active', i === idx));
    document.querySelectorAll('.spotlight-dot').forEach((el, i) => el.classList.toggle('active', i === idx));
    _spotIdx = idx;
    _startSpotTimer();
}
function spotlightNext() {
    if (!_spotItems.length) return;
    spotlightGo((_spotIdx + 1) % _spotItems.length);
}
function spotlightPrev() {
    if (!_spotItems.length) return;
    spotlightGo((_spotIdx - 1 + _spotItems.length) % _spotItems.length);
}

// ─── Carousel pagination (6 per page) ────────────────────────────────────────
const _carouselData = new Map();

function renderCarouselPage(id) {
    const state = _carouselData.get(id);
    if (!state) return;
    const carousel = document.getElementById(id);
    if (!carousel) return;
    const start = state.page * 6;
    const pageData = state.data.slice(start, start + 6);
    carousel.innerHTML = pageData.map(state.renderFn).join('');
}

function initCarousel(id, allData, renderFn = createAnimeCard) {
    const carousel = document.getElementById(id);
    if (!carousel || !allData) return;

    // Already initialized – update stored data and re-render current page
    if (carousel.dataset.cInit) {
        const state = _carouselData.get(id);
        if (state) {
            const totalPages = Math.max(1, Math.ceil(allData.length / 6));
            state.data = allData;
            state.totalPages = totalPages;
            state.renderFn = renderFn;
            if (state.page >= totalPages) state.page = totalPages - 1;
            renderCarouselPage(id);
        }
        return;
    }
    carousel.dataset.cInit = '1';

    let wrap = carousel.parentElement;
    if (!wrap.classList.contains('carousel-wrap')) {
        wrap = document.createElement('div');
        wrap.className = 'carousel-wrap';
        carousel.parentNode.insertBefore(wrap, carousel);
        wrap.appendChild(carousel);
    }

    const totalPages = Math.max(1, Math.ceil(allData.length / 6));
    _carouselData.set(id, { data: allData, page: 0, totalPages, renderFn });

    const leftBtn = document.createElement('button');
    leftBtn.className = 'carousel-btn carousel-btn-left';
    leftBtn.setAttribute('aria-label', 'Previous');
    leftBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="15,18 9,12 15,6"/></svg>';

    const rightBtn = document.createElement('button');
    rightBtn.className = 'carousel-btn carousel-btn-right';
    rightBtn.setAttribute('aria-label', 'Next');
    rightBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="9,6 15,12 9,18"/></svg>';

    wrap.appendChild(leftBtn);
    wrap.appendChild(rightBtn);

    function syncArrowVisibility(state) {
        leftBtn.style.display = state.page <= 0 ? 'none' : '';
        rightBtn.style.display = state.page >= state.totalPages - 1 ? 'none' : '';
    }

    if (totalPages <= 1) { leftBtn.style.display = 'none'; rightBtn.style.display = 'none'; }

    leftBtn.addEventListener('click', () => {
        const s = _carouselData.get(id);
        if (!s || s.page <= 0) return;
        s.page--;
        renderCarouselPage(id);
        syncArrowVisibility(s);
    });

    rightBtn.addEventListener('click', () => {
        const s = _carouselData.get(id);
        if (!s || s.page >= s.totalPages - 1) return;
        s.page++;
        renderCarouselPage(id);
        syncArrowVisibility(s);
    });

    renderCarouselPage(id);
}

function createContinueWatchingCard(p) {
    const cardId = p.anime_id || p.id;
    return `<div class="anime-card" onclick='viewAnimeDetails(${JSON.stringify(String(cardId))})'>
        <div class="anime-poster">
            <img src="${esc(p.poster)}" alt="${esc(p.title)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22300%22><rect fill=%22%23131726%22 width=%22200%22 height=%22300%22/></svg>'">
            <div class="anime-overlay"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 19,12 8,19"/></svg></div>
            <div class="continue-badge">EP ${esc(p.episode_number)}</div>
        </div>
        <div class="anime-info">
            <div class="anime-title">${esc(p.title)}</div>
        </div>
    </div>`;
}

// ─── Sidebar helpers ───────────────────────────────────────────────────────────
function renderSidebarTrending(items) {
    const list = document.getElementById('sidebarTrendingList');
    if (!list) return;
    if (!items.length) { list.innerHTML = '<div class="empty-sidebar">No trending data.</div>'; return; }
    list.innerHTML = items.map((a, i) => {
        const title = displayTitle(a);
        const poster = posterSrc(a.poster, title);
        const subtitle = [a.type, a.score ? `\u2605${a.score}` : ''].filter(Boolean).join(' \u00b7 ');
        return `<div class="trending-item" onclick='viewAnimeDetails(${JSON.stringify(String(a.id))})'>
            <div class="trending-rank">${i + 1}</div>
            <img src="${esc(poster)}" alt="${esc(title)}" loading="lazy" onerror="this.style.display='none'">
            <div class="trending-meta">
                <strong>${esc(title)}</strong>
                ${subtitle ? `<small>${esc(subtitle)}</small>` : ''}
            </div>
        </div>`;
    }).join('');
}

const SIDEBAR_GENRES = ['Action','Adventure','Comedy','Drama','Romance','Sci-Fi','Fantasy','Horror','Slice of Life','Mystery','Thriller','Sports'];

function initSidebarGenres() {
    const chips = document.getElementById('sidebarGenres');
    if (!chips) return;
    chips.innerHTML = SIDEBAR_GENRES.map(g =>
        `<span class="genre-chip" onclick="sidebarGenreClick('${esc(g)}')">${esc(g)}</span>`
    ).join('');
}

function sidebarGenreClick(genre) {
    const input = document.getElementById('advSearchInput');
    if (input) input.value = '';
    switchTab('search', false);
    setTimeout(() => {
        const checkboxes = document.querySelectorAll('.mselect-wrap[data-mselect="genre"] input[type="checkbox"]');
        checkboxes.forEach(cb => { cb.checked = cb.value === genre; });
        onMSChange(checkboxes[0]);
    }, 100);
}

// ─── Multi-select dropdown helpers ──────────────────────────────────────────
function toggleMS(btn) {
    const wrap = btn.closest('.mselect-wrap');
    if (!wrap) return;
    const isOpen = wrap.classList.toggle('open');
    document.querySelectorAll('.mselect-wrap.open').forEach(w => {
        if (w !== wrap) w.classList.remove('open');
    });
}

function getMSValues(name) {
    const wrap = document.querySelector(`.mselect-wrap[data-mselect="${name}"]`);
    if (!wrap) return [];
    const checked = wrap.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checked).map(cb => cb.value);
}

function getMSSort() {
    const sel = document.querySelector('input[name="ms-sort"]:checked');
    return sel ? sel.value : '';
}

function updateMSTriggerText() {
    document.querySelectorAll('.mselect-wrap').forEach(wrap => {
        const trigger = wrap.querySelector('.mselect-trigger');
        if (!trigger) return;
        const checkboxes = wrap.querySelectorAll('input[type="checkbox"]:checked');
        const radio = wrap.querySelector('input[type="radio"]:checked');
        const label = wrap.dataset.mselect;
        const names = { genre: 'All Genres', year: 'Any Year', season: 'Any Season', format: 'All Types', status: 'Any Status', sort: 'Default' };
        if (label === 'sort' && radio) {
            const txt = radio.parentElement.textContent.trim();
            trigger.textContent = (radio.value ? txt : 'Default') + ' ▾';
        } else if (checkboxes.length) {
            trigger.textContent = checkboxes.length === 1
                ? checkboxes[0].value + ' ▾'
                : `${checkboxes.length} selected ▾`;
        } else {
            trigger.textContent = (names[label] || label) + ' ▾';
        }
    });
}

function onMSChange(el) {
    updateMSTriggerText();
    // Close dropdown on select
    const wrap = el.closest('.mselect-wrap');
    if (wrap && wrap.dataset.mselect === 'sort') {
        wrap.classList.remove('open');
    }
    executeSearch();
}

// Close dropdowns on outside click
document.addEventListener('click', e => {
    if (!e.target.closest('.mselect-wrap')) {
        document.querySelectorAll('.mselect-wrap.open').forEach(w => w.classList.remove('open'));
    }
});

// ─── Trending (Anilist, infinite scroll with load more) ─────────────────────
async function fetchTrendingGridV2(append = false) {
    if (!append) {
        const grid = document.getElementById('trendingGrid');
        if (grid && !grid.children.length) grid.innerHTML = CAROUSEL_SKELETON;
    }
    try {
        const data = await apiFetch(`${API_BASE}/anilist/trending?page=${currentTrendingPage}`);
        const posts = data.results || [];
        const grid = document.getElementById('trendingGrid');
        if (grid) {
            const html = posts.map(createAnimeCard).join('');
            grid.innerHTML = append ? grid.innerHTML + html : (html || '<div class="player-empty" style="grid-column:1/-1;padding:4rem">No trending titles.</div>');
        }
        const more = document.getElementById('loadMoreTrending');
        if (more) more.style.display = data.hasNext && posts.length ? 'inline-block' : 'none';
    } catch (e) { console.error(e); renderGrid('trendingGrid', [], 'Failed to load trending.'); }
}

function loadMoreTrending() {
    currentTrendingPage++;
    fetchTrendingGridV2(true);
}

// ─── Search V2 (Senshi + Consumet fallback, paginated) ──────────────────────
let currentSearchQueryV2 = '';

async function fetchSearchGridV2(append = false) {
    try {
        const query  = document.getElementById('advSearchInput')?.value.trim() || '';
        const sort   = getMSSort();
        const genre  = getMSValues('genre').join(',');
        const year   = getMSValues('year').join(',');
        const season = getMSValues('season').join(',');
        const format = getMSValues('format').join(',');
        const status = getMSValues('status').join(',');

        const hasFilters = genre || year || season || format || status;

        if (!query && !hasFilters) {
            // No query/no filters: show some results (trending)
            let data;
            try { data = await apiFetch(`${API_BASE}/anilist/trending?page=1`); } catch {}
            const results = data?.results || [];
            const grid = document.getElementById('searchGrid');
            if (grid) {
                grid.innerHTML = results.length
                    ? results.map(createAnimeCard).join('')
                    : '<div class="player-empty" style="grid-column:1/-1;padding:4rem">Use the search box or filters to find anime!</div>';
            }
            document.getElementById('searchResultTitle').innerText = 'Browse Trending';
            document.getElementById('searchResultCount').innerText = results.length ? `${results.length} trending titles` : '';
            document.getElementById('loadMoreSearch').style.display = 'none';
            return;
        }

        currentSearchQueryV2 = query;
        let url = `${API_BASE}/search/${encodeURIComponent(query || '')}?page=${currentSearchPage}`;
        if (genre)  url += `&genre=${encodeURIComponent(genre)}`;
        if (year)   url += `&year=${encodeURIComponent(year)}`;
        if (season) url += `&season=${encodeURIComponent(season)}`;
        if (format) url += `&format=${encodeURIComponent(format)}`;
        if (status) url += `&status=${encodeURIComponent(status)}`;
        if (sort)   url += `&sort=${encodeURIComponent(sort)}`;
        const data = await apiFetch(url);
        const results = data.results || [];
        const grid = document.getElementById('searchGrid');
        if (grid) {
            const html = results.map(createAnimeCard).join('');
            grid.innerHTML = append ? grid.innerHTML + html
                : (html || '<div class="player-empty" style="grid-column:1/-1;padding:4rem">No results found.</div>');
        }
        document.getElementById('searchResultTitle').innerText = query ? `Results for "${query}"` : 'Filtered Results';
        const count = document.querySelectorAll('#searchGrid .anime-card').length;
        document.getElementById('searchResultCount').innerText = `${count} title${count !== 1 ? 's' : ''} found`;
        document.getElementById('loadMoreSearch').style.display = data.hasNext && results.length ? 'inline-block' : 'none';
    } catch (e) { console.error(e); renderGrid('searchGrid', [], 'Search failed.'); }
}

// Keep old search for backward compat
async function executeSearch() {
    currentSearchPage = 1;
    fetchSearchGridV2();
}

async function loadMoreSearch() {
    currentSearchPage++;
    fetchSearchGridV2(true);
}

// ─── Seasonal (Anilist popular this season) ─────────────────────────────────
async function fetchSeasonalGrid() {
    const grid = document.getElementById('seasonalGrid');
    if (grid && !grid.children.length) grid.innerHTML = CAROUSEL_SKELETON;
    try {
        const data  = await apiFetch(`${API_BASE}/anilist/popular-season?page=1`);
        const posts = data.results || [];
        const sub   = document.querySelector('#seasonalPage .page-subtitle');
        const month = new Date().getMonth() + 1;
        const season= month <= 2 || month === 12 ? 'Winter' : month <= 5 ? 'Spring' : month <= 8 ? 'Summer' : 'Fall';
        if (sub) sub.innerText = `${season} ${new Date().getFullYear()} — popular this season`;
        renderGrid('seasonalGrid', posts, 'No seasonal titles found.');
    } catch (e) { renderGrid('seasonalGrid', [], 'No seasonal titles found.'); }
}

// ─── Schedule (Anilist weekly calendar) ─────────────────────────────────────
async function fetchScheduleGrid() {
    const grid = document.getElementById('scheduleGrid');
    if (grid && !grid.children.length) grid.innerHTML = CAROUSEL_SKELETON;
    try {
        const data = await apiFetch(`${API_BASE}/anilist/schedule?page=1`);
        const grouped = data.grouped || {};
        const grid = document.getElementById('scheduleGrid');
        const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        if (grid) {
            const hasData = Object.keys(grouped).length > 0;
            if (hasData) {
                grid.innerHTML = days.map(day => {
                    const items = grouped[day] || [];
                    return `<div class="schedule-day"><h3 class="schedule-day-title">${esc(day)}</h3><div class="schedule-day-grid">${
                        items.length ? items.map(a => `
                            <button class="schedule-card" onclick='viewAnimeDetails(${JSON.stringify(String(a.id))})'>
                                <img src="${esc(a.poster)}" alt="${esc(a.title)}" onerror="this.style.display='none'">
                                <span>
                                    <strong>${esc(a.title)}</strong>
                                    <small>EP ${esc(String(a.episode))} · ${fmtAiringTime(a.airingAt)}</small>
                                </span>
                            </button>`).join('') : '<div class="schedule-empty">No airing this day</div>'
                    }</div></div>`;
                }).join('');
            } else {
                grid.innerHTML = '<div class="player-empty" style="grid-column:1/-1;padding:4rem">No schedule data available.</div>';
            }
        }
    } catch (e) { console.error(e); }
}

function fmtAiringTime(ts) {
    if (!ts) return 'Soon';
    const d = new Date(ts * 1000);
    const now = new Date();
    const diff = d - now;
    if (diff < 0) return 'Aired';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const minsR = mins % 60;
    if (hrs < 24) return `${hrs}h ${minsR}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d ${hrs % 24}h`;
}

// ─── URL helpers ───────────────────────────────────────────────────────────────
function stripSourcePrefix(id) {
    return String(id).replace(/^(animepulse:|anilist:|gogo:|senshi:)/, '');
}
function storeIdMapping(cleanId, fullId) {
    try { sessionStorage.setItem('idmap_'+cleanId, fullId); } catch {}
}
function resolveId(cleanId) {
    try { return sessionStorage.getItem('idmap_'+cleanId) || cleanId; } catch { return cleanId; }
}

// ─── Detail ───────────────────────────────────────────────────────────────────
async function getAnimeDetail(id, animepulseId) {
    const cached = animeDetailCache.get(String(id));
    if (cached?._detailFetched) return cached;
    try {
        let url = `${API_BASE}/detail?id=${encodeURIComponent(id)}`;
        if (animepulseId) url += `&animepulseId=${encodeURIComponent(animepulseId)}`;
        const detail = await apiFetch(url);
        detail._detailFetched = true;
        const merged = cached ? { ...cached, ...detail } : detail;
        animeDetailCache.set(String(id), merged);
        return merged;
    } catch (err) {
        if (cached) return cached;
        throw err;
    }
}

async function viewAnimeDetails(id) {
    // Show loading skeleton immediately
    document.getElementById('detailContainer').innerHTML = DETAIL_SKELETON;
    document.getElementById('episodesSection').style.display = 'none';
        lastDetailPageId = id;
    const cleanId = stripSourcePrefix(id);
    storeIdMapping(cleanId, String(id));
    setRoute(`/anime/${encodeURIComponent(cleanId)}`);
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('detailPage').classList.add('active');
    try {
        const cachedCard = animeDetailCache.get(String(id));
        const anime = await getAnimeDetail(id, cachedCard?.animepulseId);

        const isGogo  = String(id).startsWith('gogo:') || String(anime.id).startsWith('gogo:');
        const isAnilist = String(id).startsWith('anilist:') || String(anime.id).startsWith('anilist:');
        const status   = normStatus(anime.status);
        const genresHtml = splitList(anime.genres).map(g => `<span class="badge">${esc(g)}</span>`).join('');
        const hasDub   = anime.hasDub || (anime.dubEpisodes?.length || 0) > 0;
        const subtitle = [clean(anime.type||'TV'), clean(anime.premiered)].filter(Boolean).join(' • ');
        const epCount  = anime.episodeList?.length || anime.episodes || anime.subEpisodes?.length || 0;
        let sourceBadge;
        if (isGogo) sourceBadge = `<span class="source-badge source-gogo">GogoAnime</span>`;
        else if (isAnilist) sourceBadge = '';
        else sourceBadge = '';

        // Store episodes for grid
        let episodeList = anime.episodeList || [];
        if (!episodeList.length && anime.subEpisodes) {
            episodeList = anime.subEpisodes.map(n => ({ id: String(n), number: String(n), title: `Episode ${n}` }));
        }
        window._detailEpisodes = episodeList;

        const detailRows = [
            { label: 'Type',        value: clean(anime.type) },
            { label: 'Status',      value: normStatus(anime.status) },
            { label: 'Episodes',    value: epCount },
            { label: 'Premiered',   value: clean(anime.premiered) },
            { label: 'Studios',     value: clean(anime.studios) },
            { label: 'Producers',   value: clean(anime.producers) },
            { label: 'Rating',      value: clean(anime.rating) },
            { label: 'Score',       value: clean(anime.score) },
            { label: 'Duration',    value: clean(anime.runtime) }
        ].filter(r => r.value).map(r =>
            `<div class="detail-info-row"><span class="detail-info-label">${r.label}</span><span class="detail-info-value">${esc(r.value)}</span></div>`
        ).join('');

        document.getElementById('detailContainer').innerHTML = `
            <div class="detail-header">
                <img class="detail-backdrop" src="${esc(posterSrc(anime.backdrop || anime.poster, anime.title))}" alt="">
                <div class="detail-gradient"></div>
                <div class="detail-content-wrapper">
                    <img class="detail-poster" src="${esc(posterSrc(anime.poster, anime.title))}" alt="${esc(displayTitle(anime)||'Anime')}"
                        onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='${esc(posterFallbackDataUri(displayTitle(anime)))}';}else{this.removeAttribute('onerror');}">
                    <div class="detail-info">
                        <h1 class="detail-title">${esc(anime.title||'Unknown Title')} ${sourceBadge}</h1>
                        <p class="detail-japanese">${esc(subtitle)}</p>
                        <div class="detail-meta">
                            <span>${esc(status)}</span>
                            ${clean(anime.score)  ? `<span>★ ${esc(clean(anime.score))}</span>` : ''}
                            <span>${esc(String(epCount))} episodes</span>
                            ${clean(anime.rating) ? `<span>${esc(clean(anime.rating))}</span>` : ''}
                            ${hasDub              ? `<span style="color:#60a5fa;font-weight:700">Dub</span>` : ''}
                        </div>
                        <p class="detail-synopsis">${esc(anime.overview||anime.genres||'No synopsis available.')}</p>
                        <div class="detail-genres">${genresHtml}</div>
                        <div class="detail-info-grid">${detailRows}</div>
                        <div class="detail-actions">
                            <button class="btn btn-ghost" onclick="goHome()">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polyline points="15 18 9 12 15 6"/></svg>
                                Back
                            </button>
                            <button class="btn btn-primary" onclick='startStreaming(${JSON.stringify(String(id))}, "sub")'>
                                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="5,3 19,12 5,21"/></svg>
                                Watch Sub
                            </button>
                            ${hasDub ? `<button class="btn btn-ghost" onclick='startStreaming(${JSON.stringify(String(id))}, "dub")'>Watch Dub</button>` : ''}
                        </div>
                    </div>
                </div>
            </div>
            ${anime.characters?.length ? `
            <div class="detail-section">
                <h4 class="detail-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    Voice Cast
                </h4>
                <div class="cast-grid">
                    ${anime.characters.map(c => `
                        <div class="cast-item">
                            <div class="cast-char">
                                ${c.image ? `<img src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy">` : `<div class="cast-avatar">${esc((c.name||'?')[0])}</div>`}
                                <span>${esc(c.name)}</span>
                                <small>${esc(c.role === 'MAIN' ? 'Main' : c.role)}</small>
                            </div>
                            ${c.voiceActors?.length ? `
                            <div class="cast-va">
                                ${c.voiceActors.map(va => va.image
                                    ? `<img src="${esc(va.image)}" alt="${esc(va.name)}" loading="lazy" title="${esc(va.name)}">`
                                    : `<div class="cast-avatar" title="${esc(va.name)}">${esc((va.name||'?')[0])}</div>`
                                ).join('')}
                            </div>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}
            ${anime.nextAiringEpisode ? `
            <div class="detail-section">
                <h4 class="detail-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
                    Next Episode
                </h4>
                <div class="next-ep-info">
                    <strong>Episode ${esc(String(anime.nextAiringEpisode.episode))}</strong> airing <span class="next-ep-countdown" data-airing="${anime.nextAiringEpisode.airingAt}"></span>
                </div>
            </div>` : ''}`;

        // Start tickers for countdowns
        document.querySelectorAll('.next-ep-countdown').forEach(cd => {
            function tick() {
                const left = Math.max(0, (Number(cd.dataset.airing) * 1000) - Date.now());
                if (left <= 0) { cd.textContent = 'now'; return; }
                const d = Math.floor(left/86400000), h = Math.floor((left%86400000)/3600000), m = Math.floor((left%3600000)/60000);
                cd.textContent = d ? `in ${d}d ${h}h ${m}m` : h ? `in ${h}h ${m}m` : `in ${m}m`;
            }
            tick();
            setInterval(tick, 60000);
        });

        // Render episode grid
        const epSection = document.getElementById('episodesSection');
        const epGrid    = document.getElementById('episodesGrid');
        const epCountEl = document.getElementById('episodesSectionCount');
        if (epSection && epGrid) {
            if (episodeList.length > 0) {
                epSection.style.display = 'block';
                epCountEl.textContent = `${episodeList.length} EPS`;
                renderEpisodeGrid(episodeList);
            } else {
                epSection.style.display = 'none';
            }
        }

        // Cast section
        const castContainer = document.getElementById('watchCastContainer');
        if (castContainer && anime.characters?.length) {
            castContainer.style.display = '';
            castContainer.innerHTML = `
                <h4 class="wp-card-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    Voice Cast
                </h4>
                <div class="cast-grid">
                    ${anime.characters.map(c => `
                        <div class="cast-item">
                            <div class="cast-char">
                                ${c.image ? `<img src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy">` : `<div class="cast-avatar">${esc((c.name||'?')[0])}</div>`}
                                <span>${esc(c.name)}</span>
                                <small>${esc(c.role === 'MAIN' ? 'Main' : c.role)}</small>
                            </div>
                            ${c.voiceActors?.length ? `
                            <div class="cast-va">
                                ${c.voiceActors.map(va => va.image
                                    ? `<img src="${esc(va.image)}" alt="${esc(va.name)}" loading="lazy" title="${esc(va.name)}">`
                                    : `<div class="cast-avatar" title="${esc(va.name)}">${esc((va.name||'?')[0])}</div>`
                                ).join('')}
                            </div>` : ''}
                        </div>
                    `).join('')}
                </div>`;
        }

        // Next episode airing countdown
        const nextEpContainer = document.getElementById('watchNextEpContainer');
        if (nextEpContainer && anime.nextAiringEpisode) {
            const ne = anime.nextAiringEpisode;
            nextEpContainer.style.display = '';
            nextEpContainer.innerHTML = `
                <h4 class="wp-card-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
                    Next Episode
                </h4>
                <div class="next-ep-info">
                    <strong>Episode ${esc(String(ne.episode))}</strong> airing <span class="next-ep-countdown" data-airing="${ne.airingAt}"></span>
                </div>`;
            // Start countdown
            const cd = nextEpContainer.querySelector('.next-ep-countdown');
            if (cd) {
                function tick() {
                    const left = Math.max(0, (Number(cd.dataset.airing) * 1000) - Date.now());
                    if (left <= 0) { cd.textContent = 'now'; return; }
                    const d = Math.floor(left/86400000), h = Math.floor((left%86400000)/3600000), m = Math.floor((left%3600000)/60000);
                    cd.textContent = d ? `in ${d}d ${h}h ${m}m` : h ? `in ${h}h ${m}m` : `in ${m}m`;
                }
                tick();
                setInterval(tick, 60000);
            }
        }

        // More Like This
        fetchMoreLikeThis(anime.genres, anime.premiered);
    } catch (e) { console.error(e); }
}

function renderEpisodeGrid(eps) {
    const grid = document.getElementById('episodesGrid');
    if (!grid) return;
    grid.innerHTML = eps.map(ep => `
        <button class="episode-grid-card${ep.filler ? ' filler' : ''}"
            onclick='startStreaming(${JSON.stringify(String(lastDetailPageId))}, "sub")'>
            <span class="ep-num">
                EP ${esc(String(ep.number))}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg>
            </span>
            <span class="ep-name">${esc(ep.title || `Episode ${ep.number}`)}</span>
            ${ep.filler ? '<span class="ep-fill-tag">FILLER</span>' : ''}
        </button>`).join('');
}

async function fetchMoreLikeThis(genres, premiered) {
    const section = document.getElementById('moreLikeThis');
    const carousel = document.getElementById('moreLikeThisCarousel');
    if (!section || !carousel || !genres) { section.style.display = 'none'; return; }
    try {
        const year = premiered ? parseInt(premiered.match(/\d{4}/)?.[0]) : null;
        const params = new URLSearchParams();
        params.set('genres', genres);
        if (year) { params.set('yearStart', String(year - 5)); params.set('yearEnd', String(year + 5)); }
        const data = await apiFetch(`${API_BASE}/similar?${params}`);
        const results = (data.results || []).slice(0, 12);
        if (results.length) {
            carousel.innerHTML = results.map(createAnimeCard).join('');
            section.style.display = '';
        } else {
            section.style.display = 'none';
        }
    } catch { section.style.display = 'none'; }
}

function filterEpisodes(query) {
    const grid = document.getElementById('episodesGrid');
    if (!grid) return;
    const eps = window._detailEpisodes || [];
    const q = query.toLowerCase();
    grid.innerHTML = eps
        .filter(ep => !q || String(ep.number).includes(q) || (ep.title || '').toLowerCase().includes(q))
        .map(ep => `<button class="episode-grid-card${ep.filler ? ' filler' : ''}"
            onclick='startStreaming(${JSON.stringify(String(lastDetailPageId))}, "sub")'>
            <span class="ep-num">
                EP ${esc(String(ep.number))}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg>
            </span>
            <span class="ep-name">${esc(ep.title || `Episode ${ep.number}`)}</span>
            ${ep.filler ? '<span class="ep-fill-tag">FILLER</span>' : ''}
        </button>`).join('');
}

function filterWatchEpisodes(query) {
    const q = query.toLowerCase();
    const list = document.getElementById('episodesList');
    if (!list) return;
    if (!q) {
        renderEpisodeList();
        return;
    }
    const filtered = currentEpisodes
        .map((ep, i) => ({ ep, i }))
        .filter(({ ep }) => String(ep.number).includes(q) || (ep.title || '').toLowerCase().includes(q));
    list.innerHTML = filtered.map(({ ep, i }) => `
        <button class="episode-item ${i === currentEpisodeIndex ? 'active' : ''}" onclick="playEpisode(${i}, this)">
            <span class="ep-num-badge">${esc(ep.number)}</span>
            <span class="ep-name-text">${esc(ep.title)}</span>
            <svg class="ep-play-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="5,3 19,12 5,21"/></svg>
        </button>`).join('');
    document.getElementById('seeAllEpisodesBtn').style.display = 'none';
}

// ─── Anilist Enrichment ────────────────────────────────────────────────────────
async function fetchAnilistEnrich(title) {
    try {
        const data = await apiFetch(`${API_BASE}/anilist/enrich?title=${encodeURIComponent(title)}`);
        currentEnrichData = data;
        if (data?.cast?.length) {
            const container = document.getElementById('watchCastContainer');
            if (container) {
                container.style.display = '';
                container.innerHTML = `
                    <h4 class="wp-card-title" style="margin-bottom:0.75rem">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                        Cast
                    </h4>
                    <div class="cast-grid">${data.cast.map(c => `
                        <div class="cast-item">
                            <div class="cast-char">
                                ${c.image ? `<img src="${esc(c.image)}" alt="${esc(c.name)}">` : `<div class="cast-avatar">${esc((c.name||'?')[0])}</div>`}
                                <span>${esc(c.name)}</span>
                                <small>${esc(c.role||'')}</small>
                            </div>
                            ${c.va ? `<div class="cast-va">
                                ${c.va.image ? `<img src="${esc(c.va.image)}" alt="${esc(c.va.name)}">` : `<div class="cast-avatar">${esc((c.va.name||'?')[0])}</div>`}
                                <span>${esc(c.va.name)}</span>
                                <small>VA</small>
                            </div>` : ''}
                        </div>`).join('')}</div>`;
            }
        }
        if (data?.nextAiringEpisode) {
            const n = data.nextAiringEpisode;
            const secs = n.timeUntilAiring;
            const days = Math.floor(secs / 86400);
            const hrs = Math.floor((secs % 86400) / 3600);
            let timeStr = days > 0 ? `${days}d ${hrs}h` : `${hrs}h ${Math.floor((secs % 3600) / 60)}m`;
            const container = document.getElementById('watchNextEpContainer');
            if (container) {
                container.style.display = '';
                container.innerHTML = `
                    <h4 class="wp-card-title" style="margin-bottom:0.5rem">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        Next Episode
                    </h4>
                    <div class="next-ep-info">Episode ${esc(n.episode)} — airing in <strong>${timeStr}</strong></div>`;
            }
        }
        if (data?.studios?.length) {
            const container = document.getElementById('watchDetailsContainer');
            if (container) {
                const el = document.createElement('div');
                el.className = 'watch-studios';
                el.innerHTML = `<strong>Studios:</strong> ${esc(data.studios.join(', '))}`;
                container.appendChild(el);
            }
        }
    } catch { /* enrichment optional */ }
}

// ─── Streaming ────────────────────────────────────────────────────────────────
async function startStreaming(id, lang = 'sub') {
    currentAnimeId      = id;
    currentMalId        = null;
    currentLang         = lang;
    currentEpisodes     = [];
    currentEpisodeIndex = 0;

    const epList    = document.getElementById('episodesList');
    const vidCont   = document.getElementById('videoContainer');

    document.getElementById('playerStatus').innerText  = 'Loading';
    document.getElementById('episodesCount').innerText = '0';
    epList.innerHTML  = `<div class="player-empty">Fetching episodes…</div>`;
    vidCont.innerHTML = `<div class="player-empty">Select an episode to begin.</div>`;
    document.getElementById('serverPicker').innerHTML = '';
    document.getElementById('serverStrip').style.display = 'none';
    document.getElementById('moreLikeThis').style.display = 'none';
    switchTab('watch', false);

    try {
        currentAnimeDetail = await getAnimeDetail(id);
        currentMalId = currentAnimeDetail.malId;
        currentAnimepulseId = currentAnimeDetail.animepulseId || null;
        document.getElementById('playerAnimeTitle').innerText = displayTitle(currentAnimeDetail) || 'Anime';
        const cleanWatchId = stripSourcePrefix(currentAnimeId || id);
        storeIdMapping(cleanWatchId, currentAnimeId || String(id));
        setRoute(`/watch/${encodeURIComponent(cleanWatchId)}/ep-1`);

        // Set current server
        currentServersAvail = currentAnimeDetail.servers || ['senshi'];
        currentServer = currentServersAvail.includes('senshi') ? 'senshi' : currentServersAvail[0];

        // Info card
        const info = document.getElementById('watchDetailsContainer');
        if (info) {
            const a = currentAnimeDetail;
            info.innerHTML = `
                <h2 class="watch-title">${esc(a.title)}</h2>
                <div class="watch-meta">
                    ${clean(a.type)      ? `<span>${esc(clean(a.type))}</span>`      : ''}
                    <span>${esc(normStatus(a.status))}</span>
                    ${clean(a.score)     ? `<span>★ ${esc(clean(a.score))}</span>`   : ''}
                    ${clean(a.premiered) ? `<span>${esc(clean(a.premiered))}</span>` : ''}
                </div>
                ${a.genres ? `<div class="watch-genres">${esc(a.genres)}</div>` : ''}
                ${clean(a.studios) ? `<div class="watch-studios">${esc(clean(a.studios))}</div>` : ''}
                <div class="watch-synopsis">${esc(a.overview||a.genres||'No synopsis available.')}</div>`;
        }

        // Render cast, next episode, studio from currentAnimeDetail
        const castContainer = document.getElementById('watchCastContainer');
        if (castContainer && currentAnimeDetail.characters?.length) {
            castContainer.style.display = '';
            castContainer.innerHTML = `
                <h4 class="wp-card-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    Voice Cast
                </h4>
                <div class="cast-grid">
                    ${currentAnimeDetail.characters.map(c => `
                        <div class="cast-item">
                            <div class="cast-char">
                                ${c.image ? `<img src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy">` : `<div class="cast-avatar">${esc((c.name||'?')[0])}</div>`}
                                <span>${esc(c.name)}</span>
                                <small>${esc(c.role === 'MAIN' ? 'Main' : c.role)}</small>
                            </div>
                            ${c.voiceActors?.length ? `
                            <div class="cast-va">
                                ${c.voiceActors.map(va => va.image
                                    ? `<img src="${esc(va.image)}" alt="${esc(va.name)}" loading="lazy" title="${esc(va.name)}">`
                                    : `<div class="cast-avatar" title="${esc(va.name)}">${esc((va.name||'?')[0])}</div>`
                                ).join('')}
                            </div>` : ''}
                        </div>
                    `).join('')}
                </div>`;
        }
        const nextEpContainer = document.getElementById('watchNextEpContainer');
        if (nextEpContainer && currentAnimeDetail.nextAiringEpisode) {
            const ne = currentAnimeDetail.nextAiringEpisode;
            nextEpContainer.style.display = '';
            nextEpContainer.innerHTML = `
                <h4 class="wp-card-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
                    Next Episode
                </h4>
                <div class="next-ep-info">
                    <strong>Episode ${esc(String(ne.episode))}</strong> airing <span class="next-ep-countdown" data-airing="${ne.airingAt}"></span>
                </div>`;
            const cd = nextEpContainer.querySelector('.next-ep-countdown');
            if (cd) {
                function tick() {
                    const left = Math.max(0, (Number(cd.dataset.airing) * 1000) - Date.now());
                    if (left <= 0) { cd.textContent = 'now'; return; }
                    const d = Math.floor(left/86400000), h = Math.floor((left%86400000)/3600000), m = Math.floor((left%3600000)/60000);
                    cd.textContent = d ? `in ${d}d ${h}h ${m}m` : h ? `in ${h}h ${m}m` : `in ${m}m`;
                }
                tick();
                setInterval(tick, 60000);
            }
        }

        // Anilist enrichment for cast/next-ep (server-cached, always fetches)
        fetchAnilistEnrich(displayTitle(currentAnimeDetail));

        // Build episode list from episodeList (Senshi format) or subEpisodes
        const episodeList = currentAnimeDetail.episodeList || [];
        const subEps = currentAnimeDetail.subEpisodes || [];
        const dubEps = currentAnimeDetail.dubEpisodes || [];
        if (lang === 'dub' && !(dubEps.length > 0 || currentAnimeDetail.hasDub)) currentLang = 'sub';

        if (episodeList.length) {
            currentEpisodes = episodeList.map(ep => ({
                id: ep.id || ep.number,
                number: ep.number,
                title: ep.title || `Episode ${ep.number}`,
                filler: ep.filler,
                intro_start: ep.intro_start,
                intro_end: ep.intro_end,
                outro_start: ep.outro_start,
                outro_end: ep.outro_end
            }));
        } else if (subEps.length) {
            currentEpisodes = subEps.map(n => ({ id: String(n), number: String(n), title: `Episode ${n}` }));
        }

        if (!currentEpisodes.length) {
            showPlayerUnavailable(currentAnimeDetail, 'No episodes found for this title.');
            return;
        }

        renderServerStrip();
        renderEpisodeList();
        fetchMoreLikeThis(currentAnimeDetail.genres, currentAnimeDetail.premiered);
        playEpisode(0, document.querySelector('.episode-item'));
    } catch (e) {
        console.error(e);
        showPlayerUnavailable(null, 'Failed to load episode list.');
    }
}

function renderServerStrip() {
    const picker = document.getElementById('serverPicker');
    const strip  = document.getElementById('serverStrip');
    const toggle = document.getElementById('langToggle');
    if (!picker || !strip) return;
    const labels = { senshi: 'Server 1', animepulse: 'Server 2' };
    strip.style.display = '';
    picker.innerHTML = currentServersAvail.map(s => `
        <button class="server-btn ${s === currentServer ? 'active' : ''}" type="button"
            onclick='switchServer(${JSON.stringify(s)})'>
            ${labels[s] || s}
        </button>`).join('');
    // Update lang toggle visibility — only show when both choices exist
    if (toggle) {
        const hasBoth = currentServer === 'animepulse'
            ? (currentAnimeDetail?.dubEpisodes?.length > 0)
            : (currentAnimeDetail?.hasDub && currentAnimeDetail?.hasHardSub);
        toggle.style.display = hasBoth ? '' : 'none';
        toggle.querySelectorAll('.lang-toggle-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.lang === currentLang);
        });
    }
}

async function switchServer(server) {
    if (server === currentServer) return;
    pendingSeekTime = activeVideo?.currentTime || -1;
    currentServer = server;
    renderServerStrip();
    if (currentEpisodes[currentEpisodeIndex]) {
        await playEpisode(currentEpisodeIndex, document.querySelector('.episode-item.active'));
    }
}

function renderEpisodeList() {
    document.getElementById('episodesCount').innerText = currentEpisodes.length;
    document.getElementById('playerStatus').innerText  = 'Ready';
    const total = currentEpisodes.length;
    const limit = Math.min(8, total);
    let start = Math.max(0, Math.min(currentEpisodeIndex - 3, total - limit));
    if (total <= 8) start = 0;
    const visible = currentEpisodes.slice(start, start + limit);
    document.getElementById('episodesList').innerHTML  = visible.map((ep, i) => {
        const realIndex = start + i;
        return `<button class="episode-item ${realIndex === currentEpisodeIndex ? 'active' : ''}" onclick="playEpisode(${realIndex}, this)">
            <span class="ep-num-badge">${esc(ep.number)}</span>
            <span class="ep-name-text">${esc(ep.title)}</span>
            <svg class="ep-play-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="5,3 19,12 5,21"/></svg>
        </button>`;
    }).join('');
    const seeAllBtn = document.getElementById('seeAllEpisodesBtn');
    if (seeAllBtn) seeAllBtn.style.display = total > 8 ? '' : 'none';
}

function openEpisodeModal() {
    const grid = document.getElementById('episodeModalGrid');
    if (!grid) return;
    grid.innerHTML = currentEpisodes.map((ep, i) => `
        <button class="ep-modal-item ${i === currentEpisodeIndex ? 'active' : ''}"
            onclick="playEpisode(${i}, document.querySelectorAll('.episode-item')[${i}]);closeEpisodeModal()">
            <span class="ep-modal-num">EP ${esc(ep.number)}</span>
            <span class="ep-modal-title">${esc(ep.title)}</span>
            <svg class="ep-modal-play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>
        </button>`).join('');
    document.getElementById('episodeModal')?.classList.add('active');
    document.body.style.overflow = 'hidden';
}
function closeEpisodeModal() {
    document.getElementById('episodeModal')?.classList.remove('active');
    document.getElementById('epModalFilter').value = '';
    document.body.style.overflow = '';
}
function filterModalEpisodes(val) {
    const grid = document.getElementById('episodeModalGrid');
    if (!grid) return;
    const q = val.toLowerCase();
    grid.querySelectorAll('.ep-modal-item').forEach(el => {
        const match = el.textContent.toLowerCase().includes(q);
        el.style.display = match ? '' : 'none';
    });
}

async function switchLang(lang) {
    if (lang === currentLang) return;
    pendingSeekTime = activeVideo?.currentTime || -1;
    currentLang = lang;
    destroyHls();
    renderServerStrip();
    if (currentEpisodes[currentEpisodeIndex]) {
        await playEpisode(currentEpisodeIndex, document.querySelector('.episode-item.active'));
    }
}

async function playEpisode(index, _element) {
    const ep = currentEpisodes[index];
    if (!ep) return;
    currentEpisodeIndex = index;
    const epFilter = document.getElementById('wpEpFilter');
    if (epFilter) epFilter.value = '';
    renderEpisodeList();
    activeStreamIndex = 0;
    currentStreams = [];
    if (currentAnimeId) {
        const cid = stripSourcePrefix(currentAnimeId);
        storeIdMapping(cid, currentAnimeId);
        setRoute(`/watch/${encodeURIComponent(cid)}/ep-${encodeURIComponent(String(ep.number))}`);
    }
    const vc = document.getElementById('videoContainer');
    document.getElementById('playerStatus').innerText = `Loading EP ${ep.number}`;
    vc.innerHTML = `<div class="player-empty">Loading episode ${esc(ep.number)}…</div>`;

    // Save watch progress
    const detail = currentAnimeDetail;
    if (detail) {
        saveWatchProgress(
            stripSourcePrefix(currentAnimeId || detail.id),
            ep.number,
            displayTitle(detail),
            posterSrc(detail.poster, displayTitle(detail)),
            detail.malId
        );
    }

    // Load comments for this episode
    const commentSection = document.getElementById('watchCommentsSection');
    if (commentSection) {
        const commentsForm = document.getElementById('commentsForm');
        if (commentsForm) commentsForm.style.display = currentUser ? '' : 'none';
        fetchComments(currentAnimeId || currentMalId || id, ep.number);
    }

    try {
        // Route to correct streaming source based on currentServer
        let streamKey;
        if (currentServer === 'animepulse') {
            streamKey = currentAnimepulseId ? `animepulse:${currentAnimepulseId}` : currentAnimeDetail?.animepulseId || currentAnimeDetail?.id;
        } else if (currentServer === 'senshi') {
            streamKey = currentMalId || currentAnimeDetail?.malId;
        } else {
            streamKey = currentAnimeDetail?.id || currentMalId || currentAnimeDetail?.malId;
        }
        if (!streamKey) throw new Error('Missing ID for stream lookup');

        const epParam = String(streamKey).startsWith('gogo:') && ep.id ? ep.id : ep.number;
        const stream = await apiFetch(`${API_BASE}/stream?malId=${encodeURIComponent(streamKey)}&ep=${encodeURIComponent(epParam)}&lang=${encodeURIComponent(currentLang)}`);
        console.log(`[playEpisode] server=${currentServer} lang=${currentLang} selected_status=${stream?.status} streams=`, stream?.streams?.map(s=>s.status));
        if (!stream?.url && !stream?.sources?.length) throw new Error('No stream URL returned');

        document.getElementById('playerStatus').innerText = `EP ${ep.number}`;

        // Use the preferred source matching stream.status, or stream.url
        const preferred = stream.sources?.find(s => s.quality === stream.status) || stream.sources?.[0];
        if (preferred) {
            renderStream(preferred);
        } else {
            renderStream({ url: stream.url, isM3U8: stream.type === 'hls', quality: stream.status || 'default', headers: stream.headers || {} });
        }
    } catch (e) {
        console.error(e);
        showPlayerUnavailable(currentAnimeDetail, 'This episode could not be opened. Try another episode or come back later.');
    }
}

function syncStripToggles() {
    const sn = document.getElementById('stripAutoNext');
    const sp = document.getElementById('stripAutoPlay');
    const ss = document.getElementById('stripAutoSkip');
    if (sn) sn.checked = !!playerSettings.autoNext;
    if (sp) sp.checked = !!playerSettings.autoPlay;
    if (ss) ss.checked = !!playerSettings.autoSkip;
}

function prevEpisode() {
    const ni  = currentEpisodeIndex - 1;
    if (ni < 0) return;
    const nel = document.querySelectorAll('.episode-item')[ni];
    playEpisode(ni, nel || null);
}

function nextEpisode() {
    const ni  = currentEpisodeIndex + 1;
    if (ni >= currentEpisodes.length) return;
    const nel = document.querySelectorAll('.episode-item')[ni];
    playEpisode(ni, nel || null);
}

function toggleFocusMode() {
    const player = document.getElementById('videoPlayer');
    if (!player) return;
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        player.requestFullscreen?.();
    }
}

// ─── Stream renderer ──────────────────────────────────────────────────────────
let currentStreams = []; // multi-source support
let activeStreamIndex = 0;

function restoreSeek(video) {
    if (pendingSeekTime > 0) {
        video.currentTime = pendingSeekTime;
        pendingSeekTime = -1;
    }
}

function waitForHls(ms = 5000) {
    return new Promise(r => {
        if (typeof Hls !== 'undefined') return r(true);
        const t = Date.now(), c = setInterval(() => {
            if (typeof Hls !== 'undefined') { clearInterval(c); r(true); }
            else if (Date.now() - t > ms) { clearInterval(c); r(false); }
        }, 50);
    });
}

async function renderStream(stream) {
    destroyHls();
    const vc = document.getElementById('videoContainer');
    if (!vc) return;

    // Server already returns proxied URLs for HLS streams (e.g. /api/media?url=...)
    // Trust the isM3U8 flag rather than trying to detect from the URL
    const isM3U8 = stream.isM3U8 !== false;
    const playUrl = stream.url;

    vc.innerHTML = buildPlayerHtml();
    const video  = document.getElementById('animeVideo');
    activeVideo  = video;

    function showLoading(show) {
        const el = document.getElementById('playerLoading');
        if (el) el.classList.toggle('visible', show);
    }

    if (isM3U8) {
        await waitForHls();
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            const hls = new Hls({ maxBufferLength: 30, enableWorker: false });
            activeHls = hls;
            hls.loadSource(playUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                showLoading(false);
                restoreSeek(video);
                if (playerSettings.autoPlay) video.play().catch(() => {});
            });
            hls.on(Hls.Events.ERROR, (_, data) => {
                if (data.fatal) { console.error('HLS fatal error', data.type, data.details); hls.destroy(); activeHls = null; }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = playUrl;
            video.addEventListener('canplay', () => { showLoading(false); restoreSeek(video); if (playerSettings.autoPlay) video.play().catch(() => {}); }, { once: true });
        } else {
            vc.innerHTML = '<div class="player-empty">This browser cannot play HLS streams. Try using a different browser or download the episode.</div>';
            return;
        }
    } else {
        video.src = playUrl;
        video.addEventListener('canplay', () => {
            showLoading(false);
            restoreSeek(video);
            if (playerSettings.autoPlay) video.play().catch(() => {});
        }, { once: true });
    }
    attachVideoControls(video);
}

function buildPlayerHtml() {
    return `
    <div class="video-player" id="videoPlayer">
        <video id="animeVideo" playsinline></video>
        <div class="player-loading" id="playerLoading">
            <div class="player-spinner"></div>
        </div>
        <div class="player-center-icon" id="playerCenterIcon"></div>
        <div class="video-controls" id="videoControls">
            <div class="progress-wrap" id="progressWrap">
                <div class="progress-bg">
                    <div class="progress-buffer" id="progressBuffer"></div>
                    <div class="progress-fill"   id="progressFill"></div>
                    <div class="skip-markers"    id="skipMarkers"></div>
                </div>
            </div>
            <div class="controls-row">
                <div class="controls-left">
                    <button class="ctrl-btn" id="rewindBtn"  title="-10s">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22">
                            <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.48"/>
                        </svg>
                    </button>
                    <button class="ctrl-btn play-btn" id="playToggle">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26"><polygon points="5 3 19 12 5 21"/></svg>
                    </button>
                    <button class="ctrl-btn" id="forwardBtn" title="+10s">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22">
                            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.48-3.48"/>
                        </svg>
                    </button>
                    <button class="ctrl-btn" id="nextEpBtn" title="Next episode">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                            <polygon points="5 4 15 12 5 20"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.5"/>
                        </svg>
                    </button>
                    <span class="time-label"><span id="currentTime">0:00</span> / <span id="durationLabel">0:00</span></span>
                </div>
                <div class="controls-right">
                    <button class="ctrl-btn skip-segment-btn" id="skipSegmentBtn" style="display:none">Skip Intro</button>
                    <div class="settings-wrap">
                        <button class="ctrl-btn" id="settingsBtn" title="Settings">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                                <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                            </svg>
                        </button>
                        <div class="settings-panel" id="settingsPanel">
                            <div class="settings-section">
                                <div class="settings-label">Speed</div>
                                <div class="settings-list" id="speedOptions">
                                    <button class="settings-opt active" data-speed="1">1x</button>
                                    <button class="settings-opt" data-speed="0.5">0.5x</button>
                                    <button class="settings-opt" data-speed="1.25">1.25x</button>
                                    <button class="settings-opt" data-speed="1.5">1.5x</button>
                                    <button class="settings-opt" data-speed="2">2x</button>
                                    <button class="settings-opt" data-speed="3">3x</button>
                                </div>
                            </div>
                            <div class="settings-section">
                                <div class="settings-label">Quality</div>
                                <div class="settings-list" id="qualityOptions">
                                    <button class="settings-opt active" data-level="-1">Auto</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <button class="ctrl-btn" id="fullscreenToggle" title="Fullscreen">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    </div>`;
}

function attachVideoControls(video) {
    const player    = document.getElementById('videoPlayer');
    const playBtn   = document.getElementById('playToggle');
    const fwdBtn    = document.getElementById('forwardBtn');
    const rwdBtn    = document.getElementById('rewindBtn');
    const nextBtn   = document.getElementById('nextEpBtn');
    const fsBtn     = document.getElementById('fullscreenToggle');
    const pWrap     = document.getElementById('progressWrap');
    const pFill     = document.getElementById('progressFill');
    const pBuf      = document.getElementById('progressBuffer');
    const timeCur   = document.getElementById('currentTime');
    const timeDur   = document.getElementById('durationLabel');
    const skipBtn   = document.getElementById('skipSegmentBtn');
    const setBtn    = document.getElementById('settingsBtn');
    const setPanel  = document.getElementById('settingsPanel');
    if (!player) return;

    // Show/hide controls + center icon + cursor with 3s idle timeout
    const ctrlEl = document.querySelector('.video-controls');
    let idleTimer;
    const hideAll = () => {
        player.classList.remove('controls-active');
        if (ctrlEl) ctrlEl.style.opacity = '0';
        const ci = document.getElementById('playerCenterIcon'); if (ci) ci.classList.remove('show');
        player.style.cursor = 'none';
    };
    const onActivity = () => {
        player.classList.add('controls-active');
        if (ctrlEl) ctrlEl.style.opacity = '';
        player.style.cursor = 'auto';
        const ci = document.getElementById('playerCenterIcon');
        if (ci) { ci.innerHTML = video.paused ? PLAY : PAUSE; ci.classList.add('show'); }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(hideAll, 3000);
    };
    player.addEventListener('mousemove', onActivity);
    player.addEventListener('mouseleave', () => { clearTimeout(idleTimer); if (!video.paused) hideAll(); });
    player.addEventListener('click', onActivity);
    const ciEl = document.getElementById('playerCenterIcon');
    ciEl?.addEventListener('click', () => {
        if (video.paused) video.play().catch(()=>{});
        else video.pause();
    });

    // Touch: show center icon on tap, toggle controls
    let lastTap = 0, lastTapX = 0;
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    player.addEventListener('touchend', (e) => {
        if (e.target.closest('.ctrl-btn') || e.target.closest('.progress-wrap') || e.target.closest('.settings-panel') || e.target.closest('.player-center-icon')) return;
        const now = Date.now();
        const dx = e.changedTouches[0].clientX;
        const dt = now - lastTap;
        // Double-tap seek on mobile
        if (isMobile && dt < 300 && dt > 30) {
            const rect = player.getBoundingClientRect();
            if (dx > rect.left + rect.width / 2) {
                video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
            } else {
                video.currentTime = Math.max(0, video.currentTime - 5);
            }
            lastTap = 0;
            return;
        }
        lastTap = now;
        lastTapX = dx;
        updateCenterIcon();
        setTimeout(hideCenterIcon, 800);
        if (player.classList.contains('controls-active')) {
            player.classList.remove('controls-active');
            if (ctrlEl) ctrlEl.style.opacity = '0';
            clearTimeout(timer);
        } else {
            player.classList.add('controls-active');
            if (ctrlEl) ctrlEl.style.opacity = '';
            clearTimeout(timer);
            if (!video.paused) timer = setTimeout(() => { player.classList.remove('controls-active'); if (ctrlEl) ctrlEl.style.opacity = '0'; }, 4000);
        }
    }, { passive: true });

    // Play / pause icons
    const PLAY  = `<svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26"><polygon points="5 3 19 12 5 21"/></svg>`;
    const PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

    function flashCenterIcon(icon) {
        const el = document.getElementById('playerCenterIcon');
        if (!el) return;
        el.innerHTML = icon;
        el.classList.add('show');
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.classList.remove('show'), 600);
    }
    playBtn?.addEventListener('click', () => {
        if (video.paused) video.play().catch(()=>{});
        else video.pause();
    });
    video.addEventListener('play',  () => { if (playBtn) playBtn.innerHTML = PAUSE; showCtrl(); });
    video.addEventListener('pause', () => { if (playBtn) playBtn.innerHTML = PLAY;  showCtrl(); });

    rwdBtn?.addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
    fwdBtn?.addEventListener('click', () => { video.currentTime = Math.min(video.duration||Infinity, video.currentTime + 10); });
    nextBtn?.addEventListener('click', nextEpisode);

    // Settings panel toggle
    function populateQualityOptions() {
        const ql = document.getElementById('qualityOptions');
        if (!ql || !activeHls) return;
        const levels = activeHls.levels;
        if (!levels || !levels.length) return;
        const cur = activeHls.currentLevel;
        const names = ['Auto', ...levels.map(l => `${l.height}p`)];
        ql.innerHTML = names.map((n, i) =>
            `<button class="settings-opt${(i - 1 === cur || (cur === -1 && i === 0)) ? ' active' : ''}" data-level="${i - 1}">${n}</button>`
        ).join('');
    }
    function closeSettings() { if (setPanel) setPanel.classList.remove('open'); }
    setBtn?.addEventListener('click', e => {
        e.stopPropagation();
        if (!setPanel) return;
        const opening = !setPanel.classList.contains('open');
        closeSettings();
        if (opening) {
            populateQualityOptions();
            setPanel.classList.add('open');
        }
    });
    document.addEventListener('click', closeSettings);
    setPanel?.addEventListener('click', e => e.stopPropagation());

    // Settings option clicks
    function applySpeed(speed) {
        const s = parseFloat(speed);
        if (isNaN(s) || !video) return;
        video.playbackRate = s;
        document.querySelectorAll('#speedOptions .settings-opt').forEach(b => b.classList.toggle('active', Math.abs(parseFloat(b.dataset.speed) - s) < 0.01));
    }
    function applyQuality(level) {
        const l = parseInt(level, 10);
        if (isNaN(l) || typeof Hls === 'undefined' || !activeHls) return;
        activeHls.currentLevel = l;
        document.querySelectorAll('#qualityOptions .settings-opt').forEach(b => b.classList.toggle('active', parseInt(b.dataset.level, 10) === l));
    }
    document.getElementById('speedOptions')?.addEventListener('click', e => {
        const b = e.target.closest('.settings-opt[data-speed]');
        if (b) applySpeed(b.dataset.speed);
    });
    document.getElementById('qualityOptions')?.addEventListener('click', e => {
        const b = e.target.closest('.settings-opt[data-level]');
        if (b) applyQuality(b.dataset.level);
    });

    fsBtn?.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else player.requestFullscreen?.();
    });

    function seekFromEvent(clientX) {
        if (!video.duration || !pWrap) return;
        const r = pWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        video.currentTime = pct * video.duration;
        if (pFill) pFill.style.width = `${pct * 100}%`;
    }
    let seeking = false;
    pWrap?.addEventListener('mousedown', e => { e.preventDefault(); seeking = true; seekFromEvent(e.clientX); });
    document.addEventListener('mousemove', e => { if (seeking) seekFromEvent(e.clientX); });
    document.addEventListener('mouseup', () => { seeking = false; });
    pWrap?.addEventListener('touchstart', e => seekFromEvent(e.touches[0].clientX), { passive: true });
    pWrap?.addEventListener('touchmove', e => { e.preventDefault(); seekFromEvent(e.touches[0].clientX); }, { passive: false });
    // Hover preview on timeline
    const previewEl = document.createElement('span');
    previewEl.className = 'progress-preview';
    pWrap?.appendChild(previewEl);
    function updatePreview(clientX) {
        if (!video.duration || !pWrap) return;
        const r = pWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        previewEl.style.left = `${pct * 100}%`;
        previewEl.textContent = fmtTime(pct * video.duration);
        previewEl.style.display = '';
    }
    pWrap?.addEventListener('mousemove', e => updatePreview(e.clientX));
    pWrap?.addEventListener('mouseleave', () => { previewEl.style.display = 'none'; });
    pWrap?.addEventListener('touchmove', e => updatePreview(e.touches[0].clientX), { passive: true });

    skipBtn?.addEventListener('click', () => {
        const seg = currentSkipSegments.find(s => video.currentTime >= s.start && video.currentTime < s.end);
        if (seg) video.currentTime = seg.end;
    });

    video.addEventListener('timeupdate', () => {
        const d = video.duration || 0;
        if (timeCur) timeCur.innerText = fmtTime(video.currentTime);
        if (pFill)   pFill.style.width = d ? `${(video.currentTime/d)*100}%` : '0%';
        handleSkipState(video);
    });
    syncStripToggles();
    video.addEventListener('progress', () => {
        if (!video.duration || !video.buffered.length) return;
        const end = video.buffered.end(video.buffered.length - 1);
        if (pBuf) pBuf.style.width = `${Math.min(100,(end/video.duration)*100)}%`;
    });
    video.addEventListener('loadedmetadata', () => {
        if (timeDur) timeDur.innerText = fmtTime(video.duration);
        const epNum = currentEpisodes[currentEpisodeIndex]?.number;
        loadSkipSegments(epNum, video.duration);
    });
    video.addEventListener('ended', () => { if (playerSettings.autoNext) nextEpisode(); });

    // Loading overlay on buffering
    function buffering(b) {
        const el = document.getElementById('playerLoading');
        if (el) el.classList.toggle('visible', b);
    }
    video.addEventListener('waiting', () => buffering(true));
    video.addEventListener('playing',  () => buffering(false));
    video.addEventListener('canplay',  () => buffering(false));

}

// ─── Skip segments ────────────────────────────────────────────────────────────
async function loadSkipSegments(epNum, dur) {
    currentSkipSegments = []; skippedSegmentKeys = new Set();
    const ep = currentEpisodes[currentEpisodeIndex];

    // Use Senshi intro/outro data if available
    if (ep?.intro_start != null && ep?.intro_end != null) {
        currentSkipSegments.push({ id: 'intro-senshi', type: 'Intro', start: Number(ep.intro_start), end: Number(ep.intro_end) });
    }
    if (ep?.outro_start != null && ep?.outro_end != null) {
        currentSkipSegments.push({ id: 'outro-senshi', type: 'Outro', start: Number(ep.outro_start), end: Number(ep.outro_end) });
    }
    // Filter valid segments
    currentSkipSegments = currentSkipSegments.filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);

    // If no Senshi data, fallback to aniskip API
    const malId = currentMalId || currentAnimeDetail?.malId;
    if (!currentSkipSegments.length && malId) {
    try {
        const url = new URL(`https://api.aniskip.com/v2/skip-times/${malId}/${epNum}`);
        ['op','ed'].forEach(t => url.searchParams.append('types', t));
        url.searchParams.set('episodeLength', Math.round(dur || 0));
        const data = await (await fetch(url)).json();
        currentSkipSegments = (data.found && Array.isArray(data.results) ? data.results : [])
            .filter(i => i?.interval)
            .map((i, idx) => ({
                id: i.skipId||`${i.skipType}-${idx}`,
                type: i.skipType === 'ed' ? 'Outro' : 'Intro',
                start: Number(i.interval.startTime),
                end  : Number(i.interval.endTime)
            }))
            .filter(i => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start);
        // Draw markers
        const markers = document.getElementById('skipMarkers');
        if (markers && currentSkipSegments.length && dur) {
            markers.innerHTML = currentSkipSegments.map(s => {
                const l = (s.start/dur)*100, w = ((s.end-s.start)/dur)*100;
                return `<span class="skip-marker ${s.type.toLowerCase()}" style="left:${l}%;width:${w}%"></span>`;
            }).join('');
        }
    } catch { /* optional */ }
    }
}

function handleSkipState(video) {
    const btn = document.getElementById('skipSegmentBtn');
    if (!btn) return;
    const seg = currentSkipSegments.find(s => video.currentTime >= s.start && video.currentTime < s.end);
    if (!seg) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    btn.innerText = `Skip ${seg.type}`;
    const key = `${seg.id}-${Math.floor(seg.start)}`;
    if (playerSettings.autoSkip && !skippedSegmentKeys.has(key)) {
        skippedSegmentKeys.add(key);
        video.currentTime = seg.end;
        btn.style.display = 'none';
    }
}

// ─── Player controls ──────────────────────────────────────────────────────────
function destroyHls() {
    if (activeHls) { activeHls.destroy(); activeHls = null; }
    activeVideo = null;
    currentSkipSegments = [];
    skippedSegmentKeys  = new Set();
}
function showPlayerUnavailable(anime, msg) {
    document.getElementById('playerStatus').innerText   = 'Unavailable';
    document.getElementById('episodesCount').innerText  = '0';
    document.getElementById('episodesList').innerHTML   = `<div class="player-empty">${esc(msg)}</div>`;
    document.getElementById('videoContainer').innerHTML = `
        <div class="player-empty player-empty-card">
            <strong>Stream unavailable</strong>
            <span>${esc(msg)}</span>
        </div>`;
}
function closePlayer() {
    destroyHls();
    document.getElementById('videoContainer').innerHTML = '';
    if (lastDetailPageId) viewAnimeDetails(lastDetailPageId);
    else switchTab('home');
}
function goHome() { switchTab('home'); }

function toggleNav() {
    document.getElementById('navbar').classList.toggle('nav-open');
}
document.addEventListener('click', e => {
    if (!e.target.closest('.navbar')) {
        document.getElementById('navbar')?.classList.remove('nav-open');
    }
});

// ─── Router ───────────────────────────────────────────────────────────────────
function loadRoute() {
    const p = location.pathname;

    // Anime detail page
    const animeMatch = p.match(/^\/anime\/(.+)$/);
    if (animeMatch) {
        const raw = decodeURIComponent(animeMatch[1]);
        const id = resolveId(raw);
        if (id) { viewAnimeDetails(id); return; }
    }

    // Watch page
    const watchMatch = p.match(/^\/watch\/([^/]+)\/ep-(.+)$/);
    if (watchMatch) {
        const raw = decodeURIComponent(watchMatch[1]);
        const id = resolveId(raw);
        const ep = watchMatch[2];
        if (id) { startStreaming(id, 'sub'); return; }
    }

    if (/^\/trending/i.test(p))  return switchTab('trending', false);
    if (/^\/seasonal/i.test(p))  return switchTab('seasonal', false);
    if (/^\/schedule/i.test(p))  return switchTab('schedule', false);
    if (/^\/search/i.test(p))    return switchTab('search',   false);
    return switchTab('home', false);
}
window.addEventListener('popstate', loadRoute);
window.addEventListener('unhandledrejection', () => hideLoading());
document.addEventListener('DOMContentLoaded', () => {
    hideLoading();
    loadRoute();
    checkAuth();
    initSidebarGenres();
    // Auth button — toggle user menu on click when logged in
    document.getElementById('authBtn')?.addEventListener('click', e => {
        if (currentUser) {
            e.preventDefault();
            const menu = document.getElementById('userMenu');
            if (menu) {
                const shown = menu.style.display !== 'none';
                menu.style.display = shown ? 'none' : 'block';
            }
        }
    });
    // Close user menu on outside click
    document.addEventListener('click', e => {
        const menu = document.getElementById('userMenu');
        if (menu && !e.target.closest('#authBtn') && !e.target.closest('.user-menu')) {
            menu.style.display = 'none';
        }
    });
    // Close auth modal on Escape
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (document.getElementById('authModal')?.classList.contains('active')) {
                closeAuthModal();
            }
        }
    });
    // Global tooltip — positioned near trigger, no mouse-follow
    let tipTimer = null;
    let tipLastId = null;
    const tip = document.getElementById('globalTooltip');
    document.addEventListener('mouseover', e => {
        const trigger = e.target.closest('.card-info-trigger');
        if (!trigger) return;
        const id = trigger.dataset.id;
        if (id === tipLastId) return;
        tipLastId = id;
        clearTimeout(tipTimer);
        const anime = id ? animeDetailCache.get(id) : null;
        if (!anime) return;
        const title = displayTitle(anime);
        const genres = clean(anime.genres) || '';
        const studio = clean(anime.studios) || '';
        const synopsis = clean((anime.overview||'').slice(0,200)) || '';
        tip.innerHTML = `<strong>${esc(title)}</strong>${
            genres ? `<div class="tip-row"><span>Genres:</span> ${esc(genres)}</div>` : ''
        }${studio ? `<div class="tip-row"><span>Studio:</span> ${esc(studio)}</div>` : ''
        }${synopsis ? `<div class="tip-row"><span>Synopsis:</span> ${esc(synopsis)}${anime.overview?.length > 200 ? '…' : ''}</div>` : ''}`;
        positionTipNear(trigger, tip);
        tip.style.display = 'block';
    });
    document.addEventListener('mouseout', e => {
        tipLastId = null;
        const trigger = e.target.closest('.card-info-trigger');
        if (!trigger) return;
        const related = e.relatedTarget ? e.relatedTarget.closest('.card-info-trigger') : null;
        if (related !== trigger) {
            tipTimer = setTimeout(hideTooltip, 150);
        }
    });
    function positionTipNear(trigger, el) {
        const tr = trigger.getBoundingClientRect();
        const ew = el.offsetWidth;
        const eh = el.offsetHeight;
        let x = tr.right + 10;
        let y = tr.top - eh / 2 + tr.height / 2;
        if (x + ew > window.innerWidth - 10) x = tr.left - ew - 10;
        if (y < 10) y = 10;
        if (y + eh > window.innerHeight - 10) y = window.innerHeight - eh - 10;
        el.style.left = x + 'px';
        el.style.top  = y + 'px';
    }

    // Cinema bar (strip) controls — wired once since elements are static
    syncStripToggles();
    document.getElementById('focusBtn')?.addEventListener('click', toggleFocusMode);
    document.getElementById('prevEpBtn')?.addEventListener('click', prevEpisode);
    document.getElementById('cinemaNextBtn')?.addEventListener('click', nextEpisode);
    document.getElementById('stripAutoNext')?.addEventListener('change', e => {
        playerSettings.autoNext = e.target.checked; saveSettings();
    });
    document.getElementById('stripAutoPlay')?.addEventListener('change', e => {
        playerSettings.autoPlay = e.target.checked; saveSettings();
    });
    document.getElementById('stripAutoSkip')?.addEventListener('change', e => {
        playerSettings.autoSkip = e.target.checked; saveSettings();
    });
    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        const w = document.querySelector('.watch-page');
        if (!w?.classList.contains('active')) return;
        const v = activeVideo;
        if (!v) return;

        if (e.key === 'Escape') {
            if (document.getElementById('episodeModal')?.classList.contains('active')) { e.preventDefault(); closeEpisodeModal(); return; }
            if (document.fullscreenElement) { e.preventDefault(); document.exitFullscreen(); return; }
            return;
        }
        if (e.key === 'ArrowRight') { e.preventDefault(); v.currentTime = Math.min(v.duration||Infinity, v.currentTime + 5); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); }
        else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); v.muted = !v.muted; }
        else if (e.key === 's' || e.key === 'S') { e.preventDefault(); document.getElementById('skipSegmentBtn')?.click(); }
        else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); nextEpisode(); }
        else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); prevEpisode(); }
    });
});
function hideTooltip() {
    const tip = document.getElementById('globalTooltip');
    if (tip) tip.style.display = 'none';
}