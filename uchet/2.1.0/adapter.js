/* «Учёт ТТ» для компьютера: общая база на сервере Supabase.
   Подставляет window.claude.use("db" | "downloads" | "user") поверх Supabase, показывает вход,
   управление пользователями (для администратора) и делает ежедневную локальную резервную копию. */
(() => {
  "use strict";
  const CFG = {
    url: "https://fmpktiwswhgimzkargob.supabase.co",
    key: "sb_publishable_ZSAHvaUbBuiC9D2jvCJq3A_K42XZBcS",
  };
  const COLS = ["items", "stores", "suppliers", "docs", "settings", "orgs", "accounts", "articles", "employees", "shifts", "owners"];
  const ROLE_NAMES = {admin: "Администратор", manager: "Менеджер", operator: "Оператор"};
  const ROLE_HINT = {admin: "всё + пользователи", manager: "все документы и справочники", operator: "только документы и график"};
  window.__desktop = false;     // общая база, а не файл на компьютере
  window.__cloud = {};

  const sb = window.supabase.createClient(CFG.url, CFG.key, {auth: {persistSession: true, autoRefreshToken: true, storageKey: "uchet-tt-auth"}});
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

  /* ---------- styles for overlays ---------- */
  const css = document.createElement("style");
  css.textContent = `
  .cl-ov{position:fixed;inset:0;z-index:200;background:var(--bg,#EEF2F4);display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto}
  .cl-ov.dim{background:rgba(8,18,24,.55);align-items:flex-start}
  .cl-box{background:var(--panel,#fff);color:var(--ink,#14212B);border:1px solid var(--line,#D9E1E6);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);width:100%;max-width:420px;padding:26px 24px;display:grid;gap:14px;font-family:var(--f-body,system-ui)}
  .cl-box.wide{max-width:980px}
  .cl-box h2{margin:0;font-family:var(--f-display,system-ui);font-weight:500;font-size:20px}
  .cl-box label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted,#5B6B78)}
  .cl-box input,.cl-box select{font:inherit;font-size:14px;color:var(--ink,#14212B);background:var(--panel,#fff);border:1px solid var(--line,#D9E1E6);border-radius:8px;padding:8px 10px}
  .cl-err{color:var(--neg,#B42318);font-size:13px;min-height:1em}
  .cl-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between}
  .cl-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .cl-tbl th{text-align:left;font-size:12px;color:var(--muted,#5B6B78);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line,#D9E1E6)}
  .cl-tbl td{padding:6px 8px;border-bottom:1px solid var(--line,#D9E1E6);vertical-align:middle}
  .cl-net{position:fixed;right:16px;bottom:16px;z-index:150;background:var(--neg,#B42318);color:#fff;padding:8px 14px;border-radius:10px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.2)}
  .cl-me{font-size:11.5px;color:var(--rail-muted,#7F98A6);margin:6px 10px 0;line-height:1.4}
  .cl-me a{color:var(--rail-acc,#7CD0EA);cursor:pointer;text-decoration:none;margin-right:10px}
  `;
  document.head.appendChild(css);

  /* ---------- auth ---------- */
  let me = null; // {id, email, name, role}
  let authResolve; const authed = new Promise(r => authResolve = r);

  async function fn(body){
    const {data, error} = await sb.functions.invoke("users", {body});
    if (error) { let msg = error.message; try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) {} throw new Error(msg); }
    if (data && data.error) throw new Error(data.error);
    return data;
  }
  function overlay(html, dim){ const o = document.createElement("div"); o.className = "cl-ov" + (dim ? " dim" : ""); o.innerHTML = html; document.body.appendChild(o); return o; }
  const ruAuthErr = m => /invalid login/i.test(m) ? "Неверный email или пароль." : /banned|disabled/i.test(m) ? "Пользователь отключён администратором." : /fetch|network|failed to/i.test(m) ? "Нет связи с сервером. Проверьте интернет." : m;

  async function loadMe(){
    const {data: {user}} = await sb.auth.getUser();
    if (!user) return null;
    const {data, error} = await sb.from("profiles").select("name, role, active, email").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (!data || !data.active) { await sb.auth.signOut(); throw new Error("Доступ отключён. Обратитесь к администратору."); }
    return {id: user.id, email: data.email || user.email, name: data.name, role: data.role};
  }

  async function showLogin(msg){
    let first = false;
    try { first = !(await fn({action: "status"})).hasUsers; } catch (_) {}
    const o = overlay(first ? `<form class="cl-box" autocomplete="on">
        <h2>Первый запуск</h2><div style="font-size:13px;color:var(--muted)">Создайте администратора общей базы. Потом в меню «Пользователи» вы добавите остальных сотрудников.</div>
        <label>Ваше имя<input name="name" required value=""></label>
        <label>Email (логин)<input name="email" type="email" required autocomplete="username"></label>
        <label>Пароль (не менее 8 символов)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <label>Пароль ещё раз<input name="password2" type="password" minlength="8" required autocomplete="new-password"></label>
        <div class="cl-err"></div><button class="btn pri" type="submit">Создать и войти</button></form>`
      : `<form class="cl-box" autocomplete="on">
        <h2>Учёт ТТ</h2><div style="font-size:13px;color:var(--muted)">Вход в общую базу сети</div>
        <label>Email<input name="email" type="email" required autocomplete="username"></label>
        <label>Пароль<input name="password" type="password" required autocomplete="current-password"></label>
        <div class="cl-err">${esc(msg || "")}</div><button class="btn pri" type="submit">Войти</button>
        <div style="font-size:12px;color:var(--muted)">Забыли пароль — попросите администратора задать новый.</div></form>`);
    const f = o.querySelector("form"), err = o.querySelector(".cl-err");
    f.querySelector("input").focus();
    f.addEventListener("submit", async e => {
      e.preventDefault(); err.textContent = ""; const b = f.querySelector("button[type=submit]"); b.disabled = true;
      const v = Object.fromEntries(new FormData(f));
      try {
        if (first) {
          if (v.password !== v.password2) throw new Error("Пароли не совпадают.");
          await fn({action: "bootstrap", email: v.email, password: v.password, name: v.name});
        }
        const {error} = await sb.auth.signInWithPassword({email: String(v.email).trim().toLowerCase(), password: v.password});
        if (error) throw error;
        me = await loadMe(); o.remove(); started();
      } catch (ex) { err.textContent = ruAuthErr(ex.message || String(ex)); b.disabled = false; }
    });
  }
  function started(){ window.__cloud.me = me; authResolve(me); }

  (async () => {
    try { const {data: {session}} = await sb.auth.getSession(); if (session) { me = await loadMe(); if (me) return started(); } }
    catch (ex) { return showLogin(ruAuthErr(ex.message || String(ex))); }
    showLogin();
  })();
  sb.auth.onAuthStateChange(ev => { if (ev === "SIGNED_OUT" && me) location.reload(); });

  /* ---------- data: cache + realtime ---------- */
  const cache = new Map(COLS.map(c => [c, new Map()]));
  const listeners = new Map(COLS.map(c => [c, new Set()]));
  const loadedCols = new Set();
  const pending = new Set(); let raf = 0;
  function notify(c){ pending.add(c); if (!raf) raf = requestAnimationFrame(flush); }
  function flush(){ raf = 0; for (const c of pending) { const snap = {docs: [...cache.get(c)].map(([id, d]) => ({id, data: () => d}))}; for (const l of listeners.get(c)) try { l.ok(snap); } catch (e) { console.error(e); } } pending.clear(); }

  async function fullLoad(){
    const fresh = new Map(COLS.map(c => [c, new Map()]));
    const page = 1000; let from = 0;
    for (;;) {
      const {data, error} = await sb.from("records").select("col,id,data").order("col").order("id").range(from, from + page - 1);
      if (error) throw error;
      for (const r of data) if (fresh.has(r.col)) fresh.get(r.col).set(r.id, r.data);
      if (data.length < page) break; from += page;
    }
    for (const c of COLS) { cache.set(c, fresh.get(c)); loadedCols.add(c); notify(c); }
    backupSoon();
  }
  let channel = null, online = true;
  function netBanner(on){
    let b = document.getElementById("cl-net");
    if (on) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement("div"); b.id = "cl-net"; b.className = "cl-net"; document.body.appendChild(b); }
    b.textContent = "Нет связи с сервером — изменения не сохраняются. Переподключаюсь…";
  }
  function subscribe(){
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("records-all")
      .on("postgres_changes", {event: "*", schema: "public", table: "records"}, p => {
        const row = p.eventType === "DELETE" ? p.old : p.new; if (!row || !cache.has(row.col)) return;
        if (p.eventType === "DELETE") cache.get(row.col).delete(row.id); else cache.get(row.col).set(row.id, row.data);
        notify(row.col);
      })
      .subscribe(status => {
        if (status === "SUBSCRIBED") { if (!online) { online = true; netBanner(true); fullLoad().catch(() => {}); } }
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") { online = false; netBanner(false); setTimeout(() => { if (!online) subscribe(); }, 5000); }
      });
  }
  window.addEventListener("online", () => fullLoad().catch(() => {}));
  setInterval(() => { if (online) fullLoad().catch(() => {}); }, 10 * 60 * 1000); // страховка от пропущенных событий

  function mapErr(error){
    const m = error && (error.message || ""), c = error && error.code;
    if (c === "42501" || /row-level security/i.test(m)) return {code: "permission_denied", message: `Роль «${ROLE_NAMES[me?.role] || ""}» не может менять этот раздел — обратитесь к администратору`};
    if (/fetch|network|Failed to/i.test(m)) return {code: "unavailable", message: "нет связи с сервером"};
    return {code: c || "unknown", message: m || "ошибка сервера"};
  }
  const dbApi = {
    collection(col){
      return {
        doc(id){
          return {
            async set(data){
              const prev = cache.get(col)?.get(id);
              cache.get(col)?.set(id, data); notify(col);
              const {error} = await sb.from("records").upsert({col, id, data});
              if (error) { if (prev === undefined) cache.get(col)?.delete(id); else cache.get(col)?.set(id, prev); notify(col); throw mapErr(error); }
              backupSoon();
            },
            async delete(){
              const prev = cache.get(col)?.get(id);
              cache.get(col)?.delete(id); notify(col);
              const {error} = await sb.from("records").delete().eq("col", col).eq("id", id);
              if (error) { if (prev !== undefined) { cache.get(col)?.set(id, prev); notify(col); } throw mapErr(error); }
            },
          };
        },
        onSnapshot(ok, err){
          const l = {ok, err}; listeners.get(col)?.add(l);
          if (loadedCols.has(col)) notify(col);
          return () => listeners.get(col)?.delete(l);
        },
      };
    },
  };

  /* ---------- local daily backup ---------- */
  let bt = 0, lastBackup = 0;
  function backupSoon(){
    if (!window.localApi?.backup || Date.now() - lastBackup < 30 * 60 * 1000) return;
    clearTimeout(bt); bt = setTimeout(() => {
      const o = {}; for (const c of COLS) o[c] = [...cache.get(c)].map(([id, d]) => Object.assign({}, d, {id}));
      lastBackup = Date.now(); window.localApi.backup(JSON.stringify(o)).catch(() => {});
    }, 5000);
  }

  /* ---------- claude.use emulation ---------- */
  const downloads = {
    async save({filename, data}){
      const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new TextEncoder().encode(String(data));
      return window.localApi.saveFile(filename, buf);
    },
  };
  window.claude = {
    async use(name){
      if (name === "db") {
        await authed;
        try { await fullLoad(); } catch (ex) { netBanner(false); online = false; setTimeout(() => fullLoad().then(() => { online = true; netBanner(true); }).catch(() => {}), 5000); }
        subscribe(); railMe();
        return dbApi;
      }
      if (name === "downloads") return window.localApi ? downloads : null;
      if (name === "user") {
        await authed;
        return {isOwner: () => me?.role === "admin", canEdit: () => me?.role !== "operator", can: async () => !!me, id: async () => me?.id, me: async () => ({id: me?.id, name: me?.name})};
      }
      return null; // фото-распознавание (sample) работает только в онлайн-версии в Claude
    },
  };

  /* ---------- who is logged in (under the menu rail) ---------- */
  let appVer = ""; if (window.localApi?.info) window.localApi.info().then(i => { appVer = i.version; document.querySelector(".cl-me")?.remove(); railMe(); }).catch(() => {});
  function railMe(){
    const put = () => {
      const r = document.getElementById("rail"); if (!r || !me) return;
      if (r.querySelector(".cl-me")) return;
      const d = document.createElement("div"); d.className = "cl-me";
      d.innerHTML = `${esc(me.name || me.email)} · ${esc(ROLE_NAMES[me.role] || me.role)}${appVer ? ` · v${esc(appVer)}` : ""}<br>${me.role === "admin" ? `<a data-cl="users">Пользователи</a><a data-cl="log">Журнал</a>` : ""}<a data-cl="update">Обновить</a><a data-cl="logout">Выйти</a>`;
      r.appendChild(d);
    };
    put(); new MutationObserver(put).observe(document.getElementById("rail"), {childList: true});
  }
  document.addEventListener("click", e => { const a = e.target.closest && e.target.closest("[data-cl]"); if (a) { e.preventDefault(); menu(a.dataset.cl); } });

  /* ---------- users panel (admin) ---------- */
  async function usersPanel(){
    if (me?.role !== "admin") return alertBox("Пользователями управляет администратор.");
    const o = overlay(`<div class="cl-box wide"><div class="cl-row"><h2>Пользователи и права</h2><button class="btn" data-x>Закрыть</button></div><div data-body>Загрузка…</div></div>`, true);
    o.addEventListener("click", ev => { if (ev.target === o || ev.target.closest("[data-x]")) o.remove(); });
    const body = o.querySelector("[data-body]");
    async function draw(msg){
      let users = [];
      try { users = (await fn({action: "list"})).users || []; } catch (ex) { body.innerHTML = `<div class="cl-err">${esc(ex.message)}</div>`; return; }
      body.innerHTML = `<table class="cl-tbl"><thead><tr><th>Имя</th><th>Email (логин)</th><th>Роль</th><th>Доступ</th><th></th></tr></thead><tbody>
        ${users.map(u => `<tr data-u="${u.user_id}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
          <td><select data-f="role" ${u.user_id === me.id ? "disabled" : ""}>${Object.keys(ROLE_NAMES).map(r => `<option value="${r}" ${r === u.role ? "selected" : ""}>${ROLE_NAMES[r]} — ${ROLE_HINT[r]}</option>`).join("")}</select></td>
          <td>${u.user_id === me.id ? "это вы" : `<label style="flex-direction:row;align-items:center;gap:6px;color:inherit"><input type="checkbox" data-f="active" ${u.active ? "checked" : ""}> ${u.active ? "включён" : "отключён"}</label>`}</td>
          <td><button class="btn sm" data-pw>Новый пароль</button></td></tr>`).join("")}
        </tbody></table>
        <form data-new style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:end;margin-top:6px;border-top:1px solid var(--line);padding-top:14px">
          <label>Имя<input name="name" required></label><label>Email (логин)<input name="email" type="email" required></label>
          <label>Пароль (не менее 8)<input name="password" type="text" minlength="8" required autocomplete="off"></label>
          <label>Роль<select name="role">${Object.keys(ROLE_NAMES).map(r => `<option value="${r}" ${r === "operator" ? "selected" : ""}>${ROLE_NAMES[r]}</option>`).join("")}</select></label>
          <button class="btn pri" type="submit">Добавить</button></form>
        <div class="cl-err" data-msg>${esc(msg || "")}</div>
        <div style="font-size:12px;color:var(--muted)">Передайте сотруднику его email и пароль — он сможет войти на любом компьютере с установленной программой. Отключённый пользователь сразу теряет доступ.</div>`;
      const say = (t, ok) => { const m = body.querySelector("[data-msg]"); m.textContent = t; m.style.color = ok ? "var(--pos)" : ""; };
      body.querySelector("[data-new]").addEventListener("submit", async ev => { ev.preventDefault(); const v = Object.fromEntries(new FormData(ev.target));
        try { await fn({action: "create", ...v}); draw(); setTimeout(() => say(`Пользователь ${v.email} добавлен.`, true), 50); } catch (ex) { say(ex.message); } });
      body.querySelectorAll("[data-u]").forEach(tr => {
        const uid = tr.dataset.u;
        tr.querySelector('[data-f="role"]')?.addEventListener("change", async ev => { try { await fn({action: "update", user_id: uid, role: ev.target.value}); say("Роль изменена.", true); } catch (ex) { say(ex.message); draw(); } });
        tr.querySelector('[data-f="active"]')?.addEventListener("change", async ev => { try { await fn({action: "update", user_id: uid, active: ev.target.checked}); draw(); } catch (ex) { say(ex.message); draw(); } });
        tr.querySelector("[data-pw]").addEventListener("click", () => passwordBox(uid, tr.children[1].textContent));
      });
    }
    draw();
  }
  function passwordBox(uid, email){
    const self = !uid;
    const o = overlay(`<form class="cl-box"><h2>${self ? "Сменить мой пароль" : "Новый пароль"}</h2><div style="font-size:13px;color:var(--muted)">${esc(email || "")}</div>
      <label>Новый пароль (не менее 8 символов)<input name="p1" type="password" minlength="8" required autocomplete="new-password"></label>
      <label>Ещё раз<input name="p2" type="password" minlength="8" required autocomplete="new-password"></label>
      <div class="cl-err"></div><div class="cl-row"><button class="btn" type="button" data-x>Отмена</button><button class="btn pri" type="submit">Сохранить</button></div></form>`, true);
    const f = o.querySelector("form"), err = o.querySelector(".cl-err");
    o.querySelector("[data-x]").onclick = () => o.remove();
    f.addEventListener("submit", async ev => { ev.preventDefault(); const v = Object.fromEntries(new FormData(f));
      if (v.p1 !== v.p2) { err.textContent = "Пароли не совпадают."; return; }
      try { if (self) { const {error} = await sb.auth.updateUser({password: v.p1}); if (error) throw error; } else await fn({action: "password", user_id: uid, password: v.p1});
        o.remove(); alertBox("Пароль изменён."); } catch (ex) { err.textContent = ex.message; } });
  }
  async function logPanel(){
    if (me?.role !== "admin") return alertBox("Журнал изменений доступен администратору.");
    const o = overlay(`<div class="cl-box wide"><div class="cl-row"><h2>Журнал изменений</h2><button class="btn" data-x>Закрыть</button></div><div data-body>Загрузка…</div></div>`, true);
    o.addEventListener("click", ev => { if (ev.target === o || ev.target.closest("[data-x]")) o.remove(); });
    const body = o.querySelector("[data-body]");
    try {
      const [{log}, {users}] = await Promise.all([fn({action: "log"}), fn({action: "list"})]);
      const who = Object.fromEntries((users || []).map(u => [u.user_id, u.name || u.email]));
      const OPS = {insert: "создал", update: "изменил", delete: "удалил"};
      const COLN = {docs: "документ", items: "товар", stores: "точку", suppliers: "поставщика", settings: "настройки", orgs: "организацию", accounts: "кассу/счёт", articles: "статью", employees: "сотрудника", shifts: "график", owners: "принадлежность"};
      body.innerHTML = `<div style="max-height:70vh;overflow:auto"><table class="cl-tbl"><thead><tr><th>Когда</th><th>Кто</th><th>Что сделал</th><th>Объект</th></tr></thead><tbody>
        ${(log || []).map(r => `<tr><td>${new Date(r.at).toLocaleString("ru-RU")}</td><td>${esc(who[r.user_id] || "—")}</td><td>${OPS[r.op] || r.op} ${COLN[r.col] || r.col}</td><td>${esc(r.num || "")} ${esc(r.num ? "" : (r.kind || ""))}</td></tr>`).join("") || `<tr><td colspan="4">Пока пусто.</td></tr>`}
        </tbody></table></div><div style="font-size:12px;color:var(--muted)">Последние 300 изменений.</div>`;
    } catch (ex) { body.innerHTML = `<div class="cl-err">${esc(ex.message)}</div>`; }
  }
  function alertBox(t){ const o = overlay(`<div class="cl-box"><div>${esc(t)}</div><div class="cl-row"><span></span><button class="btn pri" data-x>OK</button></div></div>`, true); o.querySelector("[data-x]").onclick = () => o.remove(); }
  async function menu(cmd){
    if (!me) return;
    if (cmd === "users") usersPanel();
    else if (cmd === "log") logPanel();
    else if (cmd === "mypass") passwordBox(null, me.email);
    else if (cmd === "refresh") { try { await fullLoad(); } catch (_) { alertBox("Нет связи с сервером."); } }
    else if (cmd === "logout") { await sb.auth.signOut(); location.reload(); }
    else if (cmd === "update") updateBox();
    else if (cmd === "update-reset") { if (window.localApi?.resetUpdate) window.localApi.resetUpdate(); }
  }
  if (window.localApi?.onMenu) window.localApi.onMenu(menu);

  /* ---------- program updates (button «Обновить») ---------- */
  async function updateBox(){
    if (!window.localApi?.checkUpdate) return alertBox("Обновления доступны только в установленной программе.");
    const o = overlay(`<div class="cl-box"><h2>Обновление программы</h2><div data-b>Проверяю…</div></div>`, true);
    const b = o.querySelector("[data-b]");
    const close = `<button class="btn" data-x>Закрыть</button>`;
    o.addEventListener("click", ev => { if (ev.target === o || ev.target.closest("[data-x]")) o.remove(); });
    const r = await window.localApi.checkUpdate();
    if (r.error) { b.innerHTML = `<div class="cl-err">${esc(r.error)}</div><div class="cl-row"><span></span>${close}</div>`; return; }
    if (!r.newer) { b.innerHTML = `<div>У вас последняя версия <b>${esc(r.current)}</b>.</div><div class="cl-row"><span></span>${close}</div>`; return; }
    if (r.needInstaller) { b.innerHTML = `<div>Вышла версия <b>${esc(r.latest)}</b>, но её нужно установить заново установщиком${r.installer ? ` — <a href="${esc(r.installer)}" target="_blank" style="color:var(--accent)">скачать</a>` : " — попросите файл у администратора"}.</div><div style="white-space:pre-line;font-size:13px;color:var(--muted)">${esc(r.notes)}</div><div class="cl-row"><span></span>${close}</div>`; return; }
    b.innerHTML = `<div>Текущая версия: <b>${esc(r.current)}</b><br>Новая версия: <b>${esc(r.latest)}</b></div>
      ${r.notes ? `<div style="white-space:pre-line;font-size:13px;background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:10px">${esc(r.notes)}</div>` : ""}
      <div style="font-size:12px;color:var(--muted)">Данные не затрагиваются — они на сервере. Несохранённые изменения в открытом документе пропадут, сохраните их перед обновлением.</div>
      <div class="cl-err"></div><div class="cl-row">${close}<button class="btn pri" data-go-upd>Обновить сейчас</button></div>`;
    b.querySelector("[data-go-upd]").onclick = async ev => {
      ev.target.disabled = true; ev.target.textContent = "Загружаю…";
      const a = await window.localApi.applyUpdate();
      if (a.error) { b.querySelector(".cl-err").textContent = a.error; ev.target.disabled = false; ev.target.textContent = "Повторить"; return; }
      ev.target.textContent = "Перезапуск…"; window.localApi.reloadApp();
    };
  }
  async function autoCheck(){
    if (!window.localApi?.checkUpdate) return;
    const r = await window.localApi.checkUpdate().catch(() => null);
    if (!r || r.error || !r.newer || document.getElementById("cl-upd")) return;
    const d = document.createElement("div"); d.id = "cl-upd"; d.className = "cl-net"; d.style.cssText = "background:var(--accent,#0E6A86);cursor:pointer";
    d.textContent = `Доступна новая версия ${r.latest} — нажмите, чтобы обновить`; d.onclick = () => { d.remove(); updateBox(); };
    document.body.appendChild(d);
  }
  authed.then(() => { setTimeout(autoCheck, 4000); setInterval(autoCheck, 2 * 60 * 60 * 1000); });
})();
