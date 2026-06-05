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

// ── Auth middleware ───────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.cookies?.sb_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Ikke logget ind' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Ugyldig session' });
  req.user = user;
  next();
}

// ── Auth routes ───────────────────────────────────────────────────
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

// ── Anthropic helper ──────────────────────────────────────────────
async function callAnthropic(prompt, useWebSearch = true) {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  return r.json();
}

// ── Chart data (Finnhub) ─────────────────────────────────────────
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

// Map our range codes to Finnhub resolution + from/to
function finnhubParams(range) {
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  switch(range) {
    case '1D': return { resolution: '30', from: now - DAY, to: now };
    case '1W': return { resolution: '60', from: now - 7 * DAY, to: now };
    case '1M': return { resolution: 'D',  from: now - 30 * DAY, to: now };
    case '3M': return { resolution: 'D',  from: now - 90 * DAY, to: now };
    case '1Y': return { resolution: 'W',  from: now - 365 * DAY, to: now };
    default:   return { resolution: '60', from: now - 7 * DAY, to: now };
  }
}

// Convert ticker to Finnhub format (crypto needs BINANCE: prefix)
function toFinnhubSymbol(ticker) {
  if (ticker.endsWith('-USD')) {
    const coin = ticker.replace('-USD', '');
    return `BINANCE:${coin}USDT`;
  }
  // Danish tickers: NOVO B -> NOVO-B.CO
  if (ticker.endsWith(' B') || ticker.endsWith(' A')) {
    return ticker.replace(' ', '-') + '.CO';
  }
  return ticker;
}

app.get('/api/chart/:ticker', requireAuth, async (req, res) => {
  const { ticker } = req.params;
  const range = req.query.range || '1W';
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'Finnhub API-nøgle mangler' });

  try {
    const symbol = toFinnhubSymbol(ticker);
    const { resolution, from, to } = finnhubParams(range);

    // Get candles
    const candleUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
    const quoteUrl  = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;

    const [candleRes, quoteRes] = await Promise.all([
      fetch(candleUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch(quoteUrl,  { headers: { 'User-Agent': 'Mozilla/5.0' } })
    ]);

    const candles = await candleRes.json();
    const quote   = await quoteRes.json();

    if (candles.s === 'no_data' || !candles.t?.length) {
      return res.status(404).json({ error: 'Ingen kursdata tilgængeligt for ' + ticker });
    }

    const points = candles.t.map((t, i) => ({
      t: t * 1000,
      v: candles.c[i] != null ? +candles.c[i].toFixed(4) : null
    })).filter(p => p.v !== null);

    const isCrypto = ticker.endsWith('-USD');
    const currency = isCrypto ? 'USD' : (ticker.includes('.CO') || ticker.endsWith(' B') || ticker.endsWith(' A') ? 'DKK' : 'USD');

    res.json({
      ticker,
      currency,
      price: quote.c || points.at(-1)?.v,
      prevClose: quote.pc,
      exchange: isCrypto ? 'Crypto' : 'Stock',
      points
    });
  } catch (e) {
    console.error('Chart fejl:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente kursdata' });
  }
});

// ── Ticker search via Yahoo Finance autocomplete ─────────────────
app.get('/api/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    const quotes = (d.quotes || []).filter(q => q.symbol && q.shortname && ['EQUITY','CRYPTOCURRENCY','ETF','MUTUALFUND'].includes(q.quoteType));
    const results = quotes.slice(0, 8).map(q => ({
      ticker: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      exchange: q.exchange || q.quoteType,
      quoteType: q.quoteType,
    }));
    res.json({ results });
  } catch(e) {
    console.error('Search fejl:', e);
    res.json({ results: [] });
  }
});

// ── News (NewsAPI + Claude analyse) ──────────────────────────────
async function fetchNewsAPI(tickers) {
  const cleanTickers = tickers.map(t => t.replace('-USD', '').replace(' B', ''));
  const q = cleanTickers.join(' OR ');
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${process.env.NEWS_API_KEY}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.status !== 'ok') throw new Error('NewsAPI fejl: ' + d.message);
  const arts = (d.articles || []).slice(0, 15);
  // Store URLs for later lookup by title
  global._newsUrls = global._newsUrls || {};
  arts.forEach(a => { if (a.url) global._newsUrls[a.title] = { url: a.url, source: a.source?.name }; });
  return arts.map(a => `- ${a.title} (${a.source?.name}, ${new Date(a.publishedAt).toLocaleDateString('da')})`).join('\n');
}

app.post('/api/news', requireAuth, async (req, res) => {
  const { tickers, category, systemPrompt } = req.body;
  if (!tickers?.length) return res.status(400).json({ error: 'Ingen tickers' });

  try {
    // Hent live nyheder fra NewsAPI
    let newsContext = '';
    try {
      newsContext = await fetchNewsAPI(tickers);
    } catch (e) {
      console.log('NewsAPI fejlede:', e.message);
    }

    const prompt = `${systemPrompt}

Aktiver/emner: ${tickers.join(', ')}

${newsContext ? `Her er de seneste nyheder fra de last 24 timer:\n${newsContext}\n\nAnalyser disse nyheder og` : 'Baseret på din viden,'} returner KUN et JSON-array (ingen markdown, ingen backticks) med max 10 nyheder sorteret efter investeringsrelevans:
[{
  "ticker": "TICKER eller EMNE",
  "headline": "Overskrift på dansk (max 15 ord)",
  "summary": "2-3 sætninger investoranalyse på dansk — hvad betyder det for kursen?",
  "impact": "HIGH",
  "sentiment": "bullish",
  "timeAgo": "fx 'i dag' eller 'i går'",
  "source": "kildenavn fra listen ovenfor"
}]

Impact-kriterier:
- HIGH: Direkte kurspåvirkning, earnings, policyændringer
- MEDIUM: Sektortrends, analytikervurderinger
- LOW: Baggrundsinformation`;

    const data = await callAnthropic(prompt, false);

    let jsonText = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text' && block.text?.includes('[')) {
        jsonText = block.text; break;
      }
    }

    if (!jsonText) {
      console.error('Intet JSON i svar:', JSON.stringify(data).slice(0, 300));
      return res.status(500).json({ error: 'Intet svar fra AI' });
    }

    const s = jsonText.indexOf('['), e = jsonText.lastIndexOf(']');
    if (s === -1 || e === -1) return res.status(500).json({ error: 'Ugyldigt svar format' });

    res.json({ articles: JSON.parse(jsonText.slice(s, e + 1)) });
  } catch (e) {
    console.error('News fejl:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente nyheder: ' + e.message });
  }
});

// ── Static ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kører på http://localhost:${PORT}`));