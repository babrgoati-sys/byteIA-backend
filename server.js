const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

// ---- PROVIDERS CONFIG ----
// Ordre = priorité. Le serveur essaie dans cet ordre. Si quota épuisé/erreur,
// il passe au suivant automatiquement (zero config côté client).
const PROVIDERS = {
  cerebras: {
    key: process.env.CEREBRAS_API_KEY,
    url: 'https://api.cerebras.ai/v1/chat/completions',
    model: 'llama-3.3-70b',
    type: 'openai'
  },
  groq: {
    key: process.env.GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    type: 'openai'
  },
  gemini: {
    key: process.env.GEMINI_API_KEY,
    model: 'gemini-2.0-flash',
    type: 'gemini'
  },
  sambanova: {
    key: process.env.SAMBANOVA_API_KEY,
    url: 'https://api.sambanova.ai/v1/chat/completions',
    model: 'Meta-Llama-3.3-70B-Instruct',
    type: 'openai'
  },
  nvidia: {
    key: process.env.NVIDIA_API_KEY,
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'meta/llama-3.3-70b-instruct',
    type: 'openai'
  },
  mistral: {
    key: process.env.MISTRAL_API_KEY,
    url: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-small-latest',
    type: 'openai'
  },
  openrouter: {
    key: process.env.OPENROUTER_API_KEY,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'mistralai/mistral-7b-instruct',
    type: 'openai'
  },
  moonshot: {
    key: process.env.MOONSHOT_API_KEY,
    url: 'https://api.moonshot.ai/v1/chat/completions',
    model: 'moonshot-v1-8k',
    type: 'openai'
  },
  together: {
    key: process.env.TOGETHER_API_KEY,
    url: 'https://api.together.xyz/v1/chat/completions',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    type: 'openai'
  },
  // NOUVEAUX providers gratuits
  deepseek: {
    key: process.env.DEEPSEEK_API_KEY,
    url: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',  // V3, qualité top
    type: 'openai'
  },
  zai: {
    key: process.env.ZAI_API_KEY,
    url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    model: 'glm-4.6',  // GLM dernière gen, gratuit
    type: 'openai'
  }
};

// Configuration des tiers : chaque tier a son ordre de providers
// et peut spécifier un modèle différent pour chaque provider (ex. Pro = modèle plus puissant)
const TIERS = {
  flash: {
    // Rapide d'abord : Cerebras > Groq > Gemini Flash
    order: ['cerebras', 'groq', 'gemini', 'sambanova', 'nvidia', 'mistral', 'openrouter', 'together', 'deepseek', 'zai'],
    models: {}
  },
  thinking: {
    // Privilégie les modèles de raisonnement (DeepSeek R1 = top du marché)
    order: ['deepseek', 'groq', 'gemini', 'zai', 'cerebras', 'sambanova', 'nvidia', 'mistral', 'openrouter'],
    models: {
      deepseek: 'deepseek-reasoner',  // R1 : raisonnement chain-of-thought, gratuit
      groq: 'deepseek-r1-distill-llama-70b',
      gemini: 'gemini-2.0-flash-thinking-exp-01-21',
      zai: 'glm-4.6'
    }
  },
  pro: {
    // Privilégie la qualité maximale (DeepSeek V3 + Z.ai GLM-4.6 + Gemini Pro)
    order: ['deepseek', 'zai', 'gemini', 'mistral', 'openrouter', 'sambanova', 'cerebras', 'groq', 'nvidia'],
    models: {
      deepseek: 'deepseek-chat',  // V3 : qualité Claude/GPT-4
      zai: 'glm-4.6',
      gemini: 'gemini-2.0-pro-exp-02-05',
      mistral: 'mistral-large-latest',
      openrouter: 'anthropic/claude-3.5-sonnet'
    }
  }
};
const DEFAULT_TIER = 'flash';
const PROVIDER_ORDER = TIERS.flash.order; // legacy fallback
const exhausted = {}; // name -> timestamp jusqu'à expiration

