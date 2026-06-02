const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

// ---- PROVIDERS CONFIG ----
const PROVIDERS = {
  groq: {
    key: process.env.GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama3-8b-8192',
    type: 'openai'
  },
  openrouter: {
    key: process.env.OPENROUTER_API_KEY,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'mistralai/mistral-7b-instruct',
    type: 'openai'
  },
  mistral: {
    key: process.env.MISTRAL_API_KEY,
    url: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-small-latest',
    type: 'openai'
  },
  gemini: {
    key: process.env.GEMINI_API_KEY,
    model: 'gemini-2.0-flash',
    type: 'gemini'
  },
  together: {
    key: process.env.TOGETHER_API_KEY,
    url: 'https://api.together.xyz/v1/chat/completions',
    model: 'mistralai/Mistral-7B-Instruct-v0.1',
    type: 'openai'
  }
};

// ---- STATUS ----
app.get('/', (req, res) => {
  const active = Object.entries(PROVIDERS)
    .filter(([, v]) => v.key)
    .map(([k]) => k);
  res.json({ status: 'ok', providers: active });
});

// ---- CHAT ----
app.post('/api/chat', async (req, res) => {
  const { message, model = 'groq', history = [], imageData } = req.body;
  if (!message) return res.status(400).json({ error: 'message requis' });

  const provider = PROVIDERS[model] || PROVIDERS.groq;

  // Fallback si la clé manque
  let chosen = provider;
  if (!chosen.key) {
    chosen = Object.values(PROVIDERS).find(p => p.key);
    if (!chosen) return res.status(503).json({ error: 'Aucune clé API disponible.' });
  }

  const messages = [
    { role: 'system', content: 'Tu es Byte IA, un assistant intelligent, amical et concis. Réponds toujours en français sauf si l\'utilisateur écrit dans une autre langue. Ne mets jamais d\'astérisques ni de symboles markdown dans tes réponses.' },
    ...history,
    { role: 'user', content: message }
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (chosen.type === 'gemini') {
      await streamGemini(chosen, messages, res);
    } else {
      await streamOpenAI(chosen, messages, res);
    }
  } catch (e) {
    res.write(`data: ${JSON.stringify({ text: 'Erreur: ' + e.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

async function streamOpenAI(provider, messages, res) {
  const r = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: provider.model, messages, stream: true })
  });

  if (!r.ok) {
    const err = await r.text();
    res.write(`data: ${JSON.stringify({ text: 'Erreur provider: ' + err.slice(0, 100) })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

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
  r.body.on('end', () => { res.write('data: [DONE]\n\n'); res.end(); });
  r.body.on('error', (e) => { res.write(`data: ${JSON.stringify({ text: e.message })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); });
}

async function streamGemini(provider, messages, res) {
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  const systemMsg = messages.find(m => m.role === 'system');

  const body = {
    contents,
    generationConfig: { temperature: 0.7 }
  };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:streamGenerateContent?alt=sse&key=${provider.key}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const err = await r.text();
    res.write(`data: ${JSON.stringify({ text: 'Erreur Gemini: ' + err.slice(0, 150) })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

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
  r.body.on('end', () => { res.write('data: [DONE]\n\n'); res.end(); });
  r.body.on('error', (e) => { res.write(`data: ${JSON.stringify({ text: e.message })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); });
}

// ---- IMAGE GENERATION ----
app.post('/api/image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt requis' });

  // Essai avec Pollinations (gratuit, sans clé)
  try {
    const encoded = encodeURIComponent(prompt);
    const url = `https://image.pollinations.ai/prompt/${encoded}?width=512&height=512&nologo=true`;
    // On vérifie juste que l'URL est accessible
    const check = await fetch(url, { method: 'HEAD' });
    if (check.ok || check.status === 200 || check.redirected) {
      return res.json({ url });
    }
  } catch (_) {}

  // Fallback: HuggingFace Stable Diffusion
  const hfKey = process.env.HF_API_KEY || process.env.HUGGINGFACE_API_KEY;
  if (hfKey) {
    try {
      const r = await fetch('https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${hfKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: prompt })
      });
      if (r.ok) {
        const buf = await r.buffer();
        const b64 = buf.toString('base64');
        return res.json({ url: `data:image/png;base64,${b64}` });
      }
    } catch (_) {}
  }

  res.json({ error: 'Impossible de générer l\'image pour l\'instant.' });
});

// ---- MUSIC GENERATION ----
app.post('/api/music', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt requis' });

  const hfKey = process.env.HF_API_KEY || process.env.HUGGINGFACE_API_KEY;
  if (!hfKey) return res.json({ error: 'Clé HuggingFace manquante. Ajoutez HF_API_KEY dans Render.' });

  try {
    const r = await fetch('https://api-inference.huggingface.com/models/facebook/musicgen-small', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${hfKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: prompt }),
      timeout: 60000
    });

    if (!r.ok) {
      const err = await r.text();
      // Modèle en cours de chargement
      if (r.status === 503) return res.json({ error: 'Le modèle musical se réveille (30-60s). Réessayez dans un moment.' });
      return res.json({ error: 'Erreur HuggingFace: ' + err.slice(0, 100) });
    }

    const buf = await r.buffer();
    const b64 = buf.toString('base64');
    res.json({ url: `data:audio/wav;base64,${b64}` });
  } catch (e) {
    res.json({ error: 'Erreur génération musicale: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`Byte IA backend running on port ${PORT}`));
