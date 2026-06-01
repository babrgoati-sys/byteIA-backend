const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: '*' }));

// ── Providers ──
const PROVIDERS = [
  { id:'groq',        url:'https://api.groq.com/openai/v1/chat/completions',                             key:()=>process.env.GROQ_API_KEY,        model:'llama-3.3-70b-versatile' },
  { id:'gemini',      url:'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',    key:()=>process.env.GEMINI_API_KEY,      model:'gemini-2.5-flash' },
  { id:'cerebras',    url:'https://api.cerebras.ai/v1/chat/completions',                                 key:()=>process.env.CEREBRAS_API_KEY,    model:'llama-3.3-70b' },
  { id:'openrouter',  url:'https://openrouter.ai/api/v1/chat/completions',                               key:()=>process.env.OPENROUTER_API_KEY,  model:'meta-llama/llama-3.3-70b-instruct:free' },
  { id:'sambanova',   url:'https://api.sambanova.ai/v1/chat/completions',                                key:()=>process.env.SAMBANOVA_API_KEY,   model:'Meta-Llama-3.3-70B-Instruct' },
  { id:'mistral',     url:'https://api.mistral.ai/v1/chat/completions',                                  key:()=>process.env.MISTRAL_API_KEY,     model:'mistral-small-latest' },
  { id:'huggingface', url:'https://api-inference.huggingface.co/v1/chat/completions',                    key:()=>process.env.HUGGINGFACE_API_KEY, model:'meta-llama/Llama-3.3-70B-Instruct' },
  { id:'nvidia',      url:'https://integrate.api.nvidia.com/v1/chat/completions',                        key:()=>process.env.NVIDIA_API_KEY,      model:'meta/llama-3.3-70b-instruct' },
  { id:'github',      url:'https://models.inference.ai.azure.com/chat/completions',                      key:()=>process.env.GITHUB_API_KEY,      model:'gpt-4o' },
  { id:'cloudflare',  url:null,                                                                           key:()=>process.env.CLOUDFLARE_TOKEN,   model:'@cf/meta/llama-3.3-70b-instruct-fp8-fast', accountId:()=>process.env.CLOUDFLARE_ACCOUNT_ID },
  { id:'venice',      url:'https://api.venice.ai/api/v1/chat/completions',                               key:()=>process.env.VENICE_API_KEY,      model:'llama-3.3-70b' },
  { id:'moonshot',    url:'https://api.moonshot.cn/v1/chat/completions',                                 key:()=>process.env.MOONSHOT_API_KEY,    model:'moonshot-v1-8k' },
  { id:'minimax',     url:'https://api.minimax.chat/v1/text/chatcompletion_pro',                         key:()=>process.env.MINIMAX_API_KEY,     model:'abab6.5s-chat' },
  { id:'together',    url:'https://api.together.xyz/v1/chat/completions',                                key:()=>process.env.TOGETHER_API_KEY,    model:'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free' },
];

// ── Health ──
app.get('/', (req, res) => {
  const active = PROVIDERS.filter(p => p.key()).map(p => p.id);
  res.json({ status:'ok', name:'Byte IA Backend', providers:active.length, active });
});

// ── Chat ──
app.post('/v1/chat/completions', async (req, res) => {
  const { messages, model: reqModel, temperature=0.7, max_tokens=2048, stream=false } = req.body;
  if (!messages?.length) return res.status(400).json({ error:{message:'messages requis'} });

  const active = PROVIDERS.filter(p => p.key());
  if (!active.length) return res.status(503).json({ error:{message:'Aucun fournisseur configuré'} });

  let lastError = '';

  for (const p of active) {
    try {
      const key = p.key();
      const model = (reqModel && reqModel !== 'auto') ? reqModel : p.model;
      let url = p.url;

      if (p.id === 'cloudflare') {
        const accountId = p.accountId();
        if (!accountId) { lastError='Cloudflare: ACCOUNT_ID manquant'; continue; }
        url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
      }

      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens, stream }),
        signal: AbortSignal.timeout(30000),
      });

      if (upstream.status === 429) { lastError=`${p.id}: quota atteint`; continue; }
      if (!upstream.ok) {
        const e = await upstream.json().catch(()=>({}));
        lastError = `${p.id}: ${e.error?.message||upstream.status}`;
        continue;
      }

      // ── Streaming: pipe SSE directly ──
      if (stream) {
        res.setHeader('Content-Type','text/event-stream');
        res.setHeader('Cache-Control','no-cache');
        res.setHeader('X-Routed-Via', `${p.id}/${model}`);

        // Send provider info as first chunk
        res.write(`data: ${JSON.stringify({_provider:p.id,_model:model,choices:[{delta:{content:''},index:0}]})}\n\n`);

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(d