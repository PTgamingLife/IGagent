import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = 'claude-sonnet-5';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

// Claude 呼叫 + 韌性 JSON 解析（容忍 ```json 圍欄與前後說明文字）
async function callClaude(system: string, content: unknown, maxTokens = 3000): Promise<Record<string, unknown>> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  const text: string = data.content?.[0]?.text || '{}';
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const m = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
  throw new Error('AI 回應無法解析');
}

function modelContext(baseModel: unknown, userModel: unknown): string {
  return `【基礎模型（全體共用）】\n${JSON.stringify(baseModel || {})}\n\n【此帳號個人模型（只屬於此帳號，優先於基礎模型）】\n${JSON.stringify(userModel || {})}`;
}

// ── 區塊3：文稿流量預測（模式A）──
async function predictScript(b: Record<string, unknown>) {
  const system = `你是口播短影音（IG Reels）流量預測引擎。根據流量模型分析使用者的文稿，預測表現並給出「怎麼改能增加流量」的具體方向。
評分時：基礎模型是通則；個人模型（若有 notes/bias）代表此帳號歷史校準，必須優先套用（例如 bias=-5 代表過去預測普遍高估 5 分，需下修）。
只輸出 JSON：
{"predicted_score":0-100,"hook_score":0-100,
 "sentences":[{"seq":1,"text":"...","function":"鉤子/鋪陳/轉折/CTA","strength":"強/中/弱","risk_flag":true/false,"note":"...(≤25字)"}],
 "emotion_arc":[{"seq":1,"emotion":"好奇/緊張/共鳴/滿足","level":1-5}],
 "drop_points":[{"seq":2,"reason":"...(≤25字)"}],
 "suggestions":[{"priority":1,"change":"具體修改建議(≤50字)","expected_gain":"預期增加的流量訊號(≤25字)"}],
 "summary":"總評(≤80字，繁體中文)"}`;
  const user = `${modelContext(b.base_model, b.user_model)}

【帳號定位】賽道：${b.niche || '未設定'}／受眾：${b.target_audience || '未設定'}
【標題】${b.title || '(未提供)'}
${b.original_script ? `【AI 原稿（修正前）】\n${b.original_script}\n` : ''}
【使用者修正後文稿（分析對象）】
${b.script}

逐句拆解、找掉點、給 3-5 條按優先級排序的修改建議。全部繁體中文。`;
  return await callClaude(system, user);
}

// ── 區塊4：影片＋文稿節奏預測（模式B 近似）──
async function predictVideo(b: Record<string, unknown>) {
  const system = `你是口播短影音流量預測引擎（成品模式）。根據文稿內容、影片長度與語速節奏，預測流量表現。
語速參考：繁中口播理想約 2.5 字/秒（150 字/分）；>3.5 過快、<1.8 過慢易流失。
四象限融合：逐段判斷文稿強弱 × 節奏狀態，輸出診斷（保留/改節奏/改文字/重做）。
套用個人模型校準（bias/notes）。只輸出 JSON：
{"predicted_score":0-100,"hook_strength":0-100,
 "pacing":{"cps":數字,"verdict":"過快/適中/過慢","note":"...(≤30字)"},
 "attention_estimate":[{"sec":0,"attention":0-100},...每3-5秒一點],
 "fusion":[{"segment":1,"start_sec":0,"end_sec":3,"script_state":"強/弱","visual_state":"高/掉","verdict":"保留/改節奏/改文字/重做","action":"...(≤35字)"}],
 "suggestions":[{"priority":1,"change":"...(≤50字)","expected_gain":"...(≤25字)"}],
 "summary":"總評(≤80字，繁體中文)"}`;
  const user = `${modelContext(b.base_model, b.user_model)}

【標題】${b.title || '(未提供)'}
【影片長度】${b.duration_sec} 秒
【文稿字數】${b.char_count} 字 → 平均語速 ${b.pace_cps} 字/秒
【文稿】
${b.script}

依時間軸切段（用語速把句子對到秒數），輸出四象限逐段診斷與注意力估計曲線。全部繁體中文。`;
  return await callClaude(system, user);
}

