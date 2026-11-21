'use strict';
const C = window.CRM_CONFIG;
// Ссылка из письма (подтверждение регистрации / сброс пароля) приходит с параметрами в #hash — читаем до инициализации клиента
const AUTH_HASH = new URLSearchParams(location.hash.replace(/^#/, ''));
const AUTH_QUERY = new URLSearchParams(location.search);
const AUTH_LINK_TYPE = AUTH_HASH.get('type') || AUTH_QUERY.get('type');   // signup | recovery | invite | magiclink | email_change
const AUTH_LINK_ERROR = AUTH_HASH.get('error_description') || AUTH_QUERY.get('error_description');
const REDIRECT_URL = location.origin + location.pathname;
let needSetPassword = ['signup','recovery','invite','magiclink'].includes(AUTH_LINK_TYPE);
const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });

const STAGES = ['Новая заявка','Связались','Квалификация','КП отправлено','Счёт/договор','Оплата','Отгрузка','Успешно','Отказ'];
const CLOSED = ['Успешно','Отказ'];
const SOURCES = ['Реклама-звонок','WhatsApp','SMS','Сайт','Рекомендация','Другое'];
const TOUCH = { call:'📞 Звонок', whatsapp:'💬 WhatsApp', sms:'✉️ SMS', meeting:'🤝 Встреча', note:'📝 Заметка', system:'⚙️ Система' };

const S = { user:null, team:[], dirs:[], deals:[], tasks:[], dir: localStorage.getItem('crm_dir') || '1', view:'Board', taskScope:'mine', openDeal:null };

const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const show = (el, on=true) => el.classList.toggle('hidden', !on);

