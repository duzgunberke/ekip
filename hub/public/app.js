// ekip hub panel — vanilla JS, polls the API every 5 s.
"use strict";

const $ = (s) => document.querySelector(s);
const STATUS_TR = { queued: "Sırada", running: "Çalışıyor", done: "Bitti", failed: "Başarısız", cancelled: "İptal" };
const POOL_TR = { healthy: "sağlıklı", rate_limited: "limitte", invalid: "geçersiz", unknown: "bilinmiyor" };

const state = { tab: "durum", projects: [], jobs: [], runs: [], status: null, jobId: null, job: null, openRuns: new Set(), timer: null };

// ---- helpers -------------------------------------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

function ago(iso) {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return "az sonra";
  if (s < 10) return "şimdi";
  if (s < 60) return `${s} sn önce`;
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return `${Math.floor(s / 86400)} gün önce`;
}

function dur(a, b) {
  if (!a) return "";
  const s = Math.max(0, Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000));
  return s < 60 ? `${s} sn` : s < 3600 ? `${Math.floor(s / 60)} dk ${s % 60} sn` : `${Math.floor(s / 3600)} sa ${Math.floor((s % 3600) / 60)} dk`;
}

const firstLine = (t) => (t ?? "").trim().split("\n")[0];
const pill = (st) => h("span", { class: `pill ${st}` }, STATUS_TR[st] ?? st ?? "?");
const dot = (cls) => h("span", { class: `dot ${cls}` });