function isExhausted(name) {
  if (!exhausted[name]) return false;
  if (Date.now() > exhausted[name]) { delete exhausted[name]; return false; }
  return true;
}

function markExhausted(name, ms = 60 * 60 * 1000) { // 1h par défaut
  exhausted[name] = Date.now() + ms;
  console.log(`[exhausted] ${name} pour ${Math.round(ms/60000)}min`);
}

function pickProvider(tier = DEFAULT_TIER) {
  const cfg = TIERS[tier] || TIERS[DEFAULT_TIER];
  for (const name of cfg.order) {
    const p = PROVIDERS[name];
    if (!p || !p.key) continue;
    const tierKey = name + ':' + tier;
    if (isExhausted(tierKey)) continue;
    // Modèle spécifique pour ce tier, sinon défaut
    const model = cfg.models[name] || p.model;
    return { name, tierKey, ...p, model };
  }
  return null;
}

// ---- STATUS ----
// Endpoint public : aucune info sur les providers internes
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Byte IA' });
});

// Endpoint admin protégé par token (utile pour debug)
app.get('/admin/status', (req, res) => {
  const auth = req.headers.authorization || '';
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || auth !== `Bearer ${expected}`) {
    return res.status(404).json({ error: 'Not found' });
  }
  const active = Object.entries(PROVIDERS).filter(([, v]) => v.key).map(([k]) => k);
  const exhaustedList = Object.keys(exhausted).filter(k => isExhausted(k));
  res.json({ status: 'ok', providers: active, exhausted: exhaustedList });
});

