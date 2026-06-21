// Frontend logic for the typeahead UI.
//
// Key behaviours required by the assignment:
//   - debounced /suggest calls (avoid a backend hit on every keystroke)
//   - keyboard navigation of the dropdown (↑ ↓ Enter Esc)
//   - search submission on Enter / button, showing the dummy API response
//   - a trending section, live metrics, and loading + error states.

const $ = (id) => document.getElementById(id);
const input = $('search');
const list = $('suggestions');
const spinner = $('spinner');
const statusEl = $('status');
const resultEl = $('result');
const resultBody = $('resultBody');

let mode = 'basic';
let activeIndex = -1; // highlighted suggestion for keyboard nav
let currentItems = [];
let lastReqId = 0; // guards against out-of-order responses

// ---- Debounce: wait until the user pauses typing before calling the backend ----
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function setLoading(on) {
  spinner.hidden = !on;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', isError);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function highlightPrefix(query, prefix) {
  const safe = escapeHtml(query);
  if (!prefix) return safe;
  // The backend guarantees suggestions start with the prefix (case-insensitive).
  return `<b>${safe.slice(0, prefix.length)}</b>${safe.slice(prefix.length)}`;
}

function renderSuggestions(prefix, items) {
  currentItems = items;
  activeIndex = -1;
  if (!prefix) {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    return;
  }
  if (items.length === 0) {
    list.innerHTML = '<li class="empty">No suggestions for “' + escapeHtml(prefix) + '”</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    return;
  }
  list.innerHTML = items
    .map((it, i) => {
      const scoreBit =
        mode === 'recency'
          ? `<span class="rank-score">score ${it.score}</span> · `
          : '';
      return `<li role="option" data-i="${i}" data-q="${escapeHtml(it.query)}">
        <span class="q">${highlightPrefix(it.query, prefix)}</span>
        <span class="meta">${scoreBit}${Number(it.count).toLocaleString()} searches</span>
      </li>`;
    })
    .join('');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function setActive(i) {
  const lis = [...list.querySelectorAll('li[data-i]')];
  if (lis.length === 0) return;
  activeIndex = (i + lis.length) % lis.length;
  lis.forEach((li, idx) => li.classList.toggle('active', idx === activeIndex));
  lis[activeIndex].scrollIntoView({ block: 'nearest' });
}

// ---- Fetch suggestions (debounced) ----
const fetchSuggestions = debounce(async (q) => {
  const reqId = ++lastReqId;
  if (!q.trim()) {
    renderSuggestions('', []);
    setStatus('');
    return;
  }
  setLoading(true);
  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(q)}&mode=${mode}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (reqId !== lastReqId) return; // a newer keystroke already won
    renderSuggestions(data.prefix, data.suggestions || []);
    setStatus(
      `${data.suggestions.length} suggestion(s) · served from ${
        data.source === 'cache' ? 'cache ⚡' : 'index'
      }`,
    );
    paintSource(data.source);
  } catch (err) {
    if (reqId !== lastReqId) return;
    setStatus(`Could not load suggestions: ${err.message}`, true);
    list.hidden = true;
  } finally {
    if (reqId === lastReqId) setLoading(false);
  }
}, 120);

// ---- Submit a search ----
async function submitSearch(query) {
  const q = (query ?? input.value).trim();
  if (!q) return;
  input.value = q;
  list.hidden = true;
  setLoading(true);
  setStatus('Submitting…');
  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    resultBody.textContent = JSON.stringify(data);
    resultEl.hidden = false;
    setStatus('Search recorded — it will surface in suggestions/trending after the next batch flush.');
    // Give the buffer a beat to flush, then refresh trending + metrics.
    setTimeout(() => { loadTrending(); loadMetrics(); }, 600);
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, true);
  } finally {
    setLoading(false);
  }
}

// ---- Keyboard navigation ----
input.addEventListener('keydown', (e) => {
  const open = !list.hidden && currentItems.length > 0;
  switch (e.key) {
    case 'ArrowDown':
      if (open) { e.preventDefault(); setActive(activeIndex + 1); }
      break;
    case 'ArrowUp':
      if (open) { e.preventDefault(); setActive(activeIndex - 1); }
      break;
    case 'Enter':
      e.preventDefault();
      if (open && activeIndex >= 0) submitSearch(currentItems[activeIndex].query);
      else submitSearch();
      break;
    case 'Escape':
      list.hidden = true;
      activeIndex = -1;
      break;
  }
});

input.addEventListener('input', (e) => fetchSuggestions(e.target.value));

list.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-q]');
  if (li) submitSearch(li.dataset.q);
});

$('searchBtn').addEventListener('click', () => submitSearch());

// Close the dropdown when clicking outside.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) list.hidden = true;
});

// ---- Ranking mode toggle ----
document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    mode = btn.dataset.mode;
    if (input.value.trim()) fetchSuggestions(input.value);
  });
});

// ---- Trending ----
async function loadTrending() {
  try {
    const res = await fetch('/trending');
    const data = await res.json();
    const ol = $('trending');
    if (!data.trending.length) {
      ol.innerHTML = '<li class="hint" style="border:0">No trending activity yet — submit a few searches.</li>';
      return;
    }
    ol.innerHTML = data.trending
      .map(
        (t) => `<li><span class="t-q">${escapeHtml(t.query)}</span>
          <span class="t-score">recency ${t.recency}</span></li>`,
      )
      .join('');
  } catch {
    /* trending is best-effort */
  }
}

$('refreshTrending').addEventListener('click', loadTrending);

// ---- Metrics ----
function paintSource(source) {
  const el = $('m-source');
  el.textContent = source === 'cache' ? 'cache (hit)' : source === 'index' ? 'index (miss)' : '—';
  el.className = source === 'cache' ? 'hit' : 'index';
}

async function loadMetrics() {
  try {
    const res = await fetch('/metrics');
    const m = await res.json();
    $('m-hit').textContent = (m.derived.cacheHitRate * 100).toFixed(1) + '%';
    $('m-p95').textContent = m.latency.p95Ms + ' ms';
    $('m-raw').textContent = Number(m.counters.rawSearches).toLocaleString();
    $('m-writes').textContent = Number(m.counters.aggregatedWrites).toLocaleString();
    $('m-reduction').textContent = m.derived.writeReductionFactor + '×';
  } catch {
    /* metrics are best-effort */
  }
}

// Show which cache node owns the current prefix.
const refreshNode = debounce(async (q) => {
  if (!q.trim()) { $('m-node').textContent = '—'; return; }
  try {
    const res = await fetch(`/cache/debug?prefix=${encodeURIComponent(q)}&mode=${mode}`);
    const d = await res.json();
    $('m-node').textContent = `${d.ownerNode} (${d.status})`;
  } catch { /* ignore */ }
}, 200);
input.addEventListener('input', (e) => refreshNode(e.target.value));

// Initial load + periodic metric refresh.
loadTrending();
loadMetrics();
setInterval(loadMetrics, 4000);
