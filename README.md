# Investor Feed

AI-drevet investornyheds-dashboard med login.

## Stack
- **Backend**: Node.js + Express
- **Auth**: Supabase
- **AI**: Anthropic Claude (web search)
- **Hosting**: Vercel (gratis)

---

## Deploy på 10 minutter

### 1. Supabase (gratis konto)
1. Gå til [supabase.com](https://supabase.com) → "Start your project"
2. Opret et nyt projekt
3. Gå til **Settings → API**
4. Kopiér **Project URL** og **anon public key**
5. Gå til **Authentication → Providers** → Email er allerede slået til ✓

### 2. Anthropic API-nøgle
1. Gå til [console.anthropic.com](https://console.anthropic.com)
2. Opret konto og tilføj betalingskort
3. Gå til **API Keys** → Opret en ny nøgle

### 3. GitHub
```bash
git init
git add .
git commit -m "init"
# Opret et nyt repo på github.com og push:
git remote add origin https://github.com/DITBRUGERNAVN/investor-feed.git
git push -u origin main
```

### 4. Vercel
1. Gå til [vercel.com](https://vercel.com) → Log ind med GitHub
2. Klik **"Add New Project"** → vælg dit repo
3. Under **Environment Variables** tilføj:
   ```
   ANTHROPIC_API_KEY     =  sk-ant-...
   SUPABASE_URL          =  https://xxxx.supabase.co
   SUPABASE_ANON_KEY     =  eyJ...
   NODE_ENV              =  production
   ```
4. Klik **Deploy** → færdig!

Vercel giver dig en URL som `investor-feed.vercel.app`

---

## Lokal udvikling
```bash
cp .env.example .env
# Udfyld .env med dine nøgler
npm install
npm run dev
# Åbn http://localhost:3000
```

---

## Begræns hvem der kan oprette sig

I Supabase kan du begrænse signup til specifikke emails:
- **Authentication → Settings** → Slå "Enable email confirmations" til
- Eller brug **Row Level Security** til kun at tillade bestemte emails

Alternativt: Slå signup fra i koden (`server.js`) og opret brugere
manuelt via Supabase Dashboard under **Authentication → Users**.

---

## Pris
- Vercel: gratis
- Supabase: gratis (op til 50.000 aktive brugere)
- Anthropic API: ~$0.01–0.02 per "Hent nyheder"-klik
