(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (s) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  const config = window.QUIZ_CONFIG || {};
  const ready = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY && window.supabase);
  const db = ready ? window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY) : null;
  let session = JSON.parse(localStorage.getItem('quizRoomSession') || 'null');
  let live = null, state = null, timer = null, poller = null, busy = false, lastRenderKey = '', questions = [], quizTitle = '';
  const glyphs = ['▲','◆','●','■'];
  const colors = ['red','blue','yellow','green'];
  const app = $('#app');

  const save = () => session ? localStorage.setItem('quizRoomSession', JSON.stringify(session)) : localStorage.removeItem('quizRoomSession');
  const errorText = (error) => error?.message || String(error);
  function flash(message, positive = false) {
    const target = $('#notice');
    if (target) { target.className = `notice ${positive ? 'success' : ''}`; target.textContent = message; target.hidden = false; }
    else alert(message);
  }
  function page(html) { app.innerHTML = html; $('#homeLink').onclick = (event) => { event.preventDefault(); leave(); }; }
  function notice() { return '<div id="notice" class="notice" hidden></div>'; }
  const loading = '<div class="panel center"><div class="loader"></div><p class="sub">Connecting to your game…</p></div>';
  async function rpc(name, data) {
    if (!ready) throw new Error('Supabase is not configured. See README.md and config.js.');
    const { data: result, error } = await db.rpc(name, data);
    if (error) throw error;
    return result;
  }
  function leave() { stop(); session = null; state = null; save(); showHome(); }
  function stop() { if (timer) clearInterval(timer); if (poller) clearInterval(poller); if (live && db) db.removeChannel(live); timer = poller = live = null; lastRenderKey = ''; }
  function showHome() {
    stop(); document.title = 'QuizRoom — Play Together';
    page(`<div class="hero"><section><span class="eyebrow">QUIZZES ARE BETTER TOGETHER</span><h1>Bring the<br><em>fun to life.</em></h1><p class="desc">Your own live quiz arena. Challenge friends, colleagues or community members in a fast-paced game for up to 50 players.</p><div class="btn-row"><button class="primary" id="join">Join a game →</button><button class="secondary" id="create">Host a quiz ✦</button></div><div class="pill-row"><span><b>●</b> Live multiplayer</span><span><b>◆</b> 50 players</span><span><b>✦</b> Instant scores</span></div></section><section class="visual" aria-hidden="true"><div class="visual-top"><span>✦ QUIZROOM LIVE</span><span class="chip">● GAME ON</span></div><div class="mock-question">Which planet is known as<br>the Red Planet?</div><div class="mock-grid"><div class="red">▲ Venus</div><div class="blue">◆ Mars ✓</div><div class="yellow">● Jupiter</div><div class="green">■ Saturn</div></div><div class="small-bottom">4 answers · 1 winner · endless fun ✨</div></section></div>`);
    $('#join').onclick = showJoin; $('#create').onclick = showEditor;
  }
  function showJoin() {
    page(`<section class="panel"><h2>Join the fun ✨</h2><p class="sub">Ask your host for the 6-digit PIN, then choose your nickname.</p>${notice()}<form id="joinForm"><label class="field" for="pin">GAME PIN</label><input id="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="e.g. 482910" required><label class="field" for="nickname">YOUR NICKNAME</label><input id="nickname" maxlength="24" minlength="2" placeholder="What should we call you?" required><button class="primary full" type="submit">Enter game →</button></form><button class="outline full" id="back">← Back</button></section>`);
    $('#back').onclick = showHome;
    $('#joinForm').onsubmit = async (e) => {
      e.preventDefault(); const btn = $('#joinForm button'); btn.disabled = true;
      try {
        const result = await rpc('quiz_join', {p_pin:$('#pin').value.trim(), p_nickname:$('#nickname').value.trim()});
        session = {role:'player', pin:result.pin, gameId:result.gameId, playerId:result.playerId, token:result.playerToken}; save(); await connect();
      } catch(err) { flash(errorText(err)); btn.disabled = false; }
    };
  }
  function defaultQuestion() { return {prompt:'', options:['','','',''], correctIndex:0, seconds:20}; }
  function showEditor() {
    quizTitle = ''; questions = [defaultQuestion()]; renderEditor();
  }
  function readEditor() {
    quizTitle = $('#quizTitle')?.value || '';
    questions.forEach((q,i) => {
      q.prompt = $(`[data-prompt="${i}"]`)?.value || '';
      q.options = q.options.map((_,j) => $(`[data-option="${i}-${j}"]`)?.value || '');
      q.correctIndex = Number($(`[data-correct="${i}"]`)?.value || 0);
      q.seconds = Number($(`[data-seconds="${i}"]`)?.value || 20);
    });
  }
  function renderEditor() {
    page(`<section class="panel wide"><h2>Build your quiz ✨</h2><p class="sub">Create 1–30 questions. Players will see the options on their own screens.</p>${notice()}<label class="field" for="quizTitle">QUIZ TITLE</label><input id="quizTitle" maxlength="120" value="${escapeHtml(quizTitle)}" placeholder="Give your quiz a title"><div id="questionList">${questions.map((q,i) => `<article class="question-editor"><header><strong>QUESTION ${i+1}</strong><button class="danger" type="button" data-delete="${i}" ${questions.length===1?'disabled':''}>Remove</button></header><label class="field">QUESTION</label><input data-prompt="${i}" maxlength="240" value="${escapeHtml(q.prompt)}" placeholder="Type your question"><div class="small" style="margin-top:12px">FOUR ANSWERS</div>${q.options.map((o,j) => `<div class="option-line"><span class="opt-letter">${glyphs[j]}</span><input data-option="${i}-${j}" maxlength="120" value="${escapeHtml(o)}" placeholder="Answer ${j+1}"></div>`).join('')}<div class="btn-row"><label style="flex:1"><span class="field">CORRECT ANSWER</span><select data-correct="${i}">${q.options.map((_,j) => `<option value="${j}" ${q.correctIndex===j?'selected':''}>Answer ${j+1}</option>`).join('')}</select></label><label style="flex:1"><span class="field">TIME LIMIT</span><select data-seconds="${i}">${[10,15,20,30,45,60].map(s => `<option value="${s}" ${q.seconds===s?'selected':''}>${s} seconds</option>`).join('')}</select></label></div></article>`).join('')}</div><div class="btn-row"><button id="add" class="secondary">+ Add question</button><button id="launch" class="primary">Create live game →</button></div><button id="cancel" class="outline full">← Back to home</button><p class="help">Keep the host tab open while the game is running. A new game gets a unique PIN.</p></section>`);
    $('#add').onclick=()=>{readEditor();if(questions.length>=30)return flash('Maximum 30 questions');questions.push(defaultQuestion());renderEditor();};
    document.querySelectorAll('[data-delete]').forEach(el => el.onclick=()=>{readEditor();questions.splice(Number(el.dataset.delete),1);renderEditor();});
    $('#cancel').onclick=showHome;
    $('#launch').onclick=async()=>{
      readEditor(); if(!quizTitle.trim()) return flash('Give your quiz a title.'); if(questions.some(q=>q.prompt.trim().length<4||q.options.some(o=>!o.trim()))) return flash('Complete every question and all four answers.');
      $('#launch').disabled=true;
      try {const r=await rpc('quiz_create',{p_questions:questions,p_title:quizTitle.trim()});session={role:'host',pin:r.pin,gameId:r.gameId,token:r.hostToken};save();await connect();}
      catch(err){flash(errorText(err));$('#launch').disabled=false;}
    };
  }
  async function refresh() {
    if(!session||busy)return;busy=true;
    try {
      const res=await rpc('quiz_state', {p_pin:session.pin,p_player_id:session.playerId||null,p_player_token:session.role==='player'?session.token:null,p_host_token:session.role==='host'?session.token:null});
      state=res;
      const key=JSON.stringify({title:res.title,phase:res.phase,index:res.questionIndex,players:res.players,answer:res.myAnswer,leader:res.leaderboard});
      if(key!==lastRenderKey){lastRenderKey=key;renderGame();}
      updateTimer();
    } catch(err) { if(!state) {page(`<section class="panel">${notice()}<h2>Connection problem</h2><p class="sub">${escapeHtml(errorText(err))}</p><button id="retry">Retry</button> <button id="quit" class="outline">Home</button></section>`);$('#retry').onclick=refresh;$('#quit').onclick=leave;} }
    finally {busy=false;}
  }
  async function connect() {
    stop();page(loading);await refresh();
    if(!session)return;
    // INSERT players also updates quiz_games, so both lobby and phase changes broadcast.
    live=db.channel(`quiz-${session.gameId}`).on('postgres_changes',{event:'UPDATE',schema:'public',table:'quiz_games',filter:`id=eq.${session.gameId}`},()=>refresh()).subscribe();
    poller=setInterval(refresh,5000);
    timer=setInterval(updateTimer,250);
  }
  function board(rows, top=10) {return `<div class="leaderboard">${rows.slice(0,top).map((p,i)=>`<div class="leader"><span>${['🥇','🥈','🥉'][i]||`#${i+1}`} ${escapeHtml(p.nickname)}</span><strong>${p.score} pts</strong></div>`).join('')}</div>`;}
  function renderGame() {
    if(!state||!session)return;
    const host=session.role==='host';
    const quizHeading=`<p class="game-title">${escapeHtml(state.title || 'QuizRoom Live')}</p>`;
    document.title = `${state.title || 'QuizRoom Live'} — QuizRoom`;
    if(state.phase==='lobby') {
      page(`<section class="panel wide center">${quizHeading}<span class="eyebrow">WAITING ROOM</span><h2 style="margin-top:22px">${host?'Share this game PIN':'You’re in! 🎉'}</h2><p class="sub">${host?'Tell players to visit this website and enter:':'Waiting for the host to start the game.'}</p><div class="lobby-pin">${escapeHtml(state.pin)}</div><div class="stats"><span class="stat">👥 ${state.players.length} / 50 players</span><span class="stat">⚡ ${state.questionCount} questions</span></div><div class="people">${state.players.map(n=>`<span class="person">✦ ${escapeHtml(n)}</span>`).join('')}</div>${notice()}${host?'<div class="btn-row"><button id="copy" class="secondary">Copy game link</button><button id="next" class="primary">Start game →</button></div>':'<div class="waiting">🎮</div>'}<button id="quit" class="outline full">Leave game</button></section>`);
      if(host){$('#copy').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);flash('Link copied!',true);}catch{flash('Copy the address from your browser.');}};$('#next').onclick=advance;}
      $('#quit').onclick=leave;
      return;
    }
    if(state.phase==='finished') {
      page(`<section class="panel center">${quizHeading}<div class="waiting">🏆</div><h2>Game complete!</h2><p class="sub">Your final leaderboard</p>${board(state.leaderboard,50)}<button class="primary full" id="quit">Play another game →</button></section>`);$('#quit').onclick=leave;return;
    }
    const q=state.question||{}; const idx=state.questionIndex+1;
    if(state.phase==='results') {
      page(`<section class="panel wide">${quizHeading}<div class="meta"><span>QUESTION ${idx} / ${state.questionCount}</span><span>RESULTS ✨</span></div><h2 class="qtitle">${escapeHtml(q.prompt)}</h2><div class="answer-grid">${(q.options||[]).map((o,i)=>`<div class="answer ${colors[i]} ${i===q.correctIndex?'correct':'wrong'}"><span>${glyphs[i]}</span> ${escapeHtml(o)} ${i===q.correctIndex?'✓':''}</div>`).join('')}</div><div class="divider"></div><h3>Leaderboard</h3>${board(state.leaderboard)}${host?'<button id="next" class="primary full">Next →</button>':`<p class="center help">${state.myAnswer?`You earned ${state.myAnswer.points} points this round.`:'Waiting for the next question…'}</p>`}</section>`);
      if(host)$('#next').onclick=advance;return;
    }
    const answered=Boolean(state.myAnswer);
    page(`<section class="panel wide">${quizHeading}<div class="meta"><span>QUESTION ${idx} / ${state.questionCount}</span><span class="timer" id="clock">${q.seconds}s</span></div><h2 class="qtitle">${escapeHtml(q.prompt)}</h2>${notice()}<div class="answer-grid">${(q.options||[]).map((o,i)=>`<button class="answer ${colors[i]} ${answered&&state.myAnswer.choice===i?'selected':''}" data-choice="${i}" ${host||answered?'disabled':''}><span>${glyphs[i]}</span> ${escapeHtml(o)}</button>`).join('')}</div><p class="help center">${host?'Question is live — results will appear when the timer ends.':answered?'Answer locked in! Waiting for results…':'Choose one answer before time runs out.'}</p></section>`);
    if(!host&&!answered)document.querySelectorAll('[data-choice]').forEach(el=>el.onclick=async()=>{document.querySelectorAll('[data-choice]').forEach(b=>b.disabled=true);try{await rpc('quiz_submit',{p_pin:session.pin,p_player_id:session.playerId,p_player_token:session.token,p_choice:Number(el.dataset.choice)});await refresh();}catch(err){flash(errorText(err));}});
  }
  async function advance() {if(!session||session.role!=='host')return;const btn=$('#next');if(btn)btn.disabled=true;try{await rpc('quiz_next',{p_pin:session.pin,p_host_token:session.token});await refresh();}catch(err){flash(errorText(err));if(btn)btn.disabled=false;}}
  let advancing=false;
  function updateTimer() {
    if(!state||state.phase!=='question'||!state.question)return;
    const remaining=Math.max(0,Math.ceil(state.question.seconds-(Date.now()-new Date(state.startedAt).getTime())/1000));
    const el=$('#clock');if(el)el.textContent=`${remaining}s`;
    if(remaining===0&&session?.role==='host'&&!advancing){advancing=true;advance().finally(()=>{advancing=false;});}
  }
  if(session&&ready)connect();else showHome();
})();