// ── 區塊5：截圖判讀真實流量 → 回填校準 ──
async function ingestActuals(b: Record<string, unknown>) {
  const system = `你是 IG 流量截圖判讀與模型校準引擎。使用者上傳 IG 洞察截圖（上架約 24 小時後）。
任務：
1. 從截圖精準抽取數據（看不到的欄位填 null，不要猜）。
2. 若有留存曲線截圖，近似判讀成逐秒曲線。
3. 依 2026 演算法權重（觀看時長>DM>分享>收藏>讚）把表現換算成 actual_score（0-100，相對此粉絲量級的合理表現）。
4. 對照各階段預測分數，計算誤差，產出個人模型更新：bias（預測-實際 的移動平均修正值）與 1-3 條此帳號專屬的新洞察 notes。
只輸出 JSON：
{"metrics":{"views":n,"reach":n,"likes":n,"comments":n,"shares":n,"saves":n,"avg_watch_sec":n或null},
 "retention_curve":[{"sec":0,"retention":100},...] 或 [],
 "actual_score":0-100,
 "per_stage":[{"stage":"A_script","predicted_score":n,"error":預測減實際}],
 "model_update":{"bias":數字,"notes":["...(≤40字)"]},
 "summary":"...(≤80字，繁體中文)"}`;
  const images = (b.images as Array<{ media_type: string; data: string }>) || [];
  const content: unknown[] = images.map(im => ({
    type: 'image',
    source: { type: 'base64', media_type: im.media_type, data: im.data },
  }));
  content.push({
    type: 'text',
    text: `${modelContext(b.base_model, b.user_model)}

【貼文】${JSON.stringify(b.post || {})}
【發布前各階段預測】${JSON.stringify(b.predictions || [])}
【個人模型目前狀態】${JSON.stringify(b.user_model || {})}

請判讀截圖、計算 actual_score 與各階段誤差，並給出個人模型更新（新 bias 請融合舊 bias 與本次誤差，而非直接覆蓋）。全部繁體中文。`,
  });
  return await callClaude(system, content, 3500);
}

// ── 後臺：交叉比對所有帳號模型 → 共通細節寫入基礎模型 ──
async function crossCalibrate(req: Request) {
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
  const { data: { user } } = await svc.auth.getUser(jwt);
  if (!user) return json({ error: '未登入' }, 401);
  const { data: acct } = await svc.from('vp_accounts').select('is_admin').eq('user_id', user.id).single();
  if (!acct?.is_admin) return json({ error: '僅限管理員' }, 403);

  const { data: models } = await svc.from('vp_user_models').select('user_id, model');
  if (!models || models.length < 2) {
    return json({ summary: `目前只有 ${models?.length || 0} 個帳號有個人模型，至少需要 2 個才能交叉比對。`, common_insights: [], updated: false });
  }
  const { data: baseRow } = await svc.from('vp_base_model').select('model').eq('id', 1).single();
  const base = (baseRow?.model || {}) as Record<string, unknown>;

  const system = `你是流量模型維護引擎。輸入多個帳號的個人校準模型（各自的 bias 與 notes），找出「跨帳號共通」的規律：至少出現在 2 個帳號、且不是單一帳號特有風格的洞察。
共通規律要改寫成通則句（不提特定帳號）。只輸出 JSON：
{"common_insights":["...(≤40字)"],"summary":"...(≤80字，繁體中文)"}`;
  const userMsg = `【現有基礎模型】${JSON.stringify(base)}
【${models.length} 個帳號的個人模型】
${models.map((m, i) => `帳號${i + 1}: ${JSON.stringify(m.model)}`).join('\n')}

找出共通細節（已在基礎模型 common_insights 裡的不要重複）。若沒有可靠共通點，common_insights 給空陣列。`;
  const out = await callClaude(system, userMsg, 1500);

  const found = (out.common_insights as string[]) || [];
  const existing = (base.common_insights as string[]) || [];
  const merged = [...existing, ...found.filter(x => !existing.includes(x))];
  if (found.length) {
    await svc.from('vp_base_model').update({
      model: { ...base, common_insights: merged },
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
  }
  return json({ summary: out.summary || '', common_insights: found, total_insights: merged.length, compared_accounts: models.length, updated: found.length > 0 });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body.action as string;

  try {
    if (action === 'predict_script') return json(await predictScript(body));
    if (action === 'predict_video') return json(await predictVideo(body));
    if (action === 'ingest_actuals') return json(await ingestActuals(body));
    if (action === 'cross_calibrate') return await crossCalibrate(req);
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
