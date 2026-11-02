// The "AI Pricing Agent" button of the Estimation website. Shown to logged-in users at the
// bottom right; it opens the agent (agent/index.html, same site so the same login) in a
// panel over the app, and shows the progress of a running job on the button itself:
// "AI pricing · 186/214 · about 4 min left", then "Priced: download". The agent runs on
// Firebase Functions; this file only asks for the user's recent jobs (agentJobs).
(function () {
  'use strict';

  const FUNCTIONS = 'https://us-central1-estimation-6fa32.cloudfunctions.net/';
  if (!window.estimationAuth || !window.estimationAuth.configured()) return;

  const css = `
  #ai-agent-btn { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; display: none;
    font: 600 14px/1.2 system-ui, "Segoe UI", sans-serif; color: #fff; background: #1a56db; border: 0;
    border-radius: 22px; padding: 11px 18px 11px 14px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25);
    align-items: center; gap: 8px; max-width: calc(100vw - 36px); }
  #ai-agent-btn:hover { background: #1747b5; }
  #ai-agent-btn svg { flex: none; }
  #ai-agent-btn .ai-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #ai-agent-btn .ai-bar { position: absolute; left: 14px; right: 14px; bottom: 5px; height: 3px; border-radius: 2px;
    background: rgba(255,255,255,.3); overflow: hidden; display: none; }
  #ai-agent-btn .ai-bar > i { display: block; height: 100%; width: 0; background: #fff; transition: width .5s; }
  #ai-agent-btn.ai-done { background: #107c41; }
  #ai-agent-panel { position: fixed; inset: 0; z-index: 2147483001; display: none; background: rgba(0,0,0,.35); }
  #ai-agent-panel .ai-box { position: absolute; inset: 24px; max-width: 920px; margin: 0 auto; background: #f7f9fc;
    border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
  #ai-agent-panel header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px;
    background: #1a56db; color: #fff; font: 600 16px system-ui, "Segoe UI", sans-serif; }
  #ai-agent-panel header button { background: none; border: 0; color: #fff; font-size: 26px; line-height: 1; cursor: pointer; padding: 0 4px; }
  #ai-agent-panel iframe { flex: 1; border: 0; width: 100%; background: #f7f9fc; }
  @media (max-width: 600px) { #ai-agent-panel .ai-box { inset: 0; border-radius: 0; } }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) #ai-agent-panel .ai-box,
    :root:not([data-theme="light"]) #ai-agent-panel iframe { background: #111418; } }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2l1.8 4.9L19 8.7l-4.1 3.2 1.4 5.1L12 14.2 7.7 17l1.4-5.1L5 8.7l5.2-1.8z" fill="currentColor"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" fill="currentColor" opacity=".8"/></svg>';
  const btn = document.createElement('button');
  btn.id = 'ai-agent-btn';
  btn.type = 'button';
  btn.title = 'Price a client BOQ with the AI pricing agent';
  btn.innerHTML = icon + '<span class="ai-text">AI Pricing Agent</span><span class="ai-bar"><i></i></span>';
  document.body.appendChild(btn);
  const text = btn.querySelector('.ai-text');
  const bar = btn.querySelector('.ai-bar');
  const fill = bar.querySelector('i');

  const panel = document.createElement('div');
  panel.id = 'ai-agent-panel';
  panel.innerHTML = '<div class="ai-box" role="dialog" aria-label="AI Pricing Agent"><header><span>AI Pricing Agent</span>' +
    '<button type="button" aria-label="Close">&times;</button></header></div>';
  document.body.appendChild(panel);
  const box = panel.querySelector('.ai-box');
  let frame = null;

  function open() {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.title = 'AI Pricing Agent';
      frame.src = 'agent/';
      box.appendChild(frame);
    }
    panel.style.display = 'block';
  }
  function close() {
    panel.style.display = 'none';
    check(); // show the latest progress on the button
  }
  btn.addEventListener('click', open);
  panel.querySelector('header button').addEventListener('click', close);
  panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.style.display === 'block') close(); });

  // ---- Progress of the user's latest job, on the button ----
  let user = null;
  let timer = null;
  let seenDone = {};

  function label(t, pct, done) {
    text.textContent = t;
    bar.style.display = pct == null ? 'none' : 'block';
    if (pct != null) fill.style.width = pct + '%';
    btn.classList.toggle('ai-done', !!done);
  }

  async function check() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!user || !window.firebase) return;
    const current = window.firebase.auth().currentUser;
    if (!current) return;
    let jobs = [];
    try {
      const res = await fetch(FUNCTIONS + 'agentJobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await current.getIdToken()) },
        body: '{"data":{}}',
      });
      jobs = ((await res.json()).result || {}).jobs || [];
    } catch (_) {
      timer = setTimeout(check, 60000);
      return;
    }
    const running = jobs.find((j) => !['done', 'failed', 'cancelled'].includes(j.status));
    if (running) {
      const pct = running.total ? Math.round((running.done / running.total) * 95) + 3 : 2;
      let t = running.total ? `AI pricing · ${running.done}/${running.total}` : 'AI pricing · starting';
      if (running.createdAt && running.now && running.done > 0 && running.total > running.done) {
        const left = ((running.now - running.createdAt) / running.done) * (running.total - running.done) / 60000;
        t += left < 1 ? ' · under a minute left' : ` · about ${Math.round(left)} min left`;
      }
      if (running.status === 'writing') t = 'AI pricing · writing the workbook';
      label(t, pct, false);
      timer = setTimeout(check, 10000);
      return;
    }
    // A job that finished in the last hour and has not been opened yet: offer the download.
    const recent = jobs.find((j) => j.status === 'done' && j.createdAt && j.now - j.createdAt < 3600000 && !seenDone[j.jobId]);
    if (recent && panel.style.display !== 'block') {
      label('Priced: download', null, true);
      btn.onclick = () => { seenDone[recent.jobId] = true; label('AI Pricing Agent', null, false); btn.onclick = null; };
    } else {
      label('AI Pricing Agent', null, false);
    }
    // While the panel is open the page inside follows the job; check again when it closes.
    timer = setTimeout(check, panel.style.display === 'block' ? 15000 : 120000);
  }

  window.estimationAuth.onChange((json) => {
    user = json ? JSON.parse(json) : null;
    btn.style.display = user ? 'flex' : 'none';
    if (!user) { panel.style.display = 'none'; if (timer) clearTimeout(timer); return; }
    check();
  });
})();
