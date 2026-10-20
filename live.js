// משחק כיתתי מסונכרן. JavaScript מודולרי, בלי build או שרת משלכם.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getDatabase, ref, get, set, update, remove, runTransaction, onValue, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const { QUESTIONS, TYPES, makePlot, esc } = window.quizShared;
const $ = id => document.getElementById(id);
const SESSION_KEY = 'continuity-quiz-live-session-v2';
// מסך התוצאות נשאר פתוח עד שהמתרגל בוחר להציג את הדירוג.
// כתובת המתרגל נפרדת; קישור QR לעולם אינו כולל teacher=1.
const query = new URLSearchParams(location.search);
const teacherMode = query.get('teacher') === '1' && !query.has('room');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const configured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.databaseURL && firebaseConfig.appId && !Object.values(firebaseConfig).some(v => String(v).includes('PASTE_')));
let db = null, auth = null, connectPromise = null;
let inProgress = false;
const live = { code: '', role: '', uid: '', meta: null, players: {}, answers: {}, unsubs: [], stageKey: '', revealView: '', clock: null, serverOffset: 0, autoReveal: false };

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
  $('createRoom').disabled = flag || !configured || !teacherMode;
  $('joinRoom').disabled = flag || !configured;
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
    $('liveConnectionMessage').textContent = teacherMode ? '✅ מחובר! אפשר ליצור חדר למתרגל.' : '✅ מחובר! אפשר להצטרף לחדר עם כינוי.';
    setupError('');
  } catch(e) {
    $('liveConnectionMessage').textContent = '⚠️ החיבור למערכת החדרים לא הושלם.';
    setupError(errorText(e));
  }
}
async function createRoom() {
  if(inProgress || !teacherMode) return;
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
  $('liveResetRoom').hidden=true;
  live.code=''; live.role=''; live.meta=null; live.players={}; live.answers={}; live.stageKey=''; live.revealView=''; live.autoReveal=false;
}
function attachRoom(code,role) {
  detachRoom();
  live.code = code; live.role = role;
  $('liveRoomCode').textContent=code;
  $('liveRoleLabel').textContent=role==='host'?'🎓 מסך המתרגל':'📱 משחק כיתתי';
  $('liveInviteLink').textContent=codeURL(code);
  $('liveInviteLink').href=codeURL(code);
  $('liveHostInvite').hidden=role!=='host';
  $('liveCopyLink').hidden=role!=='host';
  $('liveResetRoom').hidden=role!=='host';
  if(role==='host') renderQR(codeURL(code));
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
function renderQR(url) {
  const target=$('liveQRCode');
  target.replaceChildren();
  try {
    if(typeof window.QRCode !== 'function') throw new Error('ספריית QR עדיין לא נטענה');
    new window.QRCode(target, {text:url, width:170, height:170, colorDark:'#15172c', colorLight:'#ffffff', correctLevel:window.QRCode.CorrectLevel.M});
  } catch(e) {
    // גיבוי במקרה שספריית יצירת ה־QR חסומה ברשת הכיתה.
    const img=document.createElement('img');
    img.alt='סרקו כדי להצטרף למשחק'; img.width=170; img.height=170;
    img.src='https://api.qrserver.com/v1/create-qr-code/?size=170x170&margin=0&data='+encodeURIComponent(url);
    img.onerror=()=>{ target.textContent='לא הצלחנו לטעון QR. השתמשו בקישור או בקוד החדר.'; };
    target.append(img);
  }
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
  const revealedAny=live.meta?.phase==='finished' || live.meta?.phase==='revealed' || (live.meta?.index ?? 0)>0;
  const podium=revealedAny && rank.length ? `<div class="live-podium" aria-label="שלושת המקומות הראשונים">${[
    [1,'🥈','מקום שני'], [0,'🥇','מקום ראשון'], [2,'🥉','מקום שלישי']
  ].map(([i,medal,label])=>rank[i]?`<div class="live-podium-spot place${i+1}"><span class="medal">${medal}</span><b>${label}</b><span class="winner-name" dir="auto">${esc(rank[i].name)}</span><span class="winner-score">${rank[i].score} נקודות</span></div>`:`<div class="live-podium-spot place${i+1}"><span class="medal">${medal}</span><span>${label}</span><span class="note">טרם נקבע</span></div>`).join('')}</div>`:'';
  return `<div class="live-board"><h3>🏆 Leaderboard — טבלת המובילים</h3>${podium}${visible.length?visible.map((p,i)=>`<div class="live-rank ${p.uid===live.uid&&live.role==='student'?'me':''}"><b>${p.actualRank || i+1}</b><span dir="auto">${esc(p.name)}${p.uid===live.uid&&live.role==='student'?' (אני)':''}</span><b>${p.score}</b></div>`).join(''):'<p class="live-meta">עדיין אין משתתפים.</p>'}<p class="note">100 נקודות לתשובה נכונה. הדירוג מתעדכן אחרי חשיפת התשובה; במקרה של תיקו הניקוד זהה.</p></div>`;
}
function countsFor(index) {
  const votes=Object.entries(live.answers[`q${index}`] || {}).filter(([uid,answer])=>Boolean(live.players[uid]) && Number.isInteger(answer?.choice) && answer.choice>=0 && answer.choice<TYPES.length);
  const counts=TYPES.map((_,j)=>votes.filter(([,x])=>x.choice===j).length);
  const correct=counts[QUESTIONS[index].type], voted=votes.length;
  const total=Object.keys(live.players).length;
  return {counts, correct, wrong:voted-correct, unanswered:Math.max(0,total-voted), voted, total};
}
// תוצאות ההצבעה קיימות רק במסך שלאחר החשיפה, לעולם לא בזמן הבחירה.
function statsHTML() {
  const {counts,correct,wrong,unanswered,voted,total}=countsFor(live.meta.index);
  const solution=QUESTIONS[live.meta.index].type;
  return `<div class="live-board"><strong>📊 תוצאות השאלה: ${voted} מתוך ${total} ענו</strong>
    <div class="live-summary">
      <div class="live-tally right"><span>✅ צדקו</span><b>${correct}</b></div>
      <div class="live-tally wrong"><span>❌ טעו</span><b>${wrong}</b></div>
      <div class="live-tally missing"><span>⌛ לא ענו</span><b>${unanswered}</b></div>
    </div>
    <p class="live-meta">${voted?Math.round(correct*100/voted):0}% מהמשיבים ענו נכון.</p>
    <div class="live-stats">${counts.map((n,i)=>`<div class="live-stat ${i===solution?'winner':''}"><span>${esc(TYPES[i])}${i===solution?' ✓':''}</span><div class="live-track"><div class="live-fill" style="width:${voted?Math.round(n*100/voted):0}%"></div></div><b>${n}</b></div>`).join('')}</div>
  </div>`;
}
function allQuestionStatsHTML() {
  return `<div class="live-board"><h3>📊 סיכום הכיתה — שאלה אחר שאלה</h3>${QUESTIONS.map((q,i)=>{
    const x=countsFor(i);
    return `<div class="live-correct-row"><b>שאלה ${i+1}: ${esc(TYPES[q.type])}</b><span>✅ ${x.correct} צדקו · ❌ ${x.wrong} טעו · ⏳ ${x.unanswered} לא ענו</span></div>`;
  }).join('')}</div>`;
}
// התצוגה מסונכרנת בין כל המשתתפים לפי חותמת הזמן של Firebase,
// ולא לפי שעון שהתחיל לכל מכשיר בנפרד. גם מי שמרענן יצטרף לשלב הנכון.
function isBoardVisible() {
  // אין מעבר מבוסס זמן: אותו מצב נשמר ב-Firebase לכל המשתתפים.
  return live.meta?.phase==='revealed' && live.meta.showBoard===true;
}
function resultsSummaryHTML() {
  const m=live.meta, q=QUESTIONS[m.index];
  const mine=live.answers[`q${m.index}`]?.[live.uid]?.choice;
  const selfMessage=live.role==='student' ? (!Number.isInteger(mine) ? '⌛ לא התקבלה תשובה שלך בשאלה הזו.' : mine===q.type ? '✅ כל הכבוד! תשובה נכונה — 100 נקודות.' : '❌ הפעם התשובה שלך לא הייתה נכונה.') : '';
  return `<div class="live-results-page live-results-summary" role="region" aria-label="תוצאות השאלה">
    <div class="live-results-hero"><div class="kicker">שאלה ${m.index+1} מתוך ${QUESTIONS.length}</div><h2>📊 איך ענתה הכיתה?</h2>
      <p class="live-answer-label">התשובה הנכונה: <strong>אי־רציפות ${esc(TYPES[q.type])}</strong></p></div>
    <div id="liveResultsStats">${statsHTML()}</div>
    <p class="live-results-explanation">${esc(q.explanation)}</p>
    ${selfMessage?`<p class="live-status good">${selfMessage}</p>`:''}
    <p class="live-coming-next">🏆 ממתינים למתרגל להצגת טבלת המובילים…</p>
  </div>`;
}
function resultsLeaderboardHTML() {
  const m=live.meta, counts=countsFor(m.index);
  return `<div class="live-results-page live-results-leaderboard" role="region" aria-label="טבלת מובילים">
    <div class="live-results-hero"><div class="kicker">אחרי שאלה ${m.index+1} מתוך ${QUESTIONS.length}</div><h2>🏆 והנה המובילים!</h2><p class="live-meta">הניקוד כולל את השאלה האחרונה. 100 נקודות לכל תשובה נכונה.</p></div>
    <div class="live-results-ribbon"><span>✅ ${counts.correct} צדקו</span><span>❌ ${counts.wrong} טעו</span><span>⌛ ${counts.unanswered} לא ענו</span></div>
    ${boardHTML()}
  </div>`;
}
function refreshRevealView(refreshData=false) {
  if(live.meta?.phase!=='revealed') return;
  const container=$('liveRevealContent');
  if(!container) return;
  const view=isBoardVisible()?'board':'stats';
  const changed=view!==live.revealView;
  if(changed) {
    live.revealView=view;
    container.innerHTML=view==='board'?resultsLeaderboardHTML():resultsSummaryHTML();
    const controls=$('liveRevealControls');
    if(controls && live.role==='host') controls.innerHTML=hostControls();
    // קפיצה לראש מסך הדירוג גם כאשר הכפתור נמצא מתחת לתוצאות הארוכות.
    if(view==='board') container.scrollIntoView({behavior:'smooth', block:'start'});
  }
  // אם תשובות מגיעות באיחור, מעדכנים את התוצאות מבלי להחליף שלב.
  if(view==='stats') {
    const stats=$('liveResultsStats');
    if(stats && !changed && refreshData) stats.innerHTML=statsHTML();
  }
  // מעדכן גם את הדירוג אם Firebase שלח נתוני שחקנים חדשים.
  else {
    const board=container.querySelector('.live-board');
    if(board && !changed && refreshData) board.outerHTML=boardHTML();
  }
}
function hostControls() {
  const phase=live.meta.phase;
  if(phase==='lobby') return `<div class="live-actions"><button class="btn primary" data-action="start">התחל משחק — שאלה 1 ←</button></div>`;
  if(phase==='question') return '<div class="live-actions"><button class="btn primary" data-action="reveal">חשוף תשובה וניקוד</button></div>';
  if(phase==='revealed') return `<div class="live-actions live-reveal-actions">${!isBoardVisible()?'<button class="btn primary" data-action="showBoard">🏆 המשך ל-Leaderboard ←</button>':`<button class="btn primary" data-action="next">${live.meta.index===QUESTIONS.length-1?'סיום המשחק 🏆':'לשאלה הבאה ←'}</button>`}</div>`;
  return '<p class="live-meta">המשחק הסתיים. כדי לנקות את הטסטים ולהתחיל מחדש, לחצו על ״סגור חדר ואפס משחק״ למעלה.</p>';
}
function stageMarkup() {
  const m=live.meta, host=live.role==='host', count=Object.keys(live.players).length;
  if(m.phase==='lobby') {
    return `<div class="live-panel"><h2>חדר המתנה — ${count} משתתפים</h2><p class="live-meta">${host?'שתפו את הקוד או קישור ההזמנה. כשכולם הצטרפו לחצו על התחלה.':'נכנסת למשחק! ממתינים שהמתרגל יתחיל.'}</p><div id="liveNames"></div>${host?hostControls():''}</div><div id="liveBoardPlace"></div>`;
  }
  if(m.phase==='finished') {
    return `<div class="live-panel"><h2>🎊 המשחק הסתיים!</h2><p class="live-meta">${QUESTIONS.length} שאלות על אי־רציפות. כל הכבוד לכל המשתתפים!</p>${host?hostControls():''}</div><div id="liveBoardPlace"></div><div id="liveAllStats"></div>`;
  }
  const q=QUESTIONS[m.index];
  if(!q) return '<div class="live-panel">מספר שאלה לא תקין.</div>';
  if(m.phase==='revealed') {
    return `<div class="live-head"><span class="live-badge">שאלה ${m.index+1} מתוך ${QUESTIONS.length} — התשובה נחשפה</span></div>
      <div class="progress"><div style="width:${100*(m.index+1)/QUESTIONS.length}%"></div></div>
      <div id="liveRevealContent"></div><div id="liveRevealControls">${host?hostControls():''}</div>`;
  }
  return `<div class="live-head"><span class="live-badge">שאלה ${m.index+1} מתוך ${QUESTIONS.length}</span><span class="live-badge" id="liveCountdown">${m.timerEnabled?'⏳ 30 שניות':'ללא הגבלת זמן'}</span></div>
    <div class="progress"><div style="width:${100*(m.index+(m.phase==='revealed'?1:0))/QUESTIONS.length}%"></div></div>
    <div class="quiz-layout">
      <div class="graph-card"><div class="graph-title">גרף הפונקציה — סביב x = ${q.at}</div><div class="plot-wrap">${makePlot(q)}</div>
      <div class="legend"><span><i class="symbol"></i> עיגול ריק</span><span><i class="symbol filled"></i> ערך הפונקציה</span><span><i class="symbol line"></i> הנקודה לבדיקה</span></div></div>
      <div class="answer-card"><h2 class="question">מהו סוג אי־הרציפות ב־x = ${q.at}?</h2>
        ${host?'<p class="prompt">הסטודנטים עונים עכשיו מהטלפונים.</p>': '<p class="prompt">בחרו תשובה. אפשר לתקן ולשנות את הבחירה עד לחשיפת הפתרון או סוף הזמן.</p>'}
        ${host?'':`<div id="liveStudentChoices">${TYPES.map((t,i)=>`<button class="choice" data-action="answer" data-choice="${i}"><span class="letter">${i+1}</span><span>אי־רציפות ${esc(t)}</span></button>`).join('')}</div><div id="liveAnswerReceipt"></div>`}
        <div id="liveRevealFeedback"></div>
        ${!host?'<div id="liveStudentStats"></div>':''}
        ${host?hostControls():''}
      </div>
    </div><div id="liveBoardPlace"></div>`;
}
function renderLive() {
  if(!live.meta || !live.code) return;
  const key=`${live.role}:${live.meta.phase}:${live.meta.index}`;
  if(key!==live.stageKey) {
    live.stageKey=key;
    live.revealView='';
    $('liveStage').innerHTML=stageMarkup();
  }
  const m=live.meta;
  $('liveHostInvite').hidden=live.role!=='host' || m.phase!=='lobby';
  if(m.phase==='revealed') { refreshRevealView(true); return; }
  if(m.phase==='lobby') {
    const names=$('liveNames');
    if(names) names.innerHTML=`<div class="live-names">${Object.values(live.players).map(p=>`<span class="live-name" dir="auto">${esc(p.name||'ללא כינוי')}</span>`).join('')}</div>`;
    const lobbyHeading=$('liveStage').querySelector('h2');
    if(lobbyHeading) lobbyHeading.textContent=`חדר המתנה — ${Object.keys(live.players).length} משתתפים`;
  }
  if(['question','revealed'].includes(m.phase)) {
    // לא מציגים למתרגל או לסטודנטים ספירות בזמן שאלה.
    if(live.role==='student') refreshStudentChoices();
    const explain=$('liveRevealFeedback');
    if(explain) explain.innerHTML=m.phase==='revealed'?`<div class="feedback good"><strong>התשובה: אי־רציפות ${esc(TYPES[QUESTIONS[m.index].type])}</strong>${esc(QUESTIONS[m.index].explanation)}</div>`:'';
  }
  const board=$('liveBoardPlace');
  if(board) board.innerHTML=m.phase==='finished'?boardHTML():'';
  const all=$('liveAllStats');
  if(all) all.innerHTML=allQuestionStatsHTML();
  updateClock();
}
function refreshStudentChoices() {
  if(live.role!=='student' || !live.meta || !['question','revealed'].includes(live.meta.phase)) return;
  const m=live.meta, answer=live.answers[`q${m.index}`]?.[live.uid]?.choice;
  const hasAnswer=Number.isInteger(answer);
  const expired=m.timerEnabled && nowServer() > m.deadline;
  $('liveStudentChoices')?.querySelectorAll('[data-choice]').forEach(button => {
    const i=Number(button.dataset.choice);
    button.disabled = expired || m.phase!=='question' || inProgress;
    button.classList.toggle('correct',m.phase==='revealed'&&i===QUESTIONS[m.index].type);
    button.classList.toggle('incorrect',m.phase==='revealed'&&hasAnswer&&i===answer&&answer!==QUESTIONS[m.index].type);
    button.classList.toggle('selected',hasAnswer && i===answer && m.phase==='question');
  });
  const message=$('liveAnswerReceipt');
  if(message) {
    const correct=QUESTIONS[m.index].type;
    message.innerHTML=m.phase==='revealed'?(hasAnswer?`<div class="live-status ${answer===correct?'good':'warn'}">${answer===correct?'✅ צדקת! קיבלת 100 נקודות.':'התשובה לא הייתה נכונה הפעם.'}</div>`:'<div class="live-status">לא התקבלה תשובה לשאלה זו.</div>'):
      hasAnswer?`<div class="live-status good">✅ הבחירה הנוכחית שלך: <b>${esc(TYPES[answer])}</b>. אפשר לשנות אותה עד לחשיפת התשובה${m.timerEnabled?' או סוף הזמן':''}.</div>`:
      expired?'<div class="live-status warn">⏰ הזמן נגמר. ממתינים לחשיפת התשובה.</div>':'';
  }
}
async function hostUpdate(fields) {
  if(live.role !== 'host') return;
  await update(metaRef(),fields);
}
async function startOrNext() {
  if(live.role!=='host' || !live.meta) return;
  const old=live.meta;
  if(old.phase==='revealed' && !old.showBoard) return; // קודם מציגים פתרון, ואז דירוג.
  if(old.phase!=='lobby' && old.phase!=='revealed') return;
  const next=old.phase==='lobby'?0:old.index+1;
  if(next>=QUESTIONS.length) { await hostUpdate({phase:'finished'}); return; }
  await hostUpdate({ phase:'question', index:next, questionKey:`q${next}`, deadline:old.timerEnabled?nowServer()+30000:0, revealedAt:0, showBoard:false });
  live.autoReveal=false;
}
async function revealQuestion() {
  if(live.role==='host' && live.meta?.phase==='question') await hostUpdate({phase:'revealed', revealedAt:serverTimestamp(), showBoard:false});
}
async function sendAnswer(choice) {
  const m=live.meta;
  if(live.role!=='student'||inProgress||m?.phase!=='question'||(m.timerEnabled && nowServer()>m.deadline)) return;
  if(!Number.isInteger(choice)||choice<0||choice>2) return;
  if(live.answers[`q${m.index}`]?.[live.uid]?.choice===choice) return;
  inProgress=true; roomError(''); refreshStudentChoices();
  try { await set(ref(db,`rooms/${live.code}/answers/q${m.index}/${live.uid}`),{choice,at:serverTimestamp()}); }
  catch(e) { roomError(errorText(e)); }
  finally { inProgress=false; refreshStudentChoices(); }
}
async function closeRoom() {
  if(live.role!=='host' || !live.code || inProgress) return;
  const code=live.code;
  if(!confirm(`לסגור את חדר ${code} ולאפס את כל הטסט?\n\nכל התשובות, הכינויים והניקוד בחדר הזה יימחקו לצמיתות. הסטודנטים ינותקו ותוכל לפתוח חדר חדש עם קוד אחר.`)) return;
  inProgress=true;
  $('liveResetRoom').disabled=true;
  roomError('');
  try {
    // למארח מותר למחוק את החדר כולו לפי כללי Firebase הקיימים.
    // מחיקת החדר מנקה גם את רשימות המשתתפים, התשובות והניקוד.
    await remove(ref(db,`rooms/${code}`));
    safeStore(null);
    detachRoom();
    setupError('✅ החדר הקודם נסגר וכל תוצאות הטסט נמחקו. אפשר ליצור חדר חדש.');
    window.quizShow('liveSetup');
  } catch(e) { roomError(errorText(e)); }
  finally { inProgress=false; $('liveResetRoom').disabled=false; }
}
async function resumeSession() {
  const saved=safeLoad();
  if(!saved?.code||!saved?.role||!saved.uid) return false;
  if(saved.role==='host' && !teacherMode) return false;
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
// במסך סטודנט אין כניסה כמתרגל. מסך המתרגל נפתח רק בקישור נפרד ?teacher=1.
$('liveHostPanel').hidden=!teacherMode;
$('liveStudentPanel').hidden=teacherMode;
$('liveSetupIntro').textContent=teacherMode ? 'יצירת חדר להקרנה בכיתה. הסטודנטים מצטרפים בסריקת קוד QR או דרך קישור ההזמנה.' : 'הקלידו כינוי וקוד חדר כדי להצטרף למשחק. אין צורך בחשבון.';
$('startLive').textContent=teacherMode ? '🎓 פתיחת חדר למתרגל' : '🏆 הצטרפות למשחק כיתתי';
$('createRoom').addEventListener('click',createRoom);
$('joinRoom').addEventListener('click',joinRoom);
$('liveNickname').addEventListener('keydown',e=>{if(e.key==='Enter') joinRoom();});
$('liveJoinCode').addEventListener('keydown',e=>{if(e.key==='Enter') joinRoom();});
$('liveSetupBack').addEventListener('click',()=>window.quizShow('home'));
$('liveLeave').addEventListener('click',()=>{
  if(live.role==='host' && live.meta?.phase!=='finished' && !confirm('יציאה מהמסך תעצור את ניהול המשחק עד שתחזרו אליו. להמשיך?')) return;
  detachRoom(); window.quizShow('home');
});
$('liveResetRoom').addEventListener('click',closeRoom);
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
    else if(action==='showBoard' && live.meta?.phase==='revealed' && !live.meta.showBoard) await hostUpdate({showBoard:true});
    else if(action==='close') await closeRoom();
  } catch(err) { roomError(errorText(err)); }
  finally { if(button.isConnected) button.disabled=false; }
});

// כניסה מקישור הזמנה, או חזרה לחדר אחרי רענון של הדף.
const requestedCode=cleanCode(query.get('room'));
if(requestedCode) { $('liveJoinCode').value=requestedCode; window.quizShow('liveSetup'); }
else if(teacherMode) window.quizShow('liveSetup');
if(!configured) { setBusy(false); setupConnection(); }
else {
  const saved=safeLoad();
  if(requestedCode || saved || teacherMode) {
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
