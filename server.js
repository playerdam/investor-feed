import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(cookieParser());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function requireAuth(req, res, next) {
  const token = req.cookies?.sb_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Ikke logget ind' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Ugyldig session' });
  req.user = user;
  next();
}

// ── Auth ─────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email og password kræves' });
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Tjek din email for bekræftelse', user: data.user });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Forkert email eller password' });
  res.cookie('sb_token', data.session.access_token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000
  });
  res.json({ user: { email: data.user.email, id: data.user.id } });
});

app.post('/api/logout', (req, res) => { res.clearCookie('sb_token'); res.json({ ok: true }); });
app.get('/api/me', requireAuth, (req, res) => res.json({ user: { email: req.user.email, id: req.user.id } }));

// ── Chart data (Yahoo Finance) ────────────────────────────────────
const RANGE_MAP = { '1D':'1d', '1W':'5d', '1M':'1mo', '3M':'3mo', '1Y':'1y' };
const INTERVAL_MAP = { '1D':'5m', '1W':'60m', '1M':'1d', '3M':'1d', '1Y':'1wk' };

app.get('/api/chart/:ticker', requireAuth, async (req, res) => {
  const { ticker } = req.params;
  const range = RANGE_MAP[req.query.range] || '5d';
  const interval = INTERVAL_MAP[req.query.range] || '60m';

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=false`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'Ticker ikke fundet' });

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const meta = result.meta || {};

    const points = timestamps.map((t, i) => ({
      t: t * 1000,
      v: closes[i] != null ? +closes[i].toFixed(4) : null
    })).filter(p => p.v !== null);

    res.json({
      ticker: meta.symbol,
      currency: meta.currency,
      price: meta.regularMarketPrice,
      prevClose: meta.chartPreviousClose,
      exchange: meta.exchangeName,
      points
    });
  } catch (e) {
    console.error('Chart fejl:', e);
    res.status(500).json({ error: 'Kunne ikke hente kursdata' });
  }
});

// ── News (Anthropic + web search) ────────────────────────────────
app.post('/api/news', requireAuth, async (req, res) => {
  const { tickers, category, systemPrompt } = req.body;
  if (!tickers?.length) return res.status(400).json({ error: 'Ingen tickers' });

  const prompt = `${systemPrompt}

Aktiver/emner: ${tickers.join(', ')}

Returner KUN et JSON-array (ingen markdown, ingen backticks) med max 10 nyheder sorteret efter investeringsrelevans:
[{
  "ticker": "TICKER",
  "headline": "Overskrift på dansk (max 15 ord)",
  "summary": "2-3 sætninger investoranalyse på dansk",
  "impact": "HIGH" | "MEDIUM" | "LOW",
  "sentiment": "bullish" | "bearish" | "neutral",
  "timeAgo": "fx '3 timer siden'",
  "source": "fx Reuters"
}]

Impact-kriterier:
- HIGH: Direkte kurspåvirkning, earnings, policyændringer
- MEDIUM: Sektortrends, analytikervurderinger
- LOW: Baggrundsinformation`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    let jsonText = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text' && block.text?.includes('[')) { jsonText = block.text; break; }
    }
    const s = jsonText.indexOf('['), e = jsonText.lastIndexOf(']');
    res.json({ articles: JSON.parse(jsonText.slice(s, e + 1)) });
  } catch (e) {
    console.error('News fejl:', e);
    res.status(500).json({ error: 'Kunne ikke hente nyheder' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kører på http://localhost:${PORT}`));
