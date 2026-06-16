import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');

const SYSTEM_PROMPT = `你是 2026 年的 IG 內容腳本師，專精短影音口播與輪播腳本。
根據提供的主題資訊，生成完整的 IG 逐字腳本。

輸出必須包含：
- structure: 3-4 個內容結構段落描述（陣列）
- script: 完整逐字腳本（可直接唸出來），依格式分段，每段有時間標記
- caption: IG 貼文 caption（附 hashtag）
- cta: 2 個 CTA 選項（陣列）
- signal: 主要演算法信號目標（Saves / Shares / Comments / DMs）

腳本規範：
- Reels：60 秒口播，約 150 字，分 [開場 0-10s][問題 10-25s][解法 25-50s][CTA 50-60s]
- 輪播貼文：6-8 張卡，每張 2-3 個重點，有標題
- 純文字 Reel：純口播，1 分鐘，語氣口語、有節奏感
- 開頭直接給衝突或痛點，不要自介
- 每句話短，適合直接唸出來
- 結尾只有一個 CTA

只輸出 JSON，不加任何說明文字：
{"structure":["...","...","..."],"script":"...","caption":"...","cta":["...","..."],"signal":"..."}`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    });
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const body = await req.json().catch(() => ({}));
  const { hook, theme, style, format, niche, target_audience } =
    body as Record<string, string>;

  const userContext = `主題資訊：
Hook（開場句）：${hook || ''}
主題標籤：${theme || ''}
內容風格：${style || ''}
格式：${format || 'Reels'}
創作者核心賽道：${niche || '通用內容'}
目標受眾：${target_audience || '一般上班族'}

請根據以上資訊，生成完整的逐字腳本，語氣自然口語，可直接使用。`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContext }],
    }),
  });

  const data = await response.json();
  const text: string = data.content?.[0]?.text || '{}';

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* ignore */ }
    }
  }

  return new Response(JSON.stringify(parsed), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
});