function normPhone(p){
  const d = String(p||'').replace(/\D/g,'');
  if (d.length === 11 && (d[0]==='7'||d[0]==='8')) return '+7'+d.slice(1);
  if (d.length === 10) return '+7'+d;
  return null;
}
function fmtPhone(p){ const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(p||''); return m ? `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : (p||''); }
function fmtMoney(n){ return n==null||n==='' ? '' : Number(n).toLocaleString('ru-RU') + ' ₸'; }
function fmtDT(s){ if(!s) return ''; const d=new Date(s); const t=new Date(); const y=new Date(); y.setDate(t.getDate()-1); const tm=new Date(); tm.setDate(t.getDate()+1);
  const hm = d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  if (d.toDateString()===t.toDateString()) return 'сегодня '+hm;
  if (d.toDateString()===y.toDateString()) return 'вчера '+hm;
  if (d.toDateString()===tm.toDateString()) return 'завтра '+hm;
  return d.toLocaleDateString('ru-RU',{day:'numeric',month:'short'})+' '+hm; }
function toLocalInput(s){ const d = s ? new Date(s) : new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
const isOverdue = t => !t.done && new Date(t.due_at) < new Date();
function toast(msg, err){ const t=$('#toast'); t.textContent=msg; t.classList.toggle('err',!!err); show(t); clearTimeout(t._h); t._h=setTimeout(()=>show(t,false), err?4500:2200); }
function errMsg(e){ const m = e?.message || String(e);
  if (/lost_reason_required/.test(m)) return 'Для этапа «Отказ» укажите причину отказа';
  if (/contacts_phone_key|duplicate key/.test(m)) return 'Контакт с таким телефоном уже есть';
  if (/Invalid login/.test(m)) return 'Неверный email или пароль';
  return m; }
async function q(p){ const { data, error } = await p; if (error) throw error; return data; }
const teamName = id => { const m = S.team.find(x=>x.user_id===id); return m ? (m.full_name || m.email) : ''; };

// ---------- Auth ----------
async function boot(){
  const { data:{ session } } = await sb.auth.getSession();
  if (AUTH_LINK_TYPE || AUTH_LINK_ERROR) history.replaceState(null, '', REDIRECT_URL);
  if (!session) {
    showScreen('login');
    if (AUTH_LINK_ERROR) { const m = $('#loginMsg'); m.textContent = 'Ссылка из письма недействительна или устарела. Нажмите «Первый вход / Забыли пароль?» и запросите новую.'; show(m); }
    return;
  }
  S.user = session.user;
  if (needSetPassword) { $('#spEmail').textContent = S.user.email; return showScreen('setpw'); }
  try {
    S.team = await q(sb.from('crm_team').select('*'));
  } catch(e){ S.team = []; }
  if (!S.team.some(m => m.user_id === S.user.id && m.active)) { $('#naEmail').textContent = S.user.email; return showScreen('noaccess'); }
  S.dirs = await q(sb.from('crm_directions').select('*').order('sort'));
  fillSelects();
  showScreen('main');
  await reload();
}
function showScreen(id){ ['login','access','setpw','noaccess','main'].forEach(s => show($('#'+s), s===id)); }
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#loginErr').textContent='';
  const { error } = await sb.auth.signInWithPassword({ email: $('#loginEmail').value.trim(), password: $('#loginPass').value });
  if (error) { $('#loginErr').textContent = errMsg(error); return; }
  boot();
});
// ---------- Первый вход / сброс пароля ----------
function randomPass(){ const b = new Uint8Array(24); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2,'0')).join('') + 'Aa1!'; }
$('#accessForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#accessErr').textContent = ''; show($('#accessMsg'), false);
  const email = $('#accessEmail').value.trim().toLowerCase();
  $('#accessSubmit').disabled = true;
  try {
    const { data: st, error } = await sb.rpc('crm_access_status', { p_email: email });
    if (error) throw error;
    let r = { error: null };
    if (st === 'signup') r = await sb.auth.signUp({ email, password: randomPass(), options: { emailRedirectTo: REDIRECT_URL } });
    else if (st === 'reset') r = await sb.auth.resetPasswordForEmail(email, { redirectTo: REDIRECT_URL });
    if (r.error) {
      if (/rate limit|too many|security purposes/i.test(r.error.message)) throw new Error('Письмо уже отправлялось недавно. Подождите и попробуйте позже (до 1 часа).');
      throw new Error('Не удалось отправить письмо. Попробуйте позже.');
    }
    const m = $('#accessMsg');
    m.innerHTML = `Если <b>${esc(email)}</b> есть в списке команды, на него отправлено письмо со ссылкой. Откройте его на этом устройстве и нажмите ссылку — откроется экран «Задать пароль». Проверьте папку «Спам».`;
    show(m);
  } catch(er){ $('#accessErr').textContent = er.message || String(er); }
  finally { $('#accessSubmit').disabled = false; }
});
$('#setpwForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#spErr').textContent = '';
  const p1 = $('#spPass1').value, p2 = $('#spPass2').value;
  if (p1.length < 8) { $('#spErr').textContent = 'Минимум 8 символов'; return; }
  if (p1 !== p2) { $('#spErr').textContent = 'Пароли не совпадают'; return; }
  $('#spSubmit').disabled = true;
  const { error } = await sb.auth.updateUser({ password: p1 });
  $('#spSubmit').disabled = false;
  if (error) { $('#spErr').textContent = /different from the old|same/i.test(error.message) ? 'Новый пароль должен отличаться от старого' : /weak|short|characters/i.test(error.message) ? 'Пароль слишком простой, придумайте сложнее' : error.message; return; }
  needSetPassword = false; toast('Пароль сохранён ✓'); boot();
});

async function logout(){ await sb.auth.signOut(); S.deals=[]; S.tasks=[]; showScreen('login'); }

// ---------- Data ----------
function fillSelects(){
  const opts = S.dirs.filter(d=>d.active || d.id==S.dir).map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('');
  $('#dirFilter').innerHTML = `<option value="all">Все направления</option>` + opts;
  if (![...$('#dirFilter').options].some(o=>o.value==S.dir)) S.dir='1';
  $('#dirFilter').value = S.dir;
  $('#leadDir').innerHTML = S.dirs.filter(d=>d.active).map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('');
  $('#leadSource').innerHTML = SOURCES.map(s=>`<option>${s}</option>`).join('');
}
async function reload(){
  try {
    let dq = sb.from('crm_deals_full').select('*').order('updated_at', { ascending:false }).limit(2000);
    if (S.dir !== 'all') dq = dq.eq('direction_id', S.dir);
    let tq = sb.from('crm_tasks_full').select('*').order('due_at').limit(2000);
    if (S.dir !== 'all') tq = tq.eq('direction_id', S.dir);
    [S.deals, S.tasks] = await Promise.all([q(dq), q(tq)]);
  } catch(e){ toast(errMsg(e), true); }
  render();
}
function render(){ renderBoard(); renderList(); renderTasks(); }

// ---------- Board ----------
function dealCardHTML(d){
  const od = d.next_due && new Date(d.next_due) < new Date();
  return `<div class="dcard ${od?'overdue':''}" draggable="${matchMedia('(pointer:fine)').matches}" data-deal="${d.id}">
    <div class="nm">${esc(d.contact_name || 'Без имени')}</div>
    <div class="ph">${esc(fmtPhone(d.phone))}</div>
    <div class="meta">
      ${d.city||d.contact_city ? `<span>📍 ${esc(d.city||d.contact_city)}</span>`:''}
      ${d.amount ? `<span>💰 ${esc(fmtMoney(d.amount))}</span>`:''}
      ${d.quantity>1 ? `<span>× ${d.quantity}</span>`:''}
      ${d.next_due ? `<span class="${od?'od':''}">⏰ ${esc(fmtDT(d.next_due))}</span>`:''}
      ${d.stage==='Отказ' && d.lost_reason ? `<span>✖ ${esc(d.lost_reason)}</span>`:''}
    </div>
    <select class="mv" data-mv="${d.id}" aria-label="Этап">${STAGES.map(s=>`<option ${s===d.stage?'selected':''}>${s}</option>`).join('')}</select>
  </div>`;
}
function renderBoard(){
  $('#board').innerHTML = STAGES.map(st => {
    const ds = S.deals.filter(d => d.stage === st);
    const sum = ds.reduce((a,d)=>a+Number(d.amount||0),0);
    return `<div class="col" data-stage="${st}"><div class="col-head"><span>${st} · ${ds.length}</span>${sum?`<small>${fmtMoney(sum)}</small>`:''}</div>
      <div class="col-body">${ds.map(dealCardHTML).join('') || '<div class="muted small" style="padding:8px">—</div>'}</div></div>`;
  }).join('');
}
// drag & drop (desktop)
let dragId = null;
document.addEventListener('dragstart', e => { const c = e.target.closest?.('.dcard'); if (c) { dragId = c.dataset.deal; e.dataTransfer.effectAllowed='move'; } });
document.addEventListener('dragover', e => { const col = e.target.closest?.('.col'); if (col && dragId) { e.preventDefault(); $$('.col.drop').forEach(x=>x!==col&&x.classList.remove('drop')); col.classList.add('drop'); } });
document.addEventListener('drop', e => { const col = e.target.closest?.('.col'); $$('.col.drop').forEach(x=>x.classList.remove('drop')); if (col && dragId) { e.preventDefault(); changeStage(dragId, col.dataset.stage); } dragId=null; });
document.addEventListener('dragend', () => { $$('.col.drop').forEach(x=>x.classList.remove('drop')); dragId=null; });

async function changeStage(id, stage, extra={}){
  const d = S.deals.find(x=>x.id===id);
  if (!d || d.stage === stage) return render();
  const patch = { stage, ...extra };
  if (stage === 'Отказ' && !patch.lost_reason) {
    const r = prompt('Причина отказа (обязательно):', d.lost_reason || '');
    if (!r || !r.trim()) { toast('Без причины отказ не сохраняется', true); return render(); }
    patch.lost_reason = r.trim();
  }
  try { await q(sb.from('crm_deals').update(patch).eq('id', id).select('id')); toast(`Этап: ${stage}`); }
  catch(e){ toast(errMsg(e), true); }
  await reload();
  if (S.openDeal === id) openDeal(id);
}

// ---------- List ----------
function renderList(){
  const term = $('#search').value.trim().toLowerCase();
  const digits = term.replace(/\D/g,'');
  const showClosed = $('#showClosed').checked || !!term;
  let ds = S.deals.filter(d => showClosed || !CLOSED.includes(d.stage));
  if (term) ds = ds.filter(d => (d.contact_name||'').toLowerCase().includes(term) || (digits.length>=3 && (d.phone||'').replace(/\D/g,'').includes(digits.length===11 && digits[0]==='8' ? '7'+digits.slice(1) : digits)) || (d.city||'').toLowerCase().includes(term));
  $('#list').innerHTML = ds.map(d => `<div class="item" data-deal="${d.id}">
      <div class="grow"><div class="nm">${esc(d.contact_name||'Без имени')}</div>
      <div class="sub">${esc(fmtPhone(d.phone))}${d.city?' · '+esc(d.city):''}${d.amount?' · '+esc(fmtMoney(d.amount)):''}</div></div>
      <span class="chip ${d.stage==='Отказ'?'lost':d.stage==='Успешно'?'won':''}">${esc(d.stage)}</span></div>`).join('')
    || `<div class="empty">${term ? 'Ничего не найдено' : 'Пока нет сделок. Нажмите «＋ Лид».'}</div>`;
}
$('#search').addEventListener('input', renderList);
$('#showClosed').addEventListener('change', renderList);

// ---------- Tasks ----------
function taskItemHTML(t){
  return `<div class="item task ${isOverdue(t)?'overdue':''} ${t.done?'done':''}" data-deal="${t.deal_id}">
    <input type="checkbox" data-taskdone="${t.id}" ${t.done?'checked':''} aria-label="Выполнено">
    <div class="grow"><div class="nm">${esc(t.title)}</div>
    <div class="sub"><span class="due">⏰ ${esc(fmtDT(t.due_at))}</span> · ${esc(t.contact_name||fmtPhone(t.phone))}${S.taskScope!=='mine'&&t.assignee_name?' · 👤 '+esc(t.assignee_name):''}</div></div>
    <span class="chip">${esc(t.stage)}</span></div>`;
}
function renderTasks(){
  const me = S.user?.id;
  const mineOpen = S.tasks.filter(t => !t.done && (t.assignee === me || !t.assignee));
  const nOver = mineOpen.filter(isOverdue).length;
  const b = $('#taskBadge'); b.textContent = nOver; show(b, nOver>0);
  let ts;
  if (S.taskScope === 'done') ts = S.tasks.filter(t=>t.done).sort((a,b)=>new Date(b.done_at)-new Date(a.done_at)).slice(0,100);
  else ts = S.tasks.filter(t => !t.done && (S.taskScope==='all' || t.assignee===me || !t.assignee));
  if (!ts.length) { $('#tasks').innerHTML = '<div class="empty">Задач нет 🎉</div>'; return; }
  if (S.taskScope === 'done') { $('#tasks').innerHTML = ts.map(taskItemHTML).join(''); return; }
  const eod = new Date(); eod.setHours(23,59,59,999);
  const g = { over: ts.filter(isOverdue), today: ts.filter(t=>!isOverdue(t) && new Date(t.due_at)<=eod), later: ts.filter(t=>new Date(t.due_at)>eod) };
  $('#tasks').innerHTML =
    (g.over.length ? `<div class="group-h red">Просрочено · ${g.over.length}</div>${g.over.map(taskItemHTML).join('')}` : '') +
    (g.today.length ? `<div class="group-h">Сегодня · ${g.today.length}</div>${g.today.map(taskItemHTML).join('')}` : '') +
    (g.later.length ? `<div class="group-h">Позже · ${g.later.length}</div>${g.later.map(taskItemHTML).join('')}` : '');
}
async function setTaskDone(id, done){
  try { await q(sb.from('crm_tasks').update({ done }).eq('id', id).select('id')); toast(done ? 'Задача выполнена ✓' : 'Задача снова открыта'); }
  catch(e){ toast(errMsg(e), true); }
  await reload(); if (S.openDeal) openDeal(S.openDeal);
}

// ---------- New lead ----------
let findT = null, found = null;
function openLead(prefill={}){
  $('#leadForm').reset(); $('#leadErr').textContent=''; show($('#leadHint'), false); found = null;
  $('#leadSource').value = 'Реклама-звонок';
  $('#leadDir').value = S.dir !== 'all' ? S.dir : '1';
  if (prefill.phone) $('#leadPhone').value = prefill.phone;
  show($('#leadSheet')); setTimeout(()=>$('#leadPhone').focus(), 50);
}
$('#leadPhone').addEventListener('input', () => {
  clearTimeout(findT); const p = normPhone($('#leadPhone').value); const h = $('#leadHint');
  if (!p) { found=null; show(h,false); return; }
  findT = setTimeout(async () => {
    try {
      const r = await q(sb.rpc('crm_find_contact', { p_phone: p }));
      found = r[0] || null;
      if (found) {
        h.className = 'hint';
        h.innerHTML = `👤 Контакт уже есть: <b>${esc(found.name||'без имени')}</b> (${esc(fmtPhone(found.phone))})` +
          (found.open_deal_id ? `<br>Открытая сделка на этапе «${esc(found.open_stage)}» — касание добавится в неё. <a href="#" data-opendeal="${found.open_deal_id}">Открыть</a>` : '<br>Открытых сделок нет — будет создана новая.');
        if (!$('#leadName').value && found.name) $('#leadName').placeholder = found.name;
        if (!$('#leadCity').value && found.city) $('#leadCity').placeholder = found.city;
      } else { h.className='hint ok'; h.textContent = '✓ Новый номер — будет создан контакт и сделка «Новая заявка»'; }
      show(h);
    } catch(e){ show(h,false); }
  }, 300);
});
$('#leadForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#leadErr').textContent='';
  const p = normPhone($('#leadPhone').value);
  if (!p) { $('#leadErr').textContent = 'Номер в формате 8 700 000 00 00 или +7…'; return; }
  $('#leadSubmit').disabled = true;
  try {
    const r = await q(sb.rpc('crm_create_lead', { p_phone: p, p_name: $('#leadName').value.trim()||null, p_source: $('#leadSource').value,
      p_text: $('#leadText').value.trim()||null, p_direction: Number($('#leadDir').value)||1, p_city: $('#leadCity').value.trim()||null }));
    show($('#leadSheet'), false);
    toast(r.new_deal ? 'Лид создан ✓' : 'Добавлено в существующую сделку ✓');
    await reload(); openDeal(r.deal_id);
  } catch(e){ $('#leadErr').textContent = errMsg(e); }
  finally { $('#leadSubmit').disabled = false; }
});

// ---------- Deal card ----------
async function openDeal(id){
  S.openDeal = id; const body = $('#dealBody');
  if ($('#dealSheet').classList.contains('hidden')) body.innerHTML = '<p class="muted">Загрузка…</p>';
  show($('#dealSheet'));
  let d, c, touches, tasks;
  try {
    d = (await q(sb.from('crm_deals').select('*').eq('id', id)))[0];
    if (!d) { body.innerHTML = '<p>Сделка не найдена</p>'; return; }
    [c, touches, tasks] = await Promise.all([
      q(sb.from('crm_contacts').select('*').eq('id', d.contact_id)).then(r=>r[0]),
      q(sb.from('crm_touches').select('*').eq('contact_id', d.contact_id).order('created_at', { ascending:false }).limit(200)),
      q(sb.from('crm_tasks').select('*').eq('deal_id', id).order('done').order('due_at'))
    ]);
  } catch(e){ body.innerHTML = `<p class="err">${esc(errMsg(e))}</p>`; return; }
  const sel = (name, opts, val) => `<select name="${name}">${opts.map(o=>Array.isArray(o)?`<option value="${esc(o[0])}" ${String(o[0])===String(val??'')?'selected':''}>${esc(o[1])}</option>`:`<option ${o===val?'selected':''}>${esc(o)}</option>`).join('')}</select>`;
  const inp = (name, val, attrs='') => `<input name="${name}" value="${esc(val??'')}" ${attrs}>`;
  const wa = c.phone.replace('+','');
  const dirOpts = S.dirs.filter(x=>x.active||x.id===d.direction_id).map(x=>[x.id,x.name]);
  const teamOpts = [['','— не назначен —'], ...S.team.filter(m=>m.active||m.user_id===d.responsible).map(m=>[m.user_id, m.full_name||m.email])];
  body.innerHTML = `
  <div class="sheet-head"><h2>${esc(c.name || 'Без имени')}</h2><button class="icon-btn" data-close>✕</button></div>
  <div class="actions">
    <a class="btn sm" href="tel:${esc(c.phone)}">📞 ${esc(fmtPhone(c.phone))}</a>
    <a class="btn sm" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">💬 WhatsApp</a>
  </div>
  <form id="dealForm">
    <label>Этап <select name="stage" class="stage-sel">${STAGES.map(s=>`<option ${s===d.stage?'selected':''}>${s}</option>`).join('')}</select></label>
    <div class="box lost-box ${d.stage==='Отказ'?'':'hidden'}" id="lostBox"><label>Причина отказа *<input name="lost_reason" value="${esc(d.lost_reason||'')}"></label></div>
    <div class="box"><h3>Клиент</h3>
      <div class="row2"><label>Имя${inp('c_name', c.name)}</label><label>Телефон${inp('c_phone', fmtPhone(c.phone), 'type="tel" inputmode="tel"')}</label></div>
      <label>Заметки о клиенте<textarea name="c_notes" rows="2">${esc(c.notes||'')}</textarea></label>
    </div>
    <div class="box"><h3>Сделка</h3>
      <div class="row2"><label>Направление${sel('direction_id', dirOpts, d.direction_id)}</label><label>Источник${sel('source', SOURCES, d.source)}</label></div>
      <div class="row2"><label>Ответственный${sel('responsible', teamOpts, d.responsible)}</label><label>Товар${inp('product', d.product)}</label></div>
      <div class="row2"><label>Количество${inp('quantity', d.quantity, 'type="number" min="0" inputmode="numeric"')}</label><label>Сумма, ₸${inp('amount', d.amount, 'type="number" min="0" step="1" inputmode="decimal"')}</label></div>
      <label>Условие оплаты${inp('payment_terms', d.payment_terms, 'placeholder="100% предоплата / 50/50 / лизинг…"')}</label>
      <label>Комментарии<textarea name="comments" rows="2">${esc(d.comments||'')}</textarea></label>
    </div>
    <div class="box"><h3>Квалификация</h3>
      <div class="row2"><label>Город${inp('city', d.city ?? c.city)}</label><label>Срок${inp('deadline', d.deadline, 'placeholder="когда нужна техника"')}</label></div>
      <label>Для чего нужна техника${inp('purpose', d.purpose)}</label>
      <div class="row2"><label>Бюджет${inp('budget', d.budget)}</label><label>Кто решает${inp('decision_maker', d.decision_maker)}</label></div>
    </div>
    <div class="sticky-save"><button class="btn primary big" type="submit">Сохранить</button></div>
  </form>

  <div class="box"><h3>Задачи</h3>
    ${tasks.map(t=>`<div class="item task ${isOverdue(t)?'overdue':''} ${t.done?'done':''}"><input type="checkbox" data-taskdone="${t.id}" ${t.done?'checked':''}>
      <div class="grow"><div class="nm">${esc(t.title)}</div><div class="sub"><span class="due">⏰ ${esc(fmtDT(t.due_at))}</span>${t.assignee?' · 👤 '+esc(teamName(t.assignee)):''}${t.auto?' · авто':''}</div></div>
      <button class="icon-btn" data-taskdel="${t.id}" title="Удалить">🗑</button></div>`).join('') || '<p class="muted small">Нет задач</p>'}
    <form id="taskForm" class="inline" style="flex-wrap:wrap">
      <input name="title" placeholder="Новая задача" required style="flex:2 1 160px">
      <input name="due" type="datetime-local" value="${toLocalInput(new Date(Date.now()+86400000).toISOString())}" style="flex:1 1 150px">
      <button class="btn" type="submit">＋</button>
    </form>
  </div>

  <div class="box"><h3>История касаний</h3>
    <form id="touchForm">
      <div class="inline"><select name="kind" style="flex:0 0 140px">${Object.entries(TOUCH).filter(([k])=>k!=='system').map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select>
      <input name="body" placeholder="Что обсудили" required><button class="btn" type="submit">＋</button></div>
    </form>
    ${touches.map(t=>`<div class="touch ${t.kind==='system'?'system':''}"><div class="t">${TOUCH[t.kind]||t.kind} · ${esc(fmtDT(t.created_at))}${t.created_by?' · '+esc(teamName(t.created_by)):''}${t.deal_id&&t.deal_id!==id?' · другая сделка':''}</div><div class="b">${esc(t.body||'')}</div></div>`).join('') || '<p class="muted small">Пока пусто</p>'}
  </div>
  <p class="muted small">Создана ${esc(fmtDT(d.created_at))} · этап с ${esc(fmtDT(d.stage_changed_at))}</p>`;

  const f = $('#dealForm');
  f.stage.addEventListener('change', () => show($('#lostBox'), f.stage.value === 'Отказ'));
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const v = n => { const x = f[n].value.trim(); return x === '' ? null : x; };
    if (f.stage.value === 'Отказ' && !v('lost_reason')) { toast('Укажите причину отказа', true); f.lost_reason.focus(); return; }
    const newPhone = normPhone(f.c_phone.value);
    if (!newPhone) { toast('Неверный телефон', true); return; }
    try {
      await q(sb.from('crm_contacts').update({ name: v('c_name'), phone: newPhone, notes: v('c_notes'), city: c.city ?? v('city') }).eq('id', c.id).select('id'));
      await q(sb.from('crm_deals').update({
        stage: f.stage.value, lost_reason: v('lost_reason'), direction_id: Number(f.direction_id.value), source: f.source.value,
        responsible: v('responsible'), product: v('product'), quantity: v('quantity')==null?null:Number(v('quantity')), amount: v('amount')==null?null:Number(v('amount')),
        payment_terms: v('payment_terms'), comments: v('comments'), city: v('city'), deadline: v('deadline'), purpose: v('purpose'),
        budget: v('budget'), decision_maker: v('decision_maker') }).eq('id', id).select('id'));
      toast('Сохранено ✓'); await reload(); openDeal(id);
    } catch(e){ toast(errMsg(e), true); }
  });
  $('#taskForm').addEventListener('submit', async e => {
    e.preventDefault(); const tf = e.target;
    try { await q(sb.from('crm_tasks').insert({ deal_id: id, title: tf.title.value.trim(), due_at: new Date(tf.due.value).toISOString(), assignee: d.responsible || S.user.id }).select('id'));
      toast('Задача добавлена'); await reload(); openDeal(id); } catch(e){ toast(errMsg(e), true); }
  });
  $('#touchForm').addEventListener('submit', async e => {
    e.preventDefault(); const tf = e.target;
    try { await q(sb.from('crm_touches').insert({ deal_id: id, contact_id: d.contact_id, kind: tf.kind.value, body: tf.body.value.trim() }).select('id'));
      await q(sb.from('crm_deals').update({ comments: d.comments }).eq('id', id).select('id')); // обновить updated_at
      toast('Касание добавлено'); await reload(); openDeal(id); } catch(e){ toast(errMsg(e), true); }
  });
}
function closeSheets(){ $$('.sheet').forEach(s=>show(s,false)); $('#dealBody').innerHTML = ''; S.openDeal = null; }

// ---------- Global events ----------
document.addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('[data-close]') || t.classList.contains('sheet')) return closeSheets();
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'logout') return logout();
  if (act === 'showAccess') { e.preventDefault(); $('#accessEmail').value = $('#loginEmail').value; show($('#accessMsg'), false); $('#accessErr').textContent=''; return showScreen('access'); }
  if (act === 'showLogin') { e.preventDefault(); return showScreen('login'); }
  if (act === 'refresh') { await reload(); return toast('Обновлено'); }
  if (act === 'newLead') return openLead();
  const tab = t.closest('[data-view]');
  if (tab) { S.view = tab.dataset.view; $$('.tab').forEach(x=>x.classList.toggle('active', x===tab)); ['Board','List','Tasks'].forEach(v=>show($('#view'+v), v===S.view)); return; }
  const sc = t.closest('[data-taskscope]');
  if (sc) { S.taskScope = sc.dataset.taskscope; $$('.seg-btn').forEach(x=>x.classList.toggle('active', x===sc)); return renderTasks(); }
  const od = t.closest('[data-opendeal]');
  if (od) { e.preventDefault(); show($('#leadSheet'), false); return openDeal(od.dataset.opendeal); }
  const del = t.closest('[data-taskdel]');
  if (del) { if (confirm('Удалить задачу?')) { try { await q(sb.from('crm_tasks').delete().eq('id', del.dataset.taskdel)); } catch(er){ toast(errMsg(er), true); } await reload(); if (S.openDeal) openDeal(S.openDeal); } return; }
  if (t.matches('input[data-taskdone], select')) return;
  const card = t.closest('[data-deal]');
  if (card && !t.closest('#dealSheet')) return openDeal(card.dataset.deal);
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-taskdone]')) return setTaskDone(t.dataset.taskdone, t.checked);
  if (t.matches('[data-mv]')) return changeStage(t.dataset.mv, t.value);
  if (t.id === 'dirFilter') { S.dir = t.value; localStorage.setItem('crm_dir', S.dir); reload(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user && !$('#main').classList.contains('hidden')) reload(); });
sb.auth.onAuthStateChange((ev, session) => {
  if (ev === 'SIGNED_OUT') showScreen('login');
  if (ev === 'PASSWORD_RECOVERY' && session) { needSetPassword = true; $('#spEmail').textContent = session.user.email; showScreen('setpw'); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
boot();
