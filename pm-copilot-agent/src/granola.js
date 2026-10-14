/* Granola public API (https://docs.granola.ai). Bearer API key; 5 req/s sustained. */
const cfg = require('./config').granola;

async function call(pathname, params = {}) {
  if (!cfg.apiKey) throw new Error('GRANOLA_API_KEY is not set');
  const url = new URL(cfg.baseUrl + pathname);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' } });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`Granola ${pathname} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error('Granola rate limit: gave up after 3 attempts');
}

/* Every note created or updated after `since` (ISO), newest pages first, all pages. */
async function listNotes(since) {
  const out = []; let cursor = null;
  do {
    const page = await call('/v1/notes', { updated_after: since, folder_id: cfg.folderId, page_size: 30, cursor });
    out.push(...(page.notes || []).filter(n => !n.deleted_at));
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return out;
}

async function getNote(id) { return call(`/v1/notes/${encodeURIComponent(id)}`, { include: 'transcript' }); }

/* Granola note → the agent's neutral meeting shape. Transcript is folded to "Speaker: text". */
function toMeeting(note) {
  const ev = note.calendar_event || {};
  const transcript = Array.isArray(note.transcript)
    ? note.transcript.map(t => `${(t.speaker && (t.speaker.name || t.speaker.source)) || t.source || 'Speaker'}: ${t.text || ''}`).join('\n')
    : '';
  const parts = [
    note.summary_markdown || note.summary_text ? `## Granola summary\n${note.summary_markdown || note.summary_text}` : '',
    note.private_notes_markdown || note.private_notes_text ? `## Note-taker's notes\n${note.private_notes_markdown || note.private_notes_text}` : '',
    transcript ? `## Transcript\n${transcript}` : '',
  ].filter(Boolean);
  return {
    source: 'granola', sourceId: note.id, url: note.web_url || null,
    title: (note.title || 'Untitled meeting').trim(),
    date: ev.start_time || ev.start || note.created_at,
    attendees: (note.attendees || []).map(a => ({ name: a.name || a.email, email: a.email || null })),
    owner: note.owner ? (note.owner.name || note.owner.email) : null,
    notesText: parts.join('\n\n'),
    updatedAt: note.updated_at,
  };
}

const wanted = (title) => !cfg.titleFilter.length || cfg.titleFilter.some(w => (title || '').toLowerCase().includes(w));

module.exports = { listNotes, getNote, toMeeting, wanted, configured: () => !!cfg.apiKey };
