// Vercel serverless function: /api/analyze?user=<letterboxd username>
// Keys stay here on the server (environment variables), never in the browser.
const TMDB = process.env.TMDB_API_KEY;
const GKEY = process.env.GEMINI_API_KEY;
const GMODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const tag = (s, t) => { const m = s.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>')); return m ? m[1].trim() : ''; };
const top = (arr, n) => { const c = {}; arr.forEach(x => x && (c[x] = (c[x] || 0) + 1));
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count })); };
const tmdb = async (path) => { const r = await fetch('https://api.themoviedb.org/3' + path + (path.includes('?') ? '&' : '?') + 'api_key=' + TMDB); return r.ok ? r.json() : null; };

async function readFeed(user) {
  const r = await fetch(`https://letterboxd.com/${encodeURIComponent(user)}/rss/`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyJoe/1.0)' } });
  if (r.status === 404) throw new Error('Profile not found. Check the username, and make sure the profile is public.');
  if (!r.ok) throw new Error('Letterboxd did not respond. Try again in a minute.');
  const xml = await r.text();
  return xml.split('<item>').slice(1).map(it => ({
    title: tag(it, 'letterboxd:filmTitle'), year: +tag(it, 'letterboxd:filmYear') || null,
    rating: parseFloat(tag(it, 'letterboxd:memberRating')) || null,
    rewatch: tag(it, 'letterboxd:rewatch') === 'Yes', tmdbId: tag(it, 'tmdb:movieId')
  })).filter(f => f.title);
}

async function enrich(f) {
  if (!f.tmdbId) return f;
  const d = await tmdb(`/movie/${f.tmdbId}?append_to_response=credits`);
  if (!d) return f;
  const dir = (d.credits?.crew || []).find(c => c.job === 'Director');
  return { ...f, genres: (d.genres || []).map(g => g.name), countries: (d.production_countries || []).map(c => c.name),
    director: dir?.name || '', runtime: d.runtime || 0, poster: d.poster_path ? 'https://image.tmdb.org/t/p/w342' + d.poster_path : '' };
}

async function askGemini(user, films) {
  const lines = films.map(f => `${f.title} (${f.year}) ${f.rating ? f.rating + '/5' : 'unrated'}${f.rewatch ? ' rewatch' : ''} | ${f.director || '?'} | ${(f.genres || []).join('/')}`).join('\n');
  const prompt = `You are a film recommendation engine. Analyze this Letterboxd user's recent diary (ratings are out of 5).
${lines}

Return ONLY JSON: {"personality":"3-5 word rating personality title","summary":"3 sentences on their taste: genres, directors, eras, moods, rating tendencies, any contradictions","similar":[5 items],"stretch":[5 items]}
Each item: {"title":"","year":0,"director":"","why":"one sentence on why it fits them","likely":"e.g. 4-4.5"}.
"similar" = films closely matching their taste. "stretch" = acclaimed films slightly outside their comfort zone they would likely love. Never recommend films already in the list.`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GKEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }) });
  if (!r.ok) throw new Error('The AI step failed. Check your Gemini key in Vercel settings.');
  const j = await r.json();
  try { return JSON.parse(j.candidates[0].content.parts[0].text.replace(/```json|```/g, '')); }
  catch { throw new Error('The AI gave an unreadable answer. Please try again.'); }
}

module.exports = async (req, res) => {
  try {
    if (!TMDB || !GKEY) throw new Error('Server keys are missing. Add TMDB_API_KEY and GEMINI_API_KEY in Vercel settings.');
    const user = String(req.query.user || '').trim().replace(/[^\w-]/g, '');
    if (!user) throw new Error('Type a Letterboxd username.');
    const feed = await readFeed(user);
    if (!feed.length) throw new Error('No diary entries found. Log a few films on Letterboxd first.');
    const films = await Promise.all(feed.map(enrich));
    const ai = await askGemini(user, films);
    const seen = new Set(films.map(f => f.title.toLowerCase()));
    const withPoster = async (x) => { const s = await tmdb(`/search/movie?query=${encodeURIComponent(x.title)}&year=${x.year || ''}`);
      const hit = s?.results?.[0]; if (!hit || seen.has(hit.title.toLowerCase())) return null;
      return { ...x, title: hit.title, poster: hit.poster_path ? 'https://image.tmdb.org/t/p/w185' + hit.poster_path : '' }; };
    const clean = async (arr) => (await Promise.all((arr || []).map(withPoster))).filter(Boolean);
    const [similar, stretch] = await Promise.all([clean(ai.similar), clean(ai.stretch)]);
    const rated = films.filter(f => f.rating);
    const dist = {}; rated.forEach(f => dist[f.rating] = (dist[f.rating] || 0) + 1);
    const best = [...rated].sort((a, b) => b.rating - a.rating)[0] || films[0];
    res.setHeader('Cache-Control', 's-maxage=1800');
    res.status(200).json({
      count: films.length, hours: Math.round(films.reduce((s, f) => s + (f.runtime || 0), 0) / 60),
      avg: rated.length ? +(rated.reduce((s, f) => s + f.rating, 0) / rated.length).toFixed(2) : null, dist,
      rewatches: films.filter(f => f.rewatch).length,
      genres: top(films.flatMap(f => f.genres || []), 5), countries: top(films.flatMap(f => f.countries || []), 4),
      directors: top(films.map(f => f.director), 4), decades: top(films.map(f => f.year && Math.floor(f.year / 10) * 10 + 's'), 4),
      best, personality: ai.personality, summary: ai.summary, similar, stretch });
  } catch (e) { res.status(400).json({ error: e.message }); }
};