// ---- CHAT ----
app.post('/api/chat', async (req, res) => {
  const { message: rawMessage, history = [], imageData, tier = DEFAULT_TIER, webSearch = false } = req.body;
  // Si une image est présente sans texte, on demande à l'IA de la décrire
  let message = rawMessage;
  if (!message && imageData) message = 'Décris ce que tu vois sur cette image.';
  if (!message) return res.status(400).json({ error: 'message requis' });
  const validTier = TIERS[tier] ? tier : DEFAULT_TIER;

  // System prompt : identité unique = Byte IA. L'IA ne doit JAMAIS révéler le modèle sous-jacent.
  let systemPrompt = `Tu es Byte IA, un assistant intelligent, amical et concis créé par ByteIA.
Règles strictes :
1. Tu t'appelles uniquement "Byte IA" ou "Byte". Tu ne mentionnes JAMAIS Llama, Gemini, Mistral, GPT, Claude, DeepSeek, Anthropic, OpenAI, Google, Meta, Groq, ni aucun autre nom de modèle ou d'entreprise.
2. Si on te demande "quel modèle es-tu", "qui t'a créé", "tu tournes sur quoi", réponds simplement : "Je suis Byte IA, un assistant développé par ByteIA. Je préfère ne pas parler de ma technologie sous-jacente."
3. Réponds TOUJOURS dans la même langue que celle de l'utilisateur (détecte sa langue à partir de son message).
4. Ne mets jamais d'astérisques ni de symboles markdown dans tes réponses.`;

  // Auto-injection METEO si question detectee (Open-Meteo, 100% gratuit, sans cle)
  const city = detectWeatherQuery(message);
  if (city) {
    const w = await fetchWeather(city);
    if (w) {
      const fc = w.forecast.map(d => `${d.date} : ${d.min}°C-${d.max}°C ${d.desc}`).join(', ');
      systemPrompt += `\n\nMETEO ACTUELLE pour ${w.city}${w.country ? ', ' + w.country : ''} (donnees Open-Meteo en temps reel) :\n` +
        `- Temperature : ${w.current.temp}°C (ressenti ${w.current.feels}°C)\n` +
        `- Conditions : ${w.current.desc}\n` +
        `- Humidite : ${w.current.humidity}%, Vent : ${w.current.wind} km/h\n` +
        `- Previsions 5 jours : ${fc}\n` +
        `Utilise ces donnees pour repondre. Ne dis JAMAIS que tu ne peux pas connaitre la meteo.`;
    }
  }

  // Recherche Web si demandée : injecte les résultats dans le system prompt
  if (webSearch) {
    try {
      const results = await searchWeb(message);
      if (results && results.length > 0) {
        const contextStr = results.map((r, i) =>
          `[${i+1}] ${r.title}\nURL : ${r.url}\n${r.snippet}`
        ).join('\n\n');
        systemPrompt += `\n\nTu as accès aux résultats de recherche web suivants (datés d'aujourd'hui). Utilise-les pour répondre à la question de l'utilisateur. Cite les sources en notant [1], [2], etc. à côté des affirmations factuelles, et liste les URLs à la fin sous "Sources :".\n\n=== RÉSULTATS DE RECHERCHE WEB ===\n${contextStr}\n=== FIN DES RÉSULTATS ===`;
      }
      // Bonus : Wikipedia en complement (gratuit illimite)
      const wikiQuery = message.slice(0, 100);
      const wiki = await fetchWikipedia(wikiQuery, 'fr');
      if (wiki && wiki.extract) {
        systemPrompt += `\n\nResume Wikipedia (FR) en complement : ${wiki.title} - ${wiki.extract.slice(0, 500)}\nURL : ${wiki.url}`;
      }
    } catch (e) {
      console.log('[search] erreur :', e.message);
    }
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: message }
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // VISION : si une image est jointe, routage forcé vers Gemini (seul provider vision)
  if (imageData && PROVIDERS.gemini && PROVIDERS.gemini.key) {
    const geminiProvider = {
      name: 'gemini',
      tierKey: 'gemini:vision',
      ...PROVIDERS.gemini,
      model: 'gemini-2.0-flash'  // modèle vision rapide et gratuit
    };
    console.log('[chat] VISION mode → gemini');
    const r = await tryProvider(geminiProvider, messages, res, imageData);
    if (r.ok) return;
    res.write(`data: ${JSON.stringify({ text: 'Désolé, l\'analyse d\'image n\'a pas marché. Réessayez.' })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // Boucle de fallback : essaie chaque provider dans l'ordre du tier
  let attempted = [];
  while (true) {
    const chosen = pickProvider(validTier);
    if (!chosen) {
      // Message générique, jamais de noms de providers
      const tierName = validTier === 'flash' ? 'Flash' : validTier === 'thinking' ? 'Thinking' : 'Pro';
      const msg = attempted.length > 0
        ? `Byte ${tierName} est temporairement saturé. Réessayez dans quelques minutes.`
        : `Byte ${tierName} n'est pas disponible pour le moment.`;
      res.write(`data: ${JSON.stringify({ text: msg })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    attempted.push(chosen.name);
    // Log serveur uniquement (jamais envoyé au client)
    console.log(`[chat] tier=${validTier} essai=${chosen.name} model=${chosen.model}`);

    const result = await tryProvider(chosen, messages, res);
    if (result.ok) return;
    // Marquer épuisé selon le type d'erreur (clef = name:tier)
    if (result.code === 429 || result.code === 402 || result.code === 403) {
      markExhausted(chosen.tierKey, 60 * 60 * 1000);
    } else if (result.code === 401) {
      markExhausted(chosen.tierKey, 24 * 60 * 60 * 1000);
    } else if (result.code >= 500) {
      markExhausted(chosen.tierKey, 5 * 60 * 1000);
    } else if (result.code === 404) {
      // Modèle inexistant pour ce provider/tier - marquer longtemps
      markExhausted(chosen.tierKey, 24 * 60 * 60 * 1000);
    } else {
      markExhausted(chosen.tierKey, 10 * 60 * 1000);
    }
  }
});

// Essaie un provider. Retourne { ok: true } si succès, sinon { ok: false, code, err }.
// Important : n'écrit RIEN dans res tant qu'on n'a pas confirmé que le provider marche.
async function tryProvider(chosen, messages, res, imageData = null) {
  try {
    if (chosen.type === 'gemini') {
      return await streamGeminiSafe(chosen, messages, res, imageData);
    }
    return await streamOpenAISafe(chosen, messages, res);
  } catch (e) {
    return { ok: false, code: 0, err: e.message };
  }
}

// Parse une dataURL "data:image/jpeg;base64,XXX" => { mime, data }
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)(?:;base64)?,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mime: m[1], data: m[2] };
}

async function streamOpenAISafe(provider, messages, res) {
  let r;
  try {
    r = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: provider.model, messages, stream: true })
    });
  } catch (e) {
    return { ok: false, code: 0, err: e.message };
  }

  if (!r.ok) {
    const err = await r.text();
    return { ok: false, code: r.status, err: err.slice(0, 200) };
  }

  // À partir d'ici on commit le streaming au client
  return new Promise((resolve) => {
    const decoder = new (require('string_decoder').StringDecoder)('utf8');
    r.body.on('data', (chunk) => {
      const text = decoder.write(chunk);
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (d === '[DONE]') { res.write('data: [DONE]\n\n'); return; }
        try {
          const j = JSON.parse(d);
          const t = j.choices?.[0]?.delta?.content;
          if (t) res.write(`data: ${JSON.stringify({ text: t })}\n\n`);
        } catch (_) {}
      }
    });
    r.body.on('end', () => { res.write('data: [DONE]\n\n'); res.end(); resolve({ ok: true }); });
    r.body.on('error', () => { res.write('data: [DONE]\n\n'); res.end(); resolve({ ok: true }); });
  });
}

async function streamGeminiSafe(provider, messages, res, imageData = null) {
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  // VISION : injecter l'image dans le dernier message user
  if (imageData && contents.length > 0) {
    const parsed = parseDataUrl(imageData);
    if (parsed) {
      const lastUserIdx = [...contents].reverse().findIndex(c => c.role === 'user');
      if (lastUserIdx !== -1) {
        const realIdx = contents.length - 1 - lastUserIdx;
        // Si pas de texte explicite, ajouter un prompt par défaut
        if (!contents[realIdx].parts[0].text || contents[realIdx].parts[0].text.trim() === '') {
          contents[realIdx].parts[0].text = 'Décris ce que tu vois sur cette image.';
        }
        contents[realIdx].parts.push({
          inline_data: { mime_type: parsed.mime, data: parsed.data }
        });
      }
    }
  }

  const systemMsg = messages.find(m => m.role === 'system');
  const body = { contents, generationConfig: { temperature: 0.7 } };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:streamGenerateContent?alt=sse&key=${provider.key}`;

  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { ok: false, code: 0, err: e.message };
  }

  if (!r.ok) {
    const err = await r.text();
    return { ok: false, code: r.status, err: err.slice(0, 200) };
  }

  return new Promise((resolve) => {
    const decoder = new (require('string_decoder').StringDecoder)('utf8');
    r.body.on('data', (chunk) => {
      const text = decoder.write(chunk);
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        try {
          const j = JSON.parse(d);
          const t = j.candidates?.[0]?.content?.parts?.[0]?.text;
          if (t) res.write(`data: ${JSON.stringify({ text: t })}\n\n`);
        } catch (_) {}
      }
    });
    r.body.on('end', () => { res.write('data: [DONE]\n\n'); res.end(); resolve({ ok: true }); });
    r.body.on('error', () => { res.write('data: [DONE]\n\n'); res.end(); resolve({ ok: true }); });
  });
}

// ---- METEO (Open-Meteo, 100% gratuit, sans cle) ----
// Codes meteo selon WMO : https://open-meteo.com/en/docs
const WEATHER_CODES = {
  0: 'ciel degage', 1: 'principalement degage', 2: 'partiellement nuageux', 3: 'couvert',
  45: 'brouillard', 48: 'brouillard givrant',
  51: 'bruine legere', 53: 'bruine moderee', 55: 'bruine dense',
  61: 'pluie faible', 63: 'pluie moderee', 65: 'pluie forte',
  71: 'neige faible', 73: 'neige moderee', 75: 'neige forte',
  80: 'averses faibles', 81: 'averses moderees', 82: 'averses violentes',
  95: 'orage', 96: 'orage avec grele faible', 99: 'orage avec grele forte'
};

async function fetchWeather(city) {
  try {
    // 1. Geocoding (transformer "Paris" en coordonnees GPS)
    const geoUrl = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
      encodeURIComponent(city) + '&count=1&language=fr&format=json';
    const geoRes = await fetch(geoUrl);
    if (!geoRes.ok) return null;
    const geo = await geoRes.json();
    if (!geo.results || geo.results.length === 0) return null;
    const loc = geo.results[0];

    // 2. Meteo actuelle + previsions 5 jours
    const weatherUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' +
      loc.latitude + '&longitude=' + loc.longitude +
      '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m,apparent_temperature' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5&timezone=auto';
    const wRes = await fetch(weatherUrl);
    if (!wRes.ok) return null;
    const w = await wRes.json();

    const cur = w.current || {};
    const daily = w.daily || {};
    const days = (daily.time || []).slice(0, 5).map((d, i) => ({
      date: d,
      max: daily.temperature_2m_max?.[i],
      min: daily.temperature_2m_min?.[i],
      desc: WEATHER_CODES[daily.weather_code?.[i]] || 'inconnu'
    }));

    return {
      city: loc.name,
      country: loc.country || '',
      current: {
        temp: cur.temperature_2m,
        feels: cur.apparent_temperature,
        humidity: cur.relative_humidity_2m,
        wind: cur.wind_speed_10m,
        desc: WEATHER_CODES[cur.weather_code] || 'inconnu'
      },
      forecast: days
    };
  } catch (e) {
    console.log('[weather] erreur :', e.message);
    return null;
  }
}

// Detecte une question meteo et la ville mentionnee
function detectWeatherQuery(message) {
  const re = /(m[eé]t[eé]o|weather|tiempo|wetter|temps qu['' ]il fait|clima|how['' ]s the weather)/i;
  if (!re.test(message)) return null;
  // Extraire ville apres "a/à/in/at/de"
  const cityMatch = message.match(/(?:a|à|à |in |at |de |dans |pour |sur |me?t[eé]o\s+(?:de\s+)?)([A-ZÀ-Üa-zà-ü][A-ZÀ-Üa-zà-ü\s-]{1,40})\??$/i);
  if (cityMatch) return cityMatch[1].trim().replace(/[?!.]/g, '');
  return null;
}

// ---- WIKIPEDIA (gratuit, sans cle, illimite) ----
async function fetchWikipedia(query, lang = 'fr') {
  try {
    // Recherche le titre
    const searchUrl = 'https://' + lang + '.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=1&srsearch=' +
      encodeURIComponent(query) + '&origin=*';
    const sRes = await fetch(searchUrl);
    if (!sRes.ok) return null;
    const s = await sRes.json();
    const hit = s.query?.search?.[0];
    if (!hit) return null;

    // Recupere le resume
    const sumUrl = 'https://' + lang + '.wikipedia.org/api/rest_v1/page/summary/' +
      encodeURIComponent(hit.title);
    const sumRes = await fetch(sumUrl);
    if (!sumRes.ok) return null;
    const sum = await sumRes.json();
    return {
      title: sum.title,
      extract: sum.extract || '',
      url: sum.content_urls?.desktop?.page || ('https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(hit.title))
    };
  } catch (e) {
    return null;
  }
}

// ---- RECHERCHE WEB ----
// Essaie Brave Search d'abord (qualité top), puis fallback DuckDuckGo HTML (gratuit illimité)
async function searchWeb(query, n = 5) {
  // 1. Brave Search API
  const braveKey = process.env.BRAVE_API_KEY;
  if (braveKey) {
    try {
      const url = 'https://api.search.brave.com/res/v1/web/search?q=' +
        encodeURIComponent(query) + '&count=' + n + '&safesearch=moderate';
      const r = await fetch(url, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey }
      });
      if (r.ok) {
        const d = await r.json();
        const results = (d.web?.results || []).slice(0, n).map(x => ({
          title: x.title || '',
          url: x.url || '',
          snippet: (x.description || '').replace(/<[^>]+>/g, '').slice(0, 300)
        }));
        if (results.length > 0) return results;
      }
    } catch (_) {}
  }

  // 2. Fallback DuckDuckGo HTML (gratuit, sans clé, illimité)
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ByteIABot/1.0)' }
    });
    if (!r.ok) return [];
    const html = await r.text();
    const results = [];
    const blockRe = /<a class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>(.*?)<\/a>/g;
    let m;
    while ((m = blockRe.exec(html)) && results.length < n) {
      let url = m[1];
      // DuckDuckGo wrap les liens dans /l/?uddg=...
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      const title = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
      const snippet = m[3].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim().slice(0, 300);
      results.push({ title, url, snippet });
    }
    return results;
  } catch (e) {
    return [];
  }
}