async function api(path, opts = {}) {
  const headers = { ...(opts.body ? { "content-type": "application/json" } : {}) };
  if (opts.method && opts.method !== "GET") headers["x-ekip-csrf"] = "1";
  const r = await fetch(path, { credentials: "same-origin", ...opts, headers });
  if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

// Minimal, safe markdown: everything is escaped first, then a few constructs are re-enabled.
function md(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = [];
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0, para = [], list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`); list = null; };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); flushList();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      i++; continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      const tag = /^\s*\d/.test(line) ? "ol" : "ul";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(m[1]);
    } else if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
    else if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line.trim()); }
    i++;
  }
  flushPara(); flushList();
  return out.join("\n");
}

// ---- auth ----------------------------------------------------------------------------------------

function showLogin() {
  clearInterval(state.timer);
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#password").focus();
}

async function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  const saved = (() => { try { return localStorage.getItem("ekip-tab"); } catch { return null; } })();
  selectTab(saved && document.querySelector(`[data-tab="${saved}"]`) ? saved : "durum");
  clearInterval(state.timer);
  state.timer = setInterval(refresh, 5000);
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.textContent = "";
  const r = await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: $("#password").value }) });
  if (r.ok) { $("#password").value = ""; showApp(); return; }
  err.textContent = r.status === 429 ? "Çok fazla deneme. Biraz sonra tekrar deneyin." : "Parola yanlış.";
});

$("#logout").addEventListener("click", async () => {
  await fetch("/logout", { method: "POST" });
  showLogin();
});

// ---- tabs ----------------------------------------------------------------------------------------

function selectTab(tab) {
  state.tab = tab;
  try { localStorage.setItem("ekip-tab", tab); } catch { /* private mode */ }
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== `tab-${tab}`;
  refresh();
}
for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => selectTab(b.dataset.tab));

async function refresh() {
  try {
    if (state.tab === "durum") { state.status = await api("/api/status"); renderStatus(); }
    if (state.tab === "projeler") { state.projects = await api("/api/projects"); renderProjects(); }
    if (state.tab === "isler") {
      const [projects, jobs] = await Promise.all([api("/api/projects"), api("/api/jobs?limit=200")]);
      state.projects = projects; state.jobs = jobs;
      renderProjectSelect(); renderJobs();
      if (state.jobId) { state.job = await api(`/api/jobs/${state.jobId}`); renderJobDetail(); }
    }
    if (state.tab === "calismalar") { state.runs = await api("/api/runs?limit=200"); renderRuns(); }
    $("#foot").textContent = `Son güncelleme ${new Date().toLocaleTimeString("tr-TR")}`;
  } catch (e) {
    if (e.message !== "unauthorized") $("#foot").textContent = `Bağlantı hatası: ${e.message}`;
  }
}

// ---- Durum ---------------------------------------------------------------------------------------

function renderStatus() {
  const s = state.status;
  const f = s.freellmapi, t = s.tdai, q = s.queue;
  const cards = [];

  cards.push(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h3", {}, "Ücretsiz havuz (freellmapi)"),
      h("span", { class: "small-text" }, dot(!f.configured ? "" : f.ready ? "ok" : f.up ? "warn" : "bad"), !f.configured ? "ayarlı değil" : f.ready ? "hazır" : f.up ? "hazır değil" : "kapalı")),
    h("div", { class: "big" }, String(f.providerCount), h("span", { class: "muted small-text" }, " sağlayıcı")),
    f.authError ? h("p", { class: "error" }, "FREELLMAPI_KEY reddedildi") : null,
    !f.ready && f.reason ? h("p", { class: "muted small-text" }, f.reason) : null,
    h("div", { class: "chips" }, f.providers.map((p) => h("span", { class: "chip", title: p.resumeAt ? `devam: ${new Date(p.resumeAt).toLocaleTimeString("tr-TR")}` : "" },
      dot(p.status === "healthy" ? "ok" : p.status === "rate_limited" ? "warn" : p.status === "invalid" ? "bad" : ""), `${p.name} ×${p.keys} · ${POOL_TR[p.status] ?? p.status}`)))));

  cards.push(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h3", {}, "Hafıza (TDAI proxy)"),
      h("span", { class: "small-text" }, dot(!t.configured ? "" : t.up ? "ok" : "bad"), !t.configured ? "ayarlı değil" : t.up ? "açık" : "kapalı")),
    h("dl", { class: "kv" },
      h("dt", {}, "Sürüm"), h("dd", {}, t.version ?? "—"),
      h("dt", {}, "Kullanıcı anahtarı"), h("dd", {}, t.memory ? "var" : "yok"),
      h("dt", {}, "GitHub token"), h("dd", {}, s.github.token ? "var" : "yok")),
    h("p", { class: "muted small-text" }, t.up ? "İşler proje hafızasıyla çalışır." : "Kapalıyken işler doğrudan freellmapi'ye gider.")));

  cards.push(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h3", {}, "İşçiler"), h("span", { class: "muted small-text" }, `${s.workers.filter((w) => w.jobId).length}/${s.workers.length} meşgul`)),
    h("dl", { class: "kv" }, s.workers.flatMap((w) => [
      h("dt", {}, `#${w.slot}`),
      h("dd", {}, w.jobId ? h("span", {}, dot("ok"), h("a", { href: "#", class: "mono", onclick: (e) => { e.preventDefault(); openJob(w.jobId); } }, w.jobId), ` · ${dur(w.since)}`) : h("span", { class: "muted" }, dot(""), "boşta")),
    ])),
    h("div", { class: "chips" }, ["queued", "running", "done", "failed", "cancelled"].map((k) => h("span", { class: "chip" }, `${STATUS_TR[k]}: ${q[k] ?? 0}`)))));

  const clients = s.clients;
  cards.push(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h3", {}, "Mac istemcileri"), h("span", { class: "muted small-text" }, String(clients.length))),
    clients.length ? h("dl", { class: "kv" }, clients.flatMap((c) => {
      const age = (Date.now() - new Date(c.lastSeen).getTime()) / 1000;
      return [
        h("dt", {}, dot(age < 180 ? "ok" : age < 3600 ? "warn" : "bad"), c.client),
        h("dd", {}, `${ago(c.lastSeen)}${c.host ? ` · ${c.host}` : ""}${c.agents?.length ? ` · ${c.agents.length} ajan` : ""}`),
      ];
    })) : h("p", { class: "muted small-text" }, "Henüz sinyal yok.")));

  if (s.links?.length) cards.push(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h3", {}, "Paneller"), h("span", { class: "muted small-text" }, String(s.links.length))),
    h("div", { class: "chips" }, s.links.map((l) => h("a", { class: "chip", href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.name)))));

  $("#status-grid").replaceChildren(...cards);
}

