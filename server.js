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

// ── Chart data (Yahoo Finance) ────────────────────────────────────
const RANGE_MAP = { '1D': '1d', '1W': '5d', '1M': '1mo', '3M': '3mo', '1Y': '1y' };
const INTERVAL_MAP = { '1D': '5m', '1W': '60m', '1M': '1d', '3M': '1d', '1Y': '1wk' };

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
    res.json({ ticker: meta.symbol, currency: meta.currency, price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose, exchange: meta.exchangeName, points });
  } catch (e) {
    console.error('Chart fejl:', e);
    res.status(500).json({ error: 'Kunne ikke hente kursdata' });
  }
});

// ── Ticker autocomplete ───────────────────────────────────────────
const TICKERS = [
  {t:'NOVO B',n:'Novo Nordisk',e:'CPH'},{t:'MAERSK B',n:'A.P. Møller-Mærsk',e:'CPH'},
  {t:'DSV',n:'DSV A/S',e:'CPH'},{t:'ORSTED',n:'Ørsted',e:'CPH'},{t:'COLOB',n:'Coloplast',e:'CPH'},
  {t:'DEMANT',n:'Demant',e:'CPH'},{t:'GMAB',n:'Genmab',e:'CPH'},
  {t:'AAPL',n:'Apple',e:'NASDAQ'},{t:'MSFT',n:'Microsoft',e:'NASDAQ'},{t:'NVDA',n:'NVIDIA',e:'NASDAQ'},
  {t:'GOOGL',n:'Alphabet',e:'NASDAQ'},{t:'AMZN',n:'Amazon',e:'NASDAQ'},{t:'META',n:'Meta',e:'NASDAQ'},
  {t:'TSLA',n:'Tesla',e:'NASDAQ'},{t:'BABA',n:'Alibaba',e:'NYSE'},{t:'DLO',n:'dLocal',e:'NASDAQ'},
  {t:'NFLX',n:'Netflix',e:'NASDAQ'},{t:'AMD',n:'AMD',e:'NASDAQ'},{t:'INTC',n:'Intel',e:'NASDAQ'},
  {t:'JPM',n:'JPMorgan Chase',e:'NYSE'},{t:'BAC',n:'Bank of America',e:'NYSE'},
  {t:'V',n:'Visa',e:'NYSE'},{t:'MA',n:'Mastercard',e:'NYSE'},{t:'WMT',n:'Walmart',e:'NYSE'},
  {t:'PYPL',n:'PayPal',e:'NASDAQ'},{t:'SHOP',n:'Shopify',e:'NYSE'},{t:'SPOT',n:'Spotify',e:'NYSE'},
  {t:'UBER',n:'Uber',e:'NYSE'},{t:'ABNB',n:'Airbnb',e:'NASDAQ'},
  {t:'BTC-USD',n:'Bitcoin',e:'Crypto'},{t:'ETH-USD',n:'Ethereum',e:'Crypto'},
  {t:'XLM-USD',n:'Stellar Lumens',e:'Crypto'},{t:'SOL-USD',n:'Solana',e:'Crypto'},
  {t:'BNB-USD',n:'BNB',e:'Crypto'},{t:'XRP-USD',n:'XRP',e:'Crypto'},
  {t:'ADA-USD',n:'Cardano',e:'Crypto'},{t:'DOGE-USD',n:'Dogecoin',e:'Crypto'},
];

app.get('/api/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ results: [] });
  const results = TICKERS.filter(t =>
    t.t.toLowerCase().includes(q) || t.n.toLowerCase().includes(q)
  ).slice(0, 6);
  res.json({ results });
});

// ── News (NewsAPI + Claude analyse) ──────────────────────────────
async function fetchNewsAPI(tickers) {
  const cleanTickers = tickers.map(t => t.replace('-USD', '').replace(' B', ''));
  const q = cleanTickers.join(' OR ');
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${process.env.NEWS_API_KEY}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.status !== 'ok') throw new Error('NewsAPI fejl: ' + d.message);
  return (d.articles || []).slice(0, 15).map(a => `- ${a.title} (${a.source?.name}, ${new Date(a.publishedAt).toLocaleDateString('da')})`).join('\n');
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