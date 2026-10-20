// משחק כיתתי מסונכרן. JavaScript מודולרי, בלי build או שרת משלכם.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getDatabase, ref, get, set, update, remove, runTransaction, onValue, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const { QUESTIONS, TYPES, makePlot, esc } = window.quizShared;
const $ = id => document.getElementById(id);
const SESSION_KEY = 'continuity-quiz-live-session-v2';
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const configured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.databaseURL && firebaseConfig.appId && !Object.values(firebaseConfig).some(v => String(v).includes('PASTE_')));
let db = null, auth = null, connectPromise = null;
let inProgress = false;
const live = { code: '', role: '', uid: '', meta: null, players: {}, answers: {}, unsubs: [], stageKey: '', clock: null, serverOffset: 0, autoReveal: false };

const cleanCode = v => String(v || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
const codeURL = code => { const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('room', code); return u.href; };
const metaRef = () => ref(db, `rooms/${live.code}/meta`);
const safeStore = data => { try { if(data) localStorage.setItem(SESSION_KEY, JSON.stringify(data)); else localStorage.removeItem(SESSION_KEY); } catch {} };
const safeLoad = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } };
const setupError = message => { $('liveSetupError').textContent = message || ''; };
const roomError = message => { $('liveRoomError').textContent = message || ''; };
const errorText = e => {
  const c = String(e?.code || '');
  if(c.includes('permission-denied')) return 'הפעולה לא אושרה. ודאו שפרסמתם את כללי Realtime Database שמצורפים לפרויקט, שהחדר עדיין פתוח ושלא נגמר הזמן.';
  if(c.includes('network') || c.includes('unavailable') || c.includes('disconnected')) return 'נראה שאין חיבור יציב לאינטרנט. בדקו את הרשת ונסו שוב.';
  if(c.includes('auth/operation-not-allowed')) return 'יש להפעיל Anonymous ב־Firebase Authentication → Sign-in method.';
  if(c.includes('auth/unauthorized-domain')) return 'יש להוסיף את דומיין האתר ב־Firebase Authentication → Settings → Authorized domains.';
  if(c.includes('auth/')) return `שגיאת התחברות ל־Firebase: ${c}`;
  return `לא הצלחנו להשלים את הפעולה: ${e?.message || 'שגיאה לא ידועה'}`;
};
function setBusy(flag) {
  inProgress = flag;
  for(const id of ['createRoom', 'joinRoom']) $(id).disabled = flag || !configured;
}
async function ensureConnection() {
  if(!configured) throw new Error('חסר קובץ הגדרות Firebase. ראו README.md (firebase-config.js וכללי מסד הנתונים).');
  if(!connectPromise) {
    connectPromise = (async () => {
      const app = initializeApp(firebaseConfig);
      auth = getAuth(app);
      db = getDatabase(app);
      const credential = await signInAnonymously(auth);
      live.uid = credential.user.uid;
      onValue(ref(db, '.info/serverTimeOffset'), snapshot => { live.serverOffset = Number(snapshot.val()) || 0; });
      return credential.user;
    })().catch(e => { connectPromise = null; throw e; });
  }
  return connectPromise;
}
async function setupConnection() {
  if(!configured) {
    $('liveConnectionMessage').innerHTML = '⚙️ <strong>דרושה הגדרה חד־פעמית:</strong> ממלאים firebase-config.js, מפעילים התחברות אנונימית ומפרסמים את database.rules.json. ההוראות המדויקות ב־README.md. המשחק האישי עובד בינתיים.';
    return;
  }
  $('liveConnectionMessage').textContent = 'מתחבר למערכת החדרים…';
  try {
    await ensureConnection();
    $('liveConnectionMessage').textContent = '✅ מחובר! אפשר ליצור חדר או להצטרף לחדר קיים.';
    setupError('');
  } catch(e) {
    $('liveConnectionMessage').textContent = '⚠️ החיבור למערכת החדרים לא הושלם.';
    setupError(errorText(e));
  }
}
async function createRoom() {
  if(inProgress) return;
  setupError(''); setBusy(true);
  try {
    await ensureConnection();
    for(let attempt=0;attempt<6;attempt++) {
      const random = crypto.getRandomValues(new Uint8Array(6));
      const code = [...random].map(n => alphabet[n % alphabet.length]).join('');
      const roomNode = ref(db, `rooms/${code}`);
      const created = await runTransaction(roomNode, current => {
        if(current !== null) return;
        return { meta: { hostUid:live.uid, phase:'lobby', index:-1, questionKey:'', timerEnabled:$('liveUseTimer').checked, deadline:0, createdAt:Date.now() } };
      }, {applyLocally:false});
      if(created.committed) {
        safeStore({code, role:'host', uid:live.uid});
        attachRoom(code, 'host');
        return;
      }
    }
    throw new Error('לא הצלחנו להקצות קוד חדר. נסו שוב.');
  } catch(e) { setupError(errorText(e)); }
  finally { setBusy(false); }
}
async function joinRoom() {
  if(inProgress) return;
  setupError('');
  const nickname = $('liveNickname').value.trim().replace(/\s+/g,' ');
  const code = cleanCode($('liveJoinCode').value);
  if(nickname.length < 1 || nickname.length > 20) { setupError('נא להזין כינוי של 1–20 תווים.'); return; }
  if(code.length !== 6) { setupError('נא להזין קוד חדר בן 6 תווים.'); return; }
  setBusy(true);
  try {
    await ensureConnection();
    const roomMeta = (await get(ref(db, `rooms/${code}/meta`))).val();
    if(!roomMeta) throw new Error('לא נמצא חדר עם הקוד הזה.');
    if(roomMeta.phase === 'finished') throw new Error('המשחק הזה כבר הסתיים. בקשו מהמתרגל קוד חדש.');
    const playerRef = ref(db, `rooms/${code}/players/${live.uid}`);
    const existing = (await get(playerRef)).val();
    if(!existing) await set(playerRef, {name:nickname, joinedAt:serverTimestamp()});
    safeStore({code, role:'student', uid:live.uid});
    attachRoom(code, 'student');
  } catch(e) { setupError(errorText(e)); }
  finally { setBusy(false); }
}
function detachRoom() {
  for(const unsub of live.unsubs.splice(0)) try { unsub(); } catch {}
  if(live.clock) { clearInterval(live.clock); live.clock = null; }
  live.code=''; live.role=''; live.meta=null; live.players={}; live.answers={}; live.stageKey=''; live.autoReveal=false;
}
function attachRoom(code,role) {
  detachRoom();
  live.code = code; live.role = role;
  $('liveRoomCode').textContent=code;
  $('liveRoleLabel').textContent=role==='host'?'🎓 מסך המתרגל':'📱 משחק כיתתי';
  $('liveInviteLink').textContent=codeURL(code);
  $('liveInviteLink').href=codeURL(code);
  roomError(''); $('liveStage').innerHTML='<p class="live-status">טוענים את פרטי החדר…</p>';
  window.quizShow('liveRoom');
  const roomBase = `rooms/${code}`;
  live.unsubs.push(onValue(ref(db,`${roomBase}/meta`), snapshot => {
    if(code !== live.code) return;
    const meta = snapshot.val();
    if(!meta) { roomError('החדר נסגר על ידי המתרגל.'); safeStore(null); detachRoom(); $('liveStage').innerHTML='<div class="live-panel"><h2>החדר אינו זמין</h2><button class="btn primary" id="liveClosedBack">בחזרה להתחלה</button></div>'; return; }
    live.meta=meta; renderLive();
  }, e=>roomError(errorText(e))));
  live.unsubs.push(onValue(ref(db,`${roomBase}/players`), snapshot => {
    if(code !== live.code) return;
    live.players=snapshot.val() || {}; renderLive();
  }, e=>roomError(errorText(e))));
  live.unsubs.push(onValue(ref(db,`${roomBase}/answers`), snapshot => {
    if(code !== live.code) return;
    live.answers=snapshot.val() || {}; renderLive();
  }, e=>roomError(errorText(e))));
  live.clock=setInterval(updateClock, 350);
}
const nowServer = () => Date.now() + live.serverOffset;
function updateClock() {
  const meta=live.meta;
  if(!meta || meta.phase !== 'question' || !meta.timerEnabled) return;
  const remaining=Math.max(0,Math.ceil((meta.deadline-nowServer())/1000));
  const span=$('liveCountdown');
  if(span) { span.textContent=`⏳ ${remaining} שניות`; span.style.color=remaining<=6?'#ff98a9':'#ffe2a7'; }
  if(live.role==='student' && remaining===0) refreshStudentChoices();
  if(live.role==='host' && remaining===0 && !live.autoReveal) {
    live.autoReveal=true;
    revealQuestion().catch(e=>{live.autoReveal=false;roomError(errorText(e));});
  }
}
function getPlayerScores() {
  const m=live.meta;
  const last=m?.phase==='lobby' ? -1 : m?.phase==='question'?m.index-1:m?.index ?? -1;
  return Object.entries(live.players).map(([uid, profile]) => {
    let score=0, correct=0;
    for(let i=0;i<=last && i<QUESTIONS.length;i++) {
      if(live.answers[`q${i}`]?.[uid]?.choice === QUESTIONS[i].type) { score+=100;correct++; }
    }
    return {uid, name:profile.name || 'ללא כינוי', score, correct};
  }).sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name, 'he') || a.uid.localeCompare(b.uid));
}
function boardHTML(max=40) {
  const rank=getPlayerScores();
  const mine=rank.findIndex(p=>p.uid===live.uid);
  const visible=rank.slice(0,max);
  if(mine>=max) visible.push({...rank[mine], actualRank:mine+1});
  return `<div class="live-board"><h3>🏆 Leaderboard — טבלת המובילים</h3>${visible.length?visible.map((p,i)=>`<div class="live-rank ${p.uid===live.uid&&live.role==='student'?'me':''}"><b>${p.actualRank || i+1}${i===0?' 🥇':i===1?' 🥈':i===2?' 🥉':''}</b><span dir="auto">${esc(p.name)}${p.uid===live.uid&&live.role==='student'?' (אני)':''}</span><b>${p.score}</b></div>`).join(''):'<p class="live-meta">עדיין אין משתתפים.</p>'}<p class="note">100 נקודות לכל תשובה נכונה. הניקוד מתעדכן רק כשהתשובה נחשפת. שוויון בניקוד אפשרי.</p></div>`;
}
function countsForCurrent() {
  const votes=Object.entries(live.answers[`q${live.meta.index}`] || {}).filter(([uid])=>Boolean(live.players[uid]));
  const counts=TYPES.map((_,j)=>votes.filter(([,x])=>x.choice===j).length);
  return {counts, voted:votes.length};
}
function statsHTML(showCorrect=false) {
  const {counts,voted}=countsForCurrent();
  const correct=QUESTIONS[live.meta.index]?.type;
  const total=Object.keys(live.players).length;
  return `<div class="live-board"><strong>תשובות שהתקבלו: ${voted} מתוך ${total}</strong><div class="live-stats">${counts.map((n,i)=>`<div class="live-stat ${showCorrect && i===correct?'winner':''}"><span>${esc(TYPES[i])}</span><div class="live-track"><div class="live-fill" style="width:${voted?Math.round(n*100/voted):0}%"></div></div><b>${n}</b></div>`).join('')}</div>${!showCorrect?'<p class="note">העמודות גלויות למתרגל בלבד עד לחשיפה.</p>':''}</div>`;
}
function hostControls() {
  const phase=live.meta.phase;
  if(phase==='lobby') return `<div class="live-actions"><button class="btn primary" data-action="start">התחל משחק — שאלה 1 ←</button></div>`;
  if(phase==='question') return '<div class="live-actions"><button class="btn primary" data-action="reveal">חשוף תשובה וניקוד</button></div>';
  if(phase==='revealed') return `<div class="live-actions"><button class="btn primary" data-action="next">${live.meta.index===QUESTIONS.length-1?'סיום המשחק והצגת דירוג 🏆':'לשאלה הבאה ←'}</button></div>`;
  return '<div class="live-actions"><button class="btn secondary" data-action="close">סגור ומחק את החדר</button></div>';
}
function stageMarkup() {
  const m=live.meta, host=live.role==='host', count=Object.keys(live.players).length;
  if(m.phase==='lobby') {
    return `<div class="live-panel"><h2>חדר המתנה — ${count} משתתפים</h2><p class="live-meta">${host?'שתפו את הקוד או קישור ההזמנה. כשכולם הצטרפו לחצו על התחלה.':'נכנסת למשחק! ממתינים שהמתרגל יתחיל.'}</p><div id="liveNames"></div>${host?hostControls():''}</div><div id="liveBoardPlace"></div>`;
  }
  if(m.phase==='finished') {
    return `<div class="live-panel"><h2>🎊 המשחק הסתיים!</h2><p class="live-meta">תשע שאלות על אי־רציפות. כל הכבוד לכל המשתתפים!</p>${host?hostControls():''}</div><div id="liveBoardPlace"></div>`;
  }
  const q=QUESTIONS[m.index];
  if(!q) return '<div class="live-panel">מספר שאלה לא תקין.</div>';
  const studentAnswer = live.answers[`q${m.index}`]?.[live.uid]?.choice;
  return `<div class="live-head"><span class="live-badge">שאלה ${m.index+1} מתוך ${QUESTIONS.length}</span><span class="live-badge" id="liveCountdown">${m.timerEnabled?'⏳ 30 שניות':'ללא הגבלת זמן'}</span></div>
    <div class="progress"><div style="width:${100*(m.index+(m.phase==='revealed'?1:0))/QUESTIONS.length}%"></div></div>
    <div class="quiz-layout">
      <div class="graph-card"><div class="graph-title">גרף הפונקציה — סביב x = ${q.at}</div><div class="plot-wrap">${makePlot(q)}</div>
      <div class="legend"><span><i class="symbol"></i> עיגול ריק</span><span><i class="symbol filled"></i> ערך הפונקציה</span><span><i class="symbol line"></i> הנקודה לבדיקה</span></div></div>
      <div class="answer-card"><h2 class="question">מהו סוג אי־הרציפות ב־x = ${q.at}?</h2>
        ${host?'<p class="prompt">הסטודנטים עונים עכשיו מהטלפונים.</p>': '<p class="prompt">בחרו את סוג אי־הרציפות. רק תשובה אחת נקלטת.</p>'}
        ${host?'<div id="liveStats"></div>':`<div id="liveStudentChoices">${TYPES.map((t,i)=>`<button class="choice" data-action="answer" data-choice="${i}"><span class="letter">${i+1}</span><span>אי־רציפות ${esc(t)}</span></button>`).join('')}</div><div id="liveAnswerReceipt"></div>`}
        <div id="liveRevealFeedback"></div>
        ${host?hostControls():''}
      </div>
    </div><div id="liveBoardPlace"></div>`;
}
function renderLive() {
  if(!live.meta || !live.code) return;
  const key=`${live.role}:${live.meta.phase}:${live.meta.index}`;
  if(key!==live.stageKey) {
    live.stageKey=key;
    $('liveStage').innerHTML=stageMarkup();
  }
  const m=live.meta;
  if(m.phase==='lobby') {
    const names=$('liveNames');
    if(names) names.innerHTML=`<div class="live-names">${Object.values(live.players).map(p=>`<span class="live-name" dir="auto">${esc(p.name||'ללא כינוי')}</span>`).join('')}</div>`;
    const lobbyHeading=$('liveStage').querySelector('h2');
    if(lobbyHeading) lobbyHeading.textContent=`חדר המתנה — ${Object.keys(live.players).length} משתתפים`;
  }
  if(['question','revealed'].includes(m.phase)) {
    if(live.role==='host') {
      const elem=$('liveStats'); if(elem) elem.innerHTML=statsHTML(m.phase==='revealed');
    } else refreshStudentChoices();
    const explain=$('liveRevealFeedback');
    if(explain) explain.innerHTML=m.phase==='revealed'?`<div class="feedback good"><strong>התשובה: אי־רציפות ${esc(TYPES[QUESTIONS[m.index].type])}</strong>${esc(QUESTIONS[m.index].explanation)}</div>`:'';
  }
  const board=$('liveBoardPlace');
  if(board) board.innerHTML=boardHTML();
  updateClock();
}
function refreshStudentChoices() {
  if(live.role!=='student' || !live.meta || !['question','revealed'].includes(live.meta.phase)) return;
  const m=live.meta, answer=live.answers[`q${m.index}`]?.[live.uid]?.choice;
  const hasAnswer=Number.isInteger(answer);
  const expired=m.timerEnabled && nowServer() > m.deadline;
  $('liveStudentChoices')?.querySelectorAll('[data-choice]').forEach(button => {
    const i=Number(button.dataset.choice);
    button.disabled = hasAnswer || expired || m.phase!=='question' || inProgress;
    button.classList.toggle('correct',m.phase==='revealed'&&i===QUESTIONS[m.index].type);
    button.classList.toggle('incorrect',m.phase==='revealed'&&hasAnswer&&i===answer&&answer!==QUESTIONS[m.index].type);
    if(hasAnswer && i===answer && m.phase==='question') button.style.borderColor='#d2bcff';
  });
  const message=$('liveAnswerReceipt');
  if(message) {
    const correct=QUESTIONS[m.index].type;
    message.innerHTML=m.phase==='revealed'?(hasAnswer?`<div class="live-status ${answer===correct?'good':'warn'}">${answer===correct?'✅ צדקת! קיבלת 100 נקודות.':'התשובה לא הייתה נכונה הפעם.'}</div>`:'<div class="live-status">לא התקבלה תשובה לשאלה זו.</div>'):
      hasAnswer?`<div class="live-status good">✅ קלטנו את התשובה שלך: <b>${esc(TYPES[answer])}</b>. ממתינים לחשיפה.</div>`:
      expired?'<div class="live-status warn">⏰ הזמן נגמר. ממתינים לחשיפת התשובה.</div>':'';
  }
}
async function hostUpdate(fields) {
  if(live.role !== 'host') return;
  await update(metaRef(),fields);
}
async function startOrNext() {
  if(live.role!=='host' || !live.meta) return;
  const old=live.meta, next=old.phase==='lobby'?0:old.index+1;
  if(next>=QUESTIONS.length) { await hostUpdate({phase:'finished'}); return; }
  await hostUpdate({ phase:'question', index:next, questionKey:`q${next}`, deadline:old.timerEnabled?nowServer()+30000:0 });
  live.autoReveal=false;
}
async function revealQuestion() {
  if(live.role==='host' && live.meta?.phase==='question') await hostUpdate({phase:'revealed'});
}
async function sendAnswer(choice) {
  const m=live.meta;
  if(live.role!=='student'||inProgress||m?.phase!=='question'||(m.timerEnabled && nowServer()>m.deadline)) return;
  if(!Number.isInteger(choice)||choice<0||choice>2) return;
  if(live.answers[`q${m.index}`]?.[live.uid]) return;
  inProgress=true; roomError(''); refreshStudentChoices();
  try { await set(ref(db,`rooms/${live.code}/answers/q${m.index}/${live.uid}`),{choice,at:serverTimestamp()}); }
  catch(e) { roomError(errorText(e)); }
  finally { inProgress=false; refreshStudentChoices(); }
}
async function closeRoom() {
  if(live.role!=='host') return;
  if(!confirm('למחוק את החדר ואת התשובות של כל הסטודנטים? לא יהיה אפשר לשחזר.')) return;
  try { await remove(ref(db,`rooms/${live.code}`)); safeStore(null); detachRoom(); window.quizShow('home'); }
  catch(e) { roomError(errorText(e)); }
}
async function resumeSession() {
  const saved=safeLoad();
  if(!saved?.code||!saved?.role||!saved.uid) return false;
  try {
    await ensureConnection();
    if(saved.uid!==live.uid) { safeStore(null); return false; }
    const snap=await get(ref(db,`rooms/${saved.code}`));
    if(!snap.exists()) { safeStore(null); return false; }
    const room=snap.val();
    if(saved.role==='host' && room.meta?.hostUid!==live.uid) { safeStore(null); return false; }
    if(saved.role==='student' && !room.players?.[live.uid]) { safeStore(null); return false; }
    attachRoom(saved.code,saved.role); return true;
  } catch(e) { setupError(errorText(e)); return false; }
}
$('createRoom').addEventListener('click',createRoom);
$('joinRoom').addEventListener('click',joinRoom);
$('liveNickname').addEventListener('keydown',e=>{if(e.key==='Enter') joinRoom();});
$('liveJoinCode').addEventListener('keydown',e=>{if(e.key==='Enter') joinRoom();});
$('liveSetupBack').addEventListener('click',()=>window.quizShow('home'));
$('liveLeave').addEventListener('click',()=>{
  if(live.role==='host' && live.meta?.phase!=='finished' && !confirm('יציאה מהמסך תעצור את ניהול המשחק עד שתחזרו אליו. להמשיך?')) return;
  detachRoom(); window.quizShow('home');
});
$('liveCopyLink').addEventListener('click',async()=>{
  if(!live.code) return;
  try { await navigator.clipboard.writeText(codeURL(live.code)); $('liveCopyLink').textContent='✅ הועתק!'; setTimeout(()=>$('liveCopyLink').textContent='העתק קישור הזמנה',1600); }
  catch { prompt('העתיקו את הקישור:',codeURL(live.code)); }
});
$('liveStage').addEventListener('click',async e=>{
  if(e.target.closest('#liveClosedBack')) { window.quizShow('home'); return; }
  const button=e.target.closest('button[data-action]');
  if(!button || button.disabled) return;
  const action=button.dataset.action;
  if(action==='answer') { await sendAnswer(Number(button.dataset.choice)); return; }
  if(live.role!=='host') return;
  button.disabled=true; roomError('');
  try {
    if(action==='start'||action==='next') await startOrNext();
    else if(action==='reveal') await revealQuestion();
    else if(action==='close') await closeRoom();
  } catch(err) { roomError(errorText(err)); }
  finally { if(button.isConnected) button.disabled=false; }
});

// כניסה מקישור הזמנה, או חזרה לחדר אחרי רענון של הדף.
const requestedCode=cleanCode(new URLSearchParams(location.search).get('room'));
if(requestedCode) { $('liveJoinCode').value=requestedCode; window.quizShow('liveSetup'); }
if(!configured) { setBusy(false); setupConnection(); }
else {
  const saved=safeLoad();
  if(requestedCode || saved) {
    window.quizShow('liveSetup');
    setupConnection().then(async()=>{
      if(!requestedCode || saved?.code===requestedCode) await resumeSession();
    });
  }
}
$('startLive').addEventListener('click',async()=>{
  await setupConnection();
  if(safeLoad()) await resumeSession();
});