// ---- Projeler ------------------------------------------------------------------------------------

function renderProjects() {
  const el = $("#projects");
  if (!state.projects.length) { el.replaceChildren(h("div", { class: "empty" }, "Kayıtlı proje yok. Mac'teki ekip projeleri buraya gönderir.")); return; }
  el.replaceChildren(...state.projects.map((p) => h("div", { class: "card click", tabindex: "0", role: "button", onclick: () => openCard(p), onkeydown: (e) => { if (e.key === "Enter") openCard(p); } },
    h("div", { class: "card-head" }, h("h3", {}, p.name), p.tdai?.teamId ? h("span", { class: "chip", title: "TDAI hafızası bağlı" }, "hafıza") : null),
    h("p", { class: "muted small-text" }, p.summary || "Özet yok."),
    h("div", { class: "mono muted" }, p.repo ?? "repo yok"),
    h("div", { class: "muted small-text" }, `güncellendi ${ago(p.updatedAt)}`))));
}

function openCard(p) {
  $("#card-title").textContent = p.name;
  const body = $("#card-body");
  body.innerHTML = md(p.card || p.summary || "_Kart yok._");
  body.append(h("div", { class: "row mt" }, h("button", { class: "primary small", onclick: () => { $("#card-dialog").close(); selectTab("isler"); setTimeout(() => { $("#job-project").value = p.name; $("#job-task").focus(); }, 50); } }, "Bu projede iş başlat")));
  $("#card-dialog").showModal();
}
$("#card-close").addEventListener("click", () => $("#card-dialog").close());
$("#card-dialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---- İşler ---------------------------------------------------------------------------------------

function renderProjectSelect() {
  const sel = $("#job-project");
  const names = state.projects.map((p) => p.name);
  const current = [...sel.options].map((o) => o.value);
  if (names.join("\n") === current.join("\n")) return;
  const keep = sel.value;
  sel.replaceChildren(...names.map((n) => h("option", { value: n }, n)));
  if (names.includes(keep)) sel.value = keep;
}

function renderJobs() {
  const el = $("#jobs");
  if (!state.jobs.length) { el.replaceChildren(h("div", { class: "empty" }, "Henüz iş yok.")); return; }
  el.replaceChildren(...state.jobs.map((j) => h("button", { class: `item${j.id === state.jobId ? " active" : ""}`, onclick: () => openJob(j.id) },
    pill(j.status),
    h("span", { class: "title" }, firstLine(j.task)),
    h("span", { class: "when" }, ago(j.createdAt)),
    h("span", { class: "meta" }, `${j.project} · ${j.id}${j.branch ? ` · ${j.branch}` : ""}${j.status === "running" ? ` · ${dur(j.startedAt)}` : j.finishedAt ? ` · ${dur(j.startedAt, j.finishedAt)}` : ""}`))));
}

async function openJob(id) {
  if (state.tab !== "isler") selectTab("isler");
  state.jobId = id;
  $(".split").classList.add("has-detail");
  try { state.job = await api(`/api/jobs/${id}`); renderJobDetail(); renderJobs(); } catch { /* shown in footer */ }
  if (matchMedia("(max-width: 899px)").matches) $("#job-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderJobDetail() {
  const j = state.job, el = $("#job-detail");
  if (!j) { el.hidden = true; return; }
  el.hidden = false;
  const prevLog = el.querySelector("pre.log");
  const atBottom = !prevLog || prevLog.scrollTop + prevLog.clientHeight >= prevLog.scrollHeight - 30;
  const prevScroll = prevLog?.scrollTop ?? 0;
  const cancellable = j.status === "queued" || j.status === "running";
  el.replaceChildren(
    h("div", { class: "card-head" },
      h("h2", {}, pill(j.status), " ", h("span", { class: "mono" }, j.id)),
      h("div", { class: "actions" },
        cancellable ? h("button", { class: "small danger", onclick: () => cancelJob(j.id) }, "İptal et") : null,
        h("button", { class: "small ghost", onclick: () => { state.jobId = null; state.job = null; $(".split").classList.remove("has-detail"); renderJobDetail(); renderJobs(); } }, "Kapat"))),
    h("dl", { class: "kv" },
      h("dt", {}, "Proje"), h("dd", {}, j.project),
      h("dt", {}, "Havuz"), h("dd", {}, j.pool ? (j.pool === "tdai" ? "TDAI proxy (hafızalı)" : "freellmapi (doğrudan)") : "—"),
      h("dt", {}, "Dal"), h("dd", { class: "mono" }, j.branch ?? "—", j.pushed ? " (gönderildi)" : j.push ? "" : " (push kapalı)"),
      h("dt", {}, "Süre"), h("dd", {}, j.startedAt ? dur(j.startedAt, j.finishedAt) : "başlamadı"),
      h("dt", {}, "Oluşturuldu"), h("dd", {}, new Date(j.createdAt).toLocaleString("tr-TR")),
      j.error ? h("dt", {}, "Hata") : null, j.error ? h("dd", { class: "error" }, j.error) : null),
    h("div", { class: "section-label" }, "Görev"),
    h("pre", { class: "box" }, j.task),
    j.diffstat ? h("div", { class: "section-label" }, "Değişiklikler") : null,
    j.diffstat ? h("pre", { class: "box" }, j.diffstat) : null,
    j.report ? h("div", { class: "section-label" }, "Rapor") : null,
    j.report ? h("pre", { class: "box" }, j.report) : null,
    h("div", { class: "section-label" }, "Günlük (son kısım)"),
    h("pre", { class: "box log" }, j.log || "—"));
  const log = el.querySelector("pre.log");
  log.scrollTop = atBottom ? log.scrollHeight : prevScroll;
}

async function cancelJob(id) {
  if (!confirm("Bu iş iptal edilsin mi?")) return;
  try { await api(`/api/jobs/${id}/cancel`, { method: "POST", body: "{}" }); } catch (e) { alert(e.message); }
  refresh();
}

$("#job-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#job-error");
  err.textContent = "";
  const btn = e.submitter ?? $("#job-form button[type=submit]");
  btn.disabled = true;
  try {
    const job = await api("/api/jobs", { method: "POST", body: JSON.stringify({ project: $("#job-project").value, task: $("#job-task").value, push: $("#job-push").checked }) });
    $("#job-task").value = "";
    await refresh();
    openJob(job.id);
  } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
});

