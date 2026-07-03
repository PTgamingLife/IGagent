import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const KEY=Deno.env.get('ANTHROPIC_API_KEY');
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Content-Type':'application/json'};
const J=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:CORS});
async function ai(system:string,content:unknown,max=3000){
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':KEY!,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-5',max_tokens:max,system,messages:[{role:'user',content}]})});
  const d=await r.json();
  if(d.error)throw new Error(d.error.message);
  const t:string=d.content?.[0]?.text||'{}';
  try{return JSON.parse(t)}catch{}
  const m=t.replace(/```json|```/g,'').match(/\{[\s\S]*\}/);
  if(m){try{return JSON.parse(m[0])}catch{}}
  throw new Error('AI response unparseable');
}
const ctx=(bm:unknown,um:unknown)=>`[BASE MODEL shared]\n${JSON.stringify(bm||{})}\n[USER MODEL this account only, overrides base; bias=predicted-actual correction]\n${JSON.stringify(um||{})}`;
async function pScript(b:any){
  const sys=`You are an IG Reels spoken-video virality prediction engine. Analyze the script with the traffic model, predict performance, give concrete changes to increase traffic. Apply user model calibration first. Reply ONLY JSON, all text values in Traditional Chinese:
{"predicted_score":0-100,"hook_score":0-100,"sentences":[{"seq":1,"text":"","function":"鉤子|鋪陳|轉折|CTA","strength":"強|中|弱","risk_flag":false,"note":"<=25 chars"}],"emotion_arc":[{"seq":1,"emotion":"","level":1}],"drop_points":[{"seq":2,"reason":"<=25"}],"suggestions":[{"priority":1,"change":"<=50","expected_gain":"<=25"}],"summary":"<=80"}`;
  return await ai(sys,`${ctx(b.base_model,b.user_model)}\n[NICHE]${b.niche||''} [AUDIENCE]${b.target_audience||''}\n[TITLE]${b.title||''}\n${b.original_script?`[AI ORIGINAL]\n${b.original_script}\n`:''}[USER CORRECTED SCRIPT to analyze]\n${b.script}\nAnalyze sentence by sentence, find drop points, 3-5 prioritized suggestions.`);
}
async function pVideo(b:any){
  const sys=`You are an IG Reels virality prediction engine (finished-video mode). Predict from script + duration + speech pace. Ideal zh-TW pace ~2.5 chars/sec; >3.5 too fast, <1.8 too slow. Four-quadrant fusion per segment: script strong/weak x pace state -> verdict 保留|改節奏|改文字|重做. Apply user model. Reply ONLY JSON, text in Traditional Chinese:
{"predicted_score":0-100,"hook_strength":0-100,"pacing":{"cps":0,"verdict":"過快|適中|過慢","note":"<=30"},"attention_estimate":[{"sec":0,"attention":100}],"fusion":[{"segment":1,"start_sec":0,"end_sec":3,"script_state":"強|弱","visual_state":"高|掉","verdict":"","action":"<=35"}],"suggestions":[{"priority":1,"change":"<=50","expected_gain":"<=25"}],"summary":"<=80"}`;
  return await ai(sys,`${ctx(b.base_model,b.user_model)}\n[TITLE]${b.title||''}\n[DURATION]${b.duration_sec}s [CHARS]${b.char_count} [PACE]${b.pace_cps} chars/sec\n[SCRIPT]\n${b.script}\nMap sentences to seconds via pace, output fusion per segment and attention curve every 3-5s.`);
}
async function pActuals(b:any){
  const sys=`You are an IG insights screenshot reader + model calibrator (24h after posting). 1) Extract metrics precisely, null if not visible, never guess. 2) If retention-curve screenshot present, approximate per-second curve. 3) Convert to actual_score 0-100 using 2026 algorithm weights (watch time>DM>share>save>like) relative to account size. 4) Compare with stage predictions, compute error=predicted-actual, output user model update: new bias blends old bias with this error; 1-3 account-specific insight notes. Reply ONLY JSON, text in Traditional Chinese:
{"metrics":{"views":0,"reach":0,"likes":0,"comments":0,"shares":0,"saves":0,"avg_watch_sec":null},"retention_curve":[{"sec":0,"retention":100}],"actual_score":0,"per_stage":[{"stage":"A_script","predicted_score":0,"error":0}],"model_update":{"bias":0,"notes":["<=40"]},"summary":"<=80"}`;
  const imgs=(b.images||[]) as Array<{media_type:string,data:string}>;
  const content:unknown[]=imgs.map(im=>({type:'image',source:{type:'base64',media_type:im.media_type,data:im.data}}));
  content.push({type:'text',text:`${ctx(b.base_model,b.user_model)}\n[POST]${JSON.stringify(b.post||{})}\n[PRE-PUBLISH PREDICTIONS]${JSON.stringify(b.predictions||[])}\nRead screenshots, compute actual_score, per-stage errors, and user model update.`});
  return await ai(sys,content,3500);
}
async function crossCal(req:Request){
  const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const jwt=(req.headers.get('Authorization')||'').replace('Bearer ','');
  const {data:{user}}=await svc.auth.getUser(jwt);
  if(!user)return J({error:'unauthorized'},401);
  const {data:acct}=await svc.from('vp_accounts').select('is_admin').eq('user_id',user.id).single();
  if(!acct?.is_admin)return J({error:'admin only'},403);
  const {data:models}=await svc.from('vp_user_models').select('user_id, model');
  if(!models||models.length<2)return J({summary:`目前只有 ${models?.length||0} 個帳號有個人模型，至少需要 2 個才能交叉比對。`,common_insights:[],updated:false});
  const {data:baseRow}=await svc.from('vp_base_model').select('model').eq('id',1).single();
  const base=(baseRow?.model||{}) as Record<string,unknown>;
  const sys=`You maintain a shared base traffic model. Given multiple accounts' personal calibration models (bias+notes), find rules common to >=2 accounts that are not account-specific style. Rewrite as general rules. Reply ONLY JSON, Traditional Chinese: {"common_insights":["<=40 chars"],"summary":"<=80"}`;
  const out=await ai(sys,`[BASE]${JSON.stringify(base)}\n[${models.length} USER MODELS]\n${models.map((m,i)=>`#${i+1}: ${JSON.stringify(m.model)}`).join('\n')}\nSkip insights already in common_insights; empty array if none reliable.`,1500);
  const found=(out.common_insights as string[])||[];
  const existing=(base.common_insights as string[])||[];
  const merged=[...existing,...found.filter(x=>!existing.includes(x))];
  if(found.length)await svc.from('vp_base_model').update({model:{...base,common_insights:merged},updated_at:new Date().toISOString()}).eq('id',1);
  return J({summary:out.summary||'',common_insights:found,total_insights:merged.length,compared_accounts:models.length,updated:found.length>0});
}
Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:CORS});
  if(!KEY)return J({error:'ANTHROPIC_API_KEY not configured'},500);
  let b:any={};try{b=await req.json()}catch{}
  try{
    if(b.action==='predict_script')return J(await pScript(b));
    if(b.action==='predict_video')return J(await pVideo(b));
    if(b.action==='ingest_actuals')return J(await pActuals(b));
    if(b.action==='cross_calibrate')return await crossCal(req);
    return J({error:'unknown action'},400);
  }catch(e){return J({error:(e as Error).message},500)}
});