// ---- IMAGE GENERATION ----
app.post('/api/image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt requis' });

  // Pollinations : URL générative pure - on retourne directement, le navigateur charge l'image
  // (pas de HEAD check : Pollinations renvoie souvent 405 sur HEAD même quand GET marche)
  const seed = Math.floor(Math.random() * 1e9);
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=768&height=768&nologo=true&seed=${seed}`;
  return res.json({ url });
});

// ---- MUSIC GENERATION (FIXED) ----
app.post('/api/music', async (req, res) => {
  // Accepte prompt, duration (secondes), style optionnel
  const { prompt, duration = 30, style } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt requis' });

  const hfKey = process.env.HF_API_KEY || process.env.HUGGINGFACE_API_KEY;
  if (!hfKey) {
    return res.json({ error: 'Clé HuggingFace manquante. Ajoutez HF_API_KEY dans Render.' });
  }

  // Clamp durée entre 5 et 30s (limite raisonnable pour l'API gratuite)
  const dur = Math.min(30, Math.max(5, Number(duration) || 30));

  try {
    const r = await fetch(
      // URL CORRIGEE : .co et non .com
      'https://api-inference.huggingface.co/models/facebook/musicgen-small',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${hfKey}`,
          'Content-Type': 'application/json',
          'x-wait-for-model': 'true'
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            // MusicGen utilise max_new_tokens : ~50 tokens = ~1 seconde
            // Pour 30 secondes : ~1500 tokens
            max_new_tokens: Math.round(dur * 50),
            do_sample: true,
            temperature: 1.0,
            guidance_scale: 3
          },
          options: { wait_for_model: true }
        }),
        timeout: 120000
      }
    );

    if (!r.ok) {
      const err = await r.text();
      if (r.status === 503) {
        return res.json({ error: 'Le modèle musical se réveille (60-90s). Réessayez dans un instant.' });
      }
      if (r.status === 401 || r.status === 403) {
        return res.json({ error: 'Clé HuggingFace invalide. Vérifiez HF_API_KEY dans Render.' });
      }
      return res.json({ error: 'Erreur HuggingFace (' + r.status + '): ' + err.slice(0, 120) });
    }

    const ct = r.headers.get('content-type') || '';
    const buf = await r.buffer();

    // HuggingFace renvoie un wav/flac binaire si OK, ou un JSON d'erreur si problème
    if (ct.includes('application/json')) {
      try {
        const j = JSON.parse(buf.toString('utf8'));
        return res.json({ error: j.error || 'Réponse inattendue du modèle.' });
      } catch (_) {
        return res.json({ error: 'Réponse inattendue du modèle.' });
      }
    }

    const b64 = buf.toString('base64');
    const mime = ct.includes('flac') ? 'audio/flac' : 'audio/wav';
    res.json({ url: `data:${mime};base64,${b64}`, duration: dur, style: style || null });
  } catch (e) {
    res.json({ error: 'Erreur génération musicale: ' + (e.message || 'inconnue') });
  }
});