// ---- Çalıştırmalar -------------------------------------------------------------------------------

function renderRuns() {
  const el = $("#runs");
  if (!state.runs.length) { el.replaceChildren(h("div", { class: "empty" }, "Mac'ten bildirilen çalıştırma yok.")); return; }
  el.replaceChildren(...state.runs.map((r) => {
    const open = state.openRuns.has(r.id);
    const st = ({ ok: "done", success: "done", done: "done", failed: "failed", error: "failed", running: "running" })[r.status] ?? r.status;
    return h("div", { class: "item", onclick: (e) => { if (e.target.closest("pre")) return; open ? state.openRuns.delete(r.id) : state.openRuns.add(r.id); renderRuns(); } },
      pill(st),
      h("span", { class: "title" }, firstLine(r.task) || r.id),
      h("span", { class: "when" }, ago(r.finishedAt ?? r.startedAt ?? r.receivedAt)),
      h("span", { class: "meta" }, [r.project, r.via && `via ${r.via}`, r.startedAt && dur(r.startedAt, r.finishedAt)].filter(Boolean).join(" · ")),
      open ? h("div", { class: "expand" },
        h("div", { class: "section-label" }, "Görev"), h("pre", { class: "box" }, r.task || "—"),
        h("div", { class: "section-label" }, "Rapor"), h("pre", { class: "box" }, r.report || "—")) : null);
  }));
}

// ---- boot ----------------------------------------------------------------------------------------

document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("#app").hidden) refresh(); });
fetch("/api/session", { credentials: "same-origin" }).then((r) => (r.ok ? showApp() : showLogin()), showLogin);
