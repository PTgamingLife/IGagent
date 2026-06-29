import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');

const SYSTEM_PROMPT = `你是 2026 年的 IG 內容策略師，專精演算法與 Justin Welsh 內容矩陣。
根據用戶的個人品牌定位，生成 3 個高潛力的今日 IG 內容主題。

產生 Hook 的核心方法（九宮格交叉法）：
用戶會提供兩個九宮格——
- 九宮格 1「身份最常接觸事物」：用戶身份日常接觸的人、事、物、場景。
- 九宮格 2「受眾的煩惱問題」：受眾真正在意的痛點。
把「九宮格 1 的某個接觸事物」× 「九宮格 2 的某個煩惱」交叉組合，產出具體、貼近生活的 Hook。
範例：接觸「上班族朋友」＋ 煩惱「工作太浪費時間」→ Hook：「3 個省下工作時間的 AI 組合技」。
若用戶有提供九宮格內容，務必讓 3 個 hook 取材自不同的交叉組合。

每個主題必須符合：
- hook：吸引人停滑的開場句，15 字以內，繁體中文，不用標點結尾
- theme：主題標籤，2-4 字，繁體中文
- style：從以下選一：方法型 / 反骨型 / 故事型 / 數據型 / 動機型 / 名單型 / 對比型
- format：從以下選一：Reels / 輪播貼文 / 純文字 Reel
- why：為何此主題在 2026 演算法下有高分享/收藏潛力，20 字以內

只輸出 JSON，不加任何說明文字：
{"topics":[{"hook":"...","theme":"...","style":"...","format":"...","why":"..."},{"hook":"...","theme":"...","style":"...","format":"...","why":"..."},{"hook":"...","theme":"...","style":"...","format":"...","why":"..."}]}`;

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
  const { niche, target_audience, identity_label, solve_problem, deliver_result, use_method } =
    body as Record<string, string>;
  const identityGrid = Array.isArray((body as Record<string, unknown>).identity_grid)
    ? ((body as Record<string, unknown>).identity_grid as string[]).filter(Boolean)
    : [];
  const audienceGrid = Array.isArray((body as Record<string, unknown>).audience_grid)
    ? ((body as Record<string, unknown>).audience_grid as string[]).filter(Boolean)
    : [];

  const gridContext =
    (identityGrid.length || audienceGrid.length)
      ? `\n\n九宮格 1（身份最常接觸事物）：${identityGrid.length ? identityGrid.join('、') : '未填寫'}\n九宮格 2（受眾的煩惱問題）：${audienceGrid.length ? audienceGrid.join('、') : '未填寫'}\n請用「九宮格交叉法」產生 3 個 hook，每個取材自不同的「接觸事物 × 煩惱」組合。`
      : '';

  const userContext = `用戶品牌定位：
核心賽道：${niche || '通用內容'}
目標受眾：${target_audience || '一般上班族'}
身分標籤：${identity_label || '未設定'}
解決問題：${solve_problem || '未設定'}
交付成果：${deliver_result || '未設定'}
使用方法：${use_method || '未設定'}${gridContext}

生成 3 個今日最適合此定位的 IG 主題，三個要有差異性（不同風格和格式）。`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContext }],
    }),
  });

  const data = await response.json();
  const text: string = data.content?.[0]?.text || '{}';

  let parsed: { topics?: unknown[] } = { topics: [] };
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