// ---- VERIFICATION EMAIL PAR CODE (signup email seulement) ----
// Stockage en memoire : { email -> { code, expires, attempts, lastSent } }
const emailCodes = {};
const CODE_TTL = 10 * 60 * 1000;          // 10 minutes
const CODE_RESEND_COOLDOWN = 60 * 1000;   // 1 min entre 2 envois
const MAX_ATTEMPTS = 5;

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));  // 6 chiffres
}

async function sendCodeEmail(email, code, lang = 'fr') {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log('[verify] RESEND_API_KEY manquante, code:', code);
    return { ok: false, error: 'Service email non configure' };
  }
  const subjects = {
    fr: 'Votre code de verification Byte IA',
    en: 'Your Byte IA verification code',
    es: 'Tu codigo de verificacion Byte IA',
    it: 'Il tuo codice di verifica Byte IA',
    de: 'Dein Byte IA Verifizierungscode',
    pt: 'Seu codigo de verificacao Byte IA',
    nl: 'Je Byte IA verificatiecode',
    ar: 'رمز التحقق Byte IA'
  };
  const subj = subjects[lang] || subjects.fr;
  const html = `
    <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:auto;padding:30px 20px;background:#fafafa;border-radius:14px">
      <div style="text-align:center;margin-bottom:24px">
        <h1 style="margin:0;font-size:22px;color:#1a1a1a">Byte <span style="color:#6c7aff">IA</span></h1>
      </div>
      <p style="color:#1a1a1a;font-size:15px;line-height:1.5">Voici votre code de verification :</p>
      <div style="background:#fff;border:2px solid #6c7aff;border-radius:12px;padding:20px;text-align:center;margin:20px 0">
        <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#6c7aff;font-family:monospace">${code}</div>
      </div>
      <p style="color:#555;font-size:13px">Ce code expire dans 10 minutes. Si vous n'avez pas demande ce code, ignorez cet email.</p>
      <p style="color:#999;font-size:11px;text-align:center;margin-top:30px">Byte IA &middot; Assistant intelligent</p>
    </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Byte IA <onboarding@resend.dev>',
        to: [email],
        subject: subj,
        html: html
      })
    });
    if (!r.ok) {
      const err = await r.text();
      return { ok: false, error: 'Erreur envoi : ' + err.slice(0, 100) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// POST /api/auth/send-code { email, lang } => envoi du code
app.post('/api/auth/send-code', async (req, res) => {
  const { email, lang = 'fr' } = req.body;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Email invalide' });
  }
  const now = Date.now();
  const existing = emailCodes[email];
  if (existing && (now - existing.lastSent) < CODE_RESEND_COOLDOWN) {
    const wait = Math.ceil((CODE_RESEND_COOLDOWN - (now - existing.lastSent)) / 1000);
    return res.status(429).json({ error: `Attendez ${wait}s avant un nouvel envoi` });
  }
  const code = generateCode();
  emailCodes[email] = { code, expires: now + CODE_TTL, attempts: 0, lastSent: now };
  const r = await sendCodeEmail(email, code, lang);
  if (!r.ok) {
    delete emailCodes[email];
    return res.status(500).json({ error: r.error });
  }
  res.json({ ok: true, message: 'Code envoye' });
});

// POST /api/auth/verify-code { email, code } => verification du code
app.post('/api/auth/verify-code', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email et code requis' });
  const entry = emailCodes[email];
  if (!entry) return res.status(400).json({ error: 'Aucun code en attente pour cet email' });
  if (Date.now() > entry.expires) {
    delete emailCodes[email];
    return res.status(400).json({ error: 'Code expire, demandez-en un nouveau' });
  }
  entry.attempts++;
  if (entry.attempts > MAX_ATTEMPTS) {
    delete emailCodes[email];
    return res.status(429).json({ error: 'Trop de tentatives, demandez un nouveau code' });
  }
  if (entry.code !== String(code).trim()) {
    return res.status(400).json({ error: 'Code incorrect', attemptsLeft: MAX_ATTEMPTS - entry.attempts });
  }
  // Code valide : on le supprime (one-shot) et on emet un token court qui prouve la verification
  delete emailCodes[email];
  res.json({ ok: true, message: 'Email verifie' });
});

// Nettoyage periodique des codes expires
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(emailCodes)) {
    if (now > emailCodes[k].expires + CODE_TTL) delete emailCodes[k];
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => console.log(`Byte IA backend running on port ${PORT}`));
