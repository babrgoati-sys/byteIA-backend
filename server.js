const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const providers = {
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, models: ['llama-3.3-70b-versatile','llama-3.1-8b-instant'] },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY, models: ['meta-llama/llama-3.3-70b-instruct:free','google/gemma-3-27b-it:free'] },
  together: { name: 'Together', url: 'https://api.together.xyz/v1/chat/completions', key: process.env.TOGETHER_API_KEY, models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free'] },
  mistral: { name: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', key: process.env.MISTRAL_API_KEY, models: ['mistral-small-latest','mistral-large-latest'] },
  cohere: { name: 'Cohere', url: 'https://api.cohere.ai/v2/chat', key: process.env.COHERE_API_KEY, models: ['command-r-plus'] }
};

app.get('/', (req, res) => {
  const active = Object.entries(providers).filter(([,p]) => p.key).map(([id,p]) => ({ id, name: p.name, models: p.models }));
  res.json({ status: 'ok', providers: active });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/providers', (req, res) => {
  const active = Object.entries(providers).filter(([,p]) => p.key).map(([id,p]) => ({ id, name: p.name, models: p.models }));
  res.json(active);
});

app.post('/chat', async (req, res) => {
  const { provider = 'groq', model, messages, temperature = 0.7, max_tokens = 1024 } = req.body;
  const prov = providers[provider];
  if (!prov) return res.status(400).json({ error: 'Unknown provider: ' + provider });
  if (!prov.key) return res.status(400).json({ error: 'Provider not configured: ' + provider });
  const selectedModel = model || prov.models[0];
  try {
    const response = await fetch(prov.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + prov.key,
        ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://byteia-backend.onrender.com', 'X-Title': 'Byte IA' } : {})
      },
      body: JSON.stringify({ model: selectedModel, messages, temperature, max_tokens })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat/stream', async (req, res) => {
  const { provider = 'groq', model, messages, temperature = 0.7, max_tokens = 2048 } = req.body;
  const prov = providers[provider];
  if (!prov) return res.status(400).json({ error: 'Unknown provider: ' + provider });
  if (!prov.key) return res.status(400).json({ error: 'Provider not configured: ' + provider });
  const selectedModel = model || prov.models[0];
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  try {
    const response = await fetch(prov.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + prov.key,
        ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://byteia-backend.onrender.com', 'X-Title': 'Byte IA' } : {})
      },
      body: JSON.stringify({ model: selectedModel, messages, temperature, max_tokens, stream: true })
    });
    if (!response.ok) {
      const err = await response.json();
      res.write('data: ' + JSON.stringify({ error: err }) + '\n\n');
      res.end(); return;
    }
    for await (const chunk of response.body) {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (line.startsWith('data: ')) res.write(line + '\n\n');
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n');
    res.end();
  }
});


// Music generation via HuggingFace MusicGen
app.post('/music', async (req, res) => {
  const { prompt = 'upbeat happy music', duration = 10 } = req.body;
  const key = process.env.HUGGINGFACE_API_KEY || process.env.HF_API_KEY;
  if (!key) return res.status(400).json({ error: 'HF_API_KEY not configured' });
  try {
    const response = await fetch('https://api-inference.huggingface.co/models/facebook/musicgen-small', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: prompt })
    });
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }
    const audioBuffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', 'inline; filename="music.wav"');
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('ByteIA backend running on port ' + PORT);
  const active = Object.entries(providers).filter(([,p]) => p.key).map(([id]) => id);
  console.log('Active providers:', active.join(', ') || 'none');
});
