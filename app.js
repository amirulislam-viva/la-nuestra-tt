/* ============================================================
   TT Tournament Manager — app.js
   Stages: Players → Draw → Teams → Roadmap (Group → Semis → Final)
   Group matches: Bo3 (first to 2 sets) · Semis/Final: Bo5 (first to 3)
   Every set is 11 points, win by 2. All data in localStorage.
   ============================================================ */
"use strict";

/* ---------------- Constants & state ---------------- */
const LS_KEY = "tt_tournament_v1";
const POINTS_TO_WIN_SET = 11;
const GAMES_OF = { group: 3, ko: 5 }; // best-of
const SETS_TO_WIN = { group: 2, ko: 3 };

const STAGES = ["players", "draw", "teams", "fixtures"];
const STEP_META = {
  players: { n: 1, label: "Players" },
  draw: { n: 2, label: "Draw" },
  teams: { n: 3, label: "Teams" },
  fixtures: { n: 4, label: "Roadmap" },
};

let state = load();
let modalCtx = null; // { matchId } while score modal open
let toastTimer = null;

/* ---------------- Persistence ---------------- */
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.players)) {
        s.stage = STAGES.includes(s.stage) ? s.stage : "players";
        s.players.forEach((p) => { p.id = String(p.id); p.name = String(p.name); p.group = p.group === "B" ? "B" : "A"; });
        s.zoom = typeof s.zoom === "number" ? zoomClamp(s.zoom) : 1;
        // Migration: stamp today's date when results were first saved
        if (!s.dateStamp) {
          const anyPlayed = Object.values(s.matches || {}).some((m) => m.played)
            || (s.ko && ((s.ko.semis || []).some((m) => m.played) || (s.ko.final && s.ko.final.played)));
          if (anyPlayed) s.dateStamp = new Date().toISOString().slice(0, 10);
        }
        // Migration: rename legacy "Team N" teams after their players
        if (s.teams && s.teams.map) {
          Object.values(s.teams.map).forEach((t) => {
            if (/^Team \d+$/.test(t.name)) {
              const pa = s.players.find((p) => p.id === t.pa);
              const pb = s.players.find((p) => p.id === t.pb);
              if (pa && pb) t.name = `${pa.name}-${pb.name}`;
            }
          });
        }
        return s;
      }
    }
  } catch (e) { console.warn("Could not read saved state:", e); }
  return fresh();
}
function fresh() {
  return { stage: "players", players: [], teams: null, matches: {}, order: null, ko: null, championId: null, zoom: 1 };
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  catch (e) { console.warn("Could not save state:", e); }
}

/* ---------------- Helpers ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (n) => n.trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function playersInGroup(g) { return state.players.filter((p) => p.group === g); }

function teamsArray() {
  if (!state.teams) return [];
  return state.teams.teamIds.map((tid) => state.teams.map[tid]).filter(Boolean);
}
function teamById(tid) { return state.teams ? state.teams.map[tid] : null; }

function matchesOfStage(stage) {
  return Object.values(state.matches).filter((m) => m.stage === stage);
}
function allStageMatchesDone(stage) {
  const ms = matchesOfStage(stage);
  return ms.length > 0 && ms.every((m) => m.played);
}
function playerName(pid) {
  const p = state.players.find((x) => x.id === pid);
  return p ? p.name : "?";
}
function resultDate() {
  return state.dateStamp || new Date().toISOString().slice(0, 10);
}
function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/* ---------------- Validation ---------------- */
function canGoDraw() {
  const a = playersInGroup("A").length, b = playersInGroup("B").length;
  return a >= 2 && b >= 2 && a === b;
}

/* ---------------- Zoom ---------------- */
function zoomClamp(z) { return Math.min(1.6, Math.max(0.4, Math.round(z * 10) / 10)); }
function applyZoom() {
  const b = $("bracket"), v = $("zoomVal");
  if (b) b.style.zoom = state.zoom;
  if (v) v.textContent = Math.round(state.zoom * 100) + "%";
}
function setZoom(z) { state.zoom = zoomClamp(z); save(); applyZoom(); }

/* ---------------- Stepper ---------------- */
function stepState(key) {
  const cur = STAGES.indexOf(state.stage);
  const idx = STAGES.indexOf(key);
  if (idx < cur) return "done";
  if (idx === cur) return "active";
  return "future";
}
function renderStepper() {
  const el = $("stepper");
  el.innerHTML = STAGES.map((key, i) => {
    const st = stepState(key);
    const done = st === "done";
    const icon = done ? "✓" : STEP_META[key].n;
    const clickable = done || (key === "teams" && state.teams);
    return `
      <div class="step ${st} ${clickable ? "clickable" : ""}" data-step="${key}" title="${esc(STEP_META[key].label)}">
        <span class="dot">${icon}</span><span>${esc(STEP_META[key].label)}</span>
      </div>
      ${i < STAGES.length - 1 ? '<span class="step-sep">›</span>' : ""}
    `;
  }).join("");
  el.querySelectorAll(".step.clickable").forEach((n) =>
    n.addEventListener("click", () => { state.stage = n.dataset.step; save(); render(); })
  );
}

/* ---------------- Modal ---------------- */
function openModal(html) {
  $("modalBox").innerHTML = html;
  $("modalBackdrop").classList.remove("hidden");
  $("modalBox").querySelectorAll("[data-close]").forEach((n) => n.addEventListener("click", closeModal));
}
function closeModal() {
  $("modalBackdrop").classList.add("hidden");
  $("modalBox").innerHTML = "";
  modalCtx = null;
}
$("modalBackdrop").addEventListener("click", (e) => { if (e.target === $("modalBackdrop")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

/* ============================================================
   STAGE 1 — PLAYERS
   ============================================================ */
function renderPlayers() {
  const ok = canGoDraw();
  const a = playersInGroup("A").length, b = playersInGroup("B").length;
  $("app").innerHTML = `
    <div class="card">
      <div class="stage-head">
        <h2 class="stage-title">Add Players</h2>
        <p class="stage-sub">Split players into two groups. To enter the draw you need <b>equal counts</b> in Group A and Group B (at least 2 each).</p>
      </div>
      <div class="grid2">
        ${groupCardHTML("A")}
        ${groupCardHTML("B")}
      </div>
      <div class="btn-row">
        <button class="btn primary big" id="btnGoDraw" ${ok ? "" : "disabled"}>Proceed to Draw →</button>
        ${!ok ? `<span class="muted" style="align-self:center;font-size:13px;">Needs equal groups (A: ${a} / B: ${b}, min 2 each)</span>` : ""}
      </div>
    </div>
  `;
  bindGroupCard("A"); bindGroupCard("B");
  $("btnGoDraw").addEventListener("click", () => { state.stage = "draw"; save(); render(); });
}

function groupCardHTML(g) {
  const list = playersInGroup(g);
  const items = list.map((p, i) => `
    <li class="player-item">
      <span class="p-avatar">${esc(initials(p.name))}</span>
      <span class="p-name">${esc(p.name)}</span>
      <span class="p-num">#${i + 1}</span>
      <button class="x" data-del="${p.id}" title="Remove player">✕</button>
    </li>
  `).join("");
  return `
    <div class="card group-card ${g === "B" ? "gB" : ""}" style="box-shadow:none;">
      <div class="group-head">
        <span class="group-tag"><span class="${g === "A" ? "chip-a" : "chip-b"}">${g}</span> Group ${g}</span>
        <span class="count-badge">${list.length} player${list.length === 1 ? "" : "s"}</span>
      </div>
      <form class="add-row" data-gform="${g}">
        <input class="input" id="inp${g}" maxlength="24" placeholder="Player name…" autocomplete="off" />
        <button class="btn ${g === "A" ? "primary" : "blue"}" type="submit">+ Add</button>
      </form>
      ${list.length ? `<ul class="player-list">${items}</ul>` : `<div class="empty-hint">No players yet — add the first one above.</div>`}
    </div>
  `;
}

function bindGroupCard(g) {
  const form = document.querySelector(`[data-gform="${g}"]`);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $(`inp${g}`);
    const name = inp.value.trim().replace(/\s+/g, " ");
    if (!name) return;
    const exists = state.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (exists) { toast(`"${name}" is already added.`); return; }
    state.players.push({ id: String(Date.now()) + Math.random().toString(36).slice(2, 7), name, group: g });
    save(); renderPlayers();
    const ni = $(`inp${g}`); if (ni) ni.focus();
  });
  document.querySelectorAll(`[data-del]`).forEach((btn) =>
    btn.addEventListener("click", () => {
      state.players = state.players.filter((p) => p.id !== btn.dataset.del);
      save(); render();
    })
  );
}

/* ============================================================
   STAGE 2 — DRAW
   ============================================================ */
function renderDraw() {
  const a = playersInGroup("A").length, b = playersInGroup("B").length;
  $("app").innerHTML = `
    <div class="card">
      <div class="stage-head">
        <h2 class="stage-title">Draw 🎲</h2>
        <p class="stage-sub">Each team pairs one random Group A player with one random Group B player, and is named after its duo — e.g. <b>Jahid-Shohag</b>.</p>
      </div>
      ${state.teams ? `
        <div class="btn-row between">
          <div class="btn-row" style="margin:0;">
            <button class="btn ghost" id="btnRedraw">🎲 Re-draw</button>
            <button class="btn ghost" id="btnEditPlayers">← Edit players</button>
          </div>
          <button class="btn primary big" id="btnGoFixtures">Roadmap →</button>
        </div>
        <h3 class="round-title" style="margin-top:22px;">Teams (${teamsArray().length})</h3>
        <div class="team-grid">${teamsArray().map(teamCardHTML).join("")}</div>
      ` : `
        <div class="btn-row">
          <button class="btn primary big" id="btnDoDraw">🎲 Draw Teams</button>
          <button class="btn ghost" id="btnBackPlayers">← Back to players</button>
        </div>
        <div class="empty-hint" style="margin-top:20px;">
          ${a} players in Group A · ${b} in Group B → will form <b>${a} teams</b>.
        </div>
      `}
    </div>
  `;
  const bd = $("btnDoDraw");
  if (bd) bd.addEventListener("click", doDraw);
  const bp = $("btnBackPlayers");
  if (bp) bp.addEventListener("click", () => { state.stage = "players"; save(); render(); });
  const br = $("btnRedraw");
  if (br) br.addEventListener("click", () => {
    if (!confirm("Re-draw will discard all teams and every recorded result. Continue?")) return;
    doDraw();
  });
  const be = $("btnEditPlayers");
  if (be) be.addEventListener("click", () => {
    if (!confirm("Editing players will discard teams, fixtures and results drawn so far. Continue?")) return;
    state.teams = null; state.matches = {}; state.order = null; state.ko = null; state.championId = null;
    state.stage = "players"; save(); render();
  });
  const bf = $("btnGoFixtures");
  if (bf) bf.addEventListener("click", () => { state.stage = "fixtures"; save(); render(); });
}

function doDraw() {
  const a = shuffle(playersInGroup("A"));
  const b = shuffle(playersInGroup("B"));
  const n = Math.min(a.length, b.length);
  const map = {}; const teamIds = [];
  for (let i = 0; i < n; i++) {
    const tid = "T" + (i + 1);
    map[tid] = {
      id: tid,
      name: `${a[i].name}-${b[i].name}`,
      pa: a[i].id,
      pb: b[i].id,
      seed: i + 1,
    };
    teamIds.push(tid);
  }
  state.teams = { map, teamIds, drawnAt: Date.now() };
  state.matches = {}; state.order = null; state.ko = null; state.championId = null;
  createGroupFixtures();
  state.stage = "teams";
  save();
  render();
  toast(`Draw complete — ${n} teams formed!`);
}

function teamCardHTML(t) {
  const pa = state.players.find((p) => p.id === t.pa);
  const pb = state.players.find((p) => p.id === t.pb);
  return `
    <div class="team-card">
      <div class="team-name">🏓 ${esc(t.name)}</div>
      <div class="team-players">
        <div class="tp">🟠 ${esc(pa ? pa.name : "?")} <span class="pill pa">Group A</span></div>
        <div class="tp">🔵 ${esc(pb ? pb.name : "?")} <span class="pill pb">Group B</span></div>
      </div>
    </div>
  `;
}

/* ============================================================
   STAGE 3 — TEAMS (draw result view)
   ============================================================ */
function renderTeams() {
  const ts = teamsArray();
  $("app").innerHTML = `
    <div class="card">
      <div class="stage-head">
        <h2 class="stage-title">Teams Drawn 🎉</h2>
        <p class="stage-sub">${ts.length} teams formed — each pairs one Group A player with one Group B player.</p>
      </div>
      <div class="team-grid">${ts.map(teamCardHTML).join("")}</div>
      <div class="btn-row between" style="margin-top:22px;">
        <button class="btn ghost" id="btnBackDraw">← Back to draw</button>
        <button class="btn primary big" id="btnToFixtures">Fixtures Roadmap →</button>
      </div>
    </div>
  `;
  $("btnBackDraw").addEventListener("click", () => { state.stage = "draw"; save(); render(); });
  $("btnToFixtures").addEventListener("click", () => { state.stage = "fixtures"; save(); render(); });
}

/* ============================================================
   FIXTURES — round robin (circle method)
   ============================================================ */
function createGroupFixtures() {
  const ids = state.teams.teamIds;

  const rounds = [];
  if (ids.length % 2 === 0) {
    const arr = ids.slice();
    const half = ids.length / 2;
    for (let r = 0; r < ids.length - 1; r++) {
      const round = [];
      for (let i = 0; i < half; i++) {
        const t1 = arr[i], t2 = arr[arr.length - 1 - i];
        round.push(r % 2 === 0 ? [t1, t2] : [t2, t1]);
      }
      rounds.push(round);
      const fixed = arr[0];
      const rest = arr.slice(1);
      rest.unshift(rest.pop());
      arr.splice(0, arr.length, fixed, ...rest);
    }
  } else {
    const padded = ids.slice().concat([null]);
    for (let r = 0; r < padded.length - 1; r++) {
      const round = [];
      for (let i = 0; i < padded.length / 2; i++) {
        const t1 = padded[i], t2 = padded[padded.length - 1 - i];
        if (t1 && t2) round.push([t1, t2]);
      }
      rounds.push(round);
      const fixed = padded[0];
      const rest = padded.slice(1);
      rest.unshift(rest.pop());
      padded.splice(0, padded.length, fixed, ...rest);
    }
  }

  let num = 1;
  rounds.forEach((round, ri) => {
    round.forEach(([h, aw]) => {
      const id = "M" + num;
      state.matches[id] = {
        id, num: num++, stage: "group",
        t1: h, t2: aw,
        s1: null, s2: null,
        games: [],
        played: false, round: ri + 1,
      };
    });
  });
}

function standings() {
  const ts = teamsArray();
  const rows = ts.map((t) => ({ t, p: 0, w: 0, l: 0, sf: 0, sa: 0, pf: 0, pa: 0, pts: 0 }));
  const idx = {}; rows.forEach((r, i) => (idx[r.t.id] = i));
  matchesOfStage("group").forEach((m) => {
    if (!m.played) return;
    const i1 = idx[m.t1], i2 = idx[m.t2];
    if (i1 == null || i2 == null) return;
    const r1 = rows[i1], r2 = rows[i2];
    const s1 = m.s1 ?? 0, s2 = m.s2 ?? 0;
    const p1 = m.games.reduce((a, g) => a + (g.p1 ?? 0), 0);
    const p2 = m.games.reduce((a, g) => a + (g.p2 ?? 0), 0);
    r1.p++; r2.p++;
    r1.sf += s1; r1.sa += s2; r1.pf += p1; r1.pa += p2;
    r2.sf += s2; r2.sa += s1; r2.pf += p2; r2.pa += p1;
    if (m.winner === 1) { r1.w++; r2.l++; r1.pts += 2; }
    else { r2.w++; r1.l++; r2.pts += 2; }
  });
  rows.forEach((r) => { r.sd = r.sf - r.sa; r.pd = r.pf - r.pa; });
  rows.sort((x, y) =>
    y.pts - x.pts ||
    y.w - x.w ||
    y.sd - x.sd ||
    y.pd - x.pd ||
    x.t.name.localeCompare(y.t.name)
  );
  return rows;
}

function knockoutSize() {
  const n = teamsArray().length;
  return n >= 1 && n <= 4 ? 2 : 4; // 2 = straight final, 4 = semis + final
}

/* ============================================================
   ROADMAP — horizontal bracket: Group rounds → Semis → Final → Champion
   ============================================================ */
function findMatchAny(mid) {
  if (state.matches[mid]) return state.matches[mid];
  if (state.ko) {
    if (state.ko.final && state.ko.final.id === mid) return state.ko.final;
    const s = (state.ko.semis || []).find((x) => x.id === mid);
    if (s) return s;
  }
  return null;
}

function bindMatchClicks() {
  document.querySelectorAll("[data-mid]").forEach((el) =>
    el.addEventListener("click", () => {
      const m = findMatchAny(el.dataset.mid);
      if (m && m.t1 && m.t2) openScoreModal(m.id);
    })
  );
}

function matchCardHTML(m) {
  const t1 = teamById(m.t1), t2 = teamById(m.t2);
  const w = m.played ? m.winner : 0;
  const bo = GAMES_OF[m.stage];
  const dots1 = m.games.map((g) => `<span class="sdot ${g.winner === 1 ? "win" : ""}"></span>`).join("");
  const dots2 = m.games.map((g) => `<span class="sdot ${g.winner === 2 ? "win" : ""}"></span>`).join("");
  const tag = m.played
    ? `<div class="m-tag">✅ <b>${esc((m.winner === 1 ? t1 : t2)?.name ?? "")}</b> won ${m.s1}:${m.s2} · 📅 ${esc(fmtDate(resultDate()))}</div>`
    : `<div class="m-tag">⏳ Best of ${bo} sets · 11 points</div>`;
  return `
    <div class="match ${m.played ? "played" : ""}" data-mid="${m.id}">
      <div class="m-idx">${m.stage === "group" ? m.num : m.id}</div>
      <div class="side ${w === 2 ? "loser-dim" : ""} ${w === 1 ? "winner-glow" : ""}">
        <span class="nm">🟠 ${esc(t1 ? t1.name : "?")}</span>
        <span class="sub"><span class="pill pa">A</span> ${esc(playerName(t1 ? t1.pa : null))}${dots1 ? ` <span class="set-dots">${dots1}</span>` : ""}</span>
      </div>
      <div class="m-score ${m.played ? "final" : ""}">${m.played ? `${m.s1}:${m.s2}` : "vs"}</div>
      <div class="side right ${w === 1 ? "loser-dim" : ""} ${w === 2 ? "winner-glow" : ""}">
        <span class="nm">${esc(t2 ? t2.name : "?")} 🔵</span>
        <span class="sub">${esc(playerName(t2 ? t2.pb : null))} <span class="pill pb">B</span>${dots2 ? ` <span class="set-dots">${dots2}</span>` : ""}</span>
      </div>
      <div class="m-idx">✏️</div>
      ${tag}
    </div>
  `;
}

const tbdCard = (label) => `
  <div class="match tbd">
    <div class="m-idx">🔒</div>
    <div class="side"><span class="nm muted">To be decided</span><span class="sub">${esc(label)}</span></div>
    <div class="m-score">vs</div>
    <div class="side right"><span class="nm muted">To be decided</span><span class="sub"></span></div>
    <div class="m-idx"></div>
  </div>`;

const colWrap = (title, badge, body, headCls = "") => `
  <div class="rcol">
    <div class="rcol-head ${headCls}">${title}${badge ? `<span class="rbadge">${badge}</span>` : ""}</div>
    <div class="rcol-body">${body}</div>
  </div>`;

function champCol() {
  const ko = state.ko;
  let inner;
  if (ko && ko.final && ko.final.played) {
    const ct = teamById(ko.final.winner === 1 ? ko.final.t1 : ko.final.t2);
    inner = `
      <div class="champ-card">
        <div class="champ-trophy">🏆</div>
        <div class="champ-label">CHAMPION</div>
        <div class="champ-name">${esc(ct.name)}</div>
        <div class="champ-sub">${esc(playerName(ct.pa))} · ${esc(playerName(ct.pb))}</div>
      </div>`;
  } else {
    inner = `
      <div class="champ-card dim">
        <div class="champ-trophy">🏆</div>
        <div class="champ-label">CHAMPION</div>
        <div class="champ-sub">Win the final to lift the trophy</div>
      </div>`;
  }
  return colWrap("Champion", "", inner, "gold");
}

function syncFinal() {
  if (!state.ko || state.ko.size !== 4) return;
  const semis = state.ko.semis || [];
  if (!semis.length) return;
  const allPlayed = semis.every((s) => s.played);
  if (allPlayed) {
    const w1 = semis[0].winner === 1 ? semis[0].t1 : semis[0].t2;
    const w2 = semis[1].winner === 1 ? semis[1].t1 : semis[1].t2;
    if (!state.ko.final) {
      state.ko.final = { id: "F", num: 3, stage: "ko", label: "Final", t1: w1, t2: w2, s1: null, s2: null, games: [], played: false, winner: null };
      save();
      toast("🏆 Semi-finals decided — the Final is set!");
    } else if (!state.ko.final.played) {
      state.ko.final.t1 = w1; state.ko.final.t2 = w2;
      save();
    }
  } else if (state.ko.final && !state.ko.final.played) {
    state.ko.final = null;
    save();
  }
}
function koMatchTag(m) {
  return m.played
    ? `✅ <b>${esc((m.winner === 1 ? teamById(m.t1) : teamById(m.t2))?.name ?? "")}</b> through · 📅 ${esc(fmtDate(resultDate()))}`
    : "⏳ Best of 5 sets · 11 points each";
}

function renderRoadmap() {
  const koStage = state.ko !== null; // knockout begun (semis created or final set)
  if (!state.teams) {
    $("app").innerHTML = `
      <div class="card">
        <div class="stage-head"><h2 class="stage-title">No teams yet</h2></div>
        <div class="empty-hint">Go back and draw teams first.</div>
        <div class="btn-row"><button class="btn primary" id="btnGoDraw2">← Draw</button></div>
      </div>`;
    $("btnGoDraw2").addEventListener("click", () => { state.stage = "draw"; save(); render(); });
    return;
  }

  syncFinal();

  const rows = standings();
  const qual = knockoutSize();
  const ko = state.ko;

  const grouped = {};
  matchesOfStage("group").forEach((m) => { (grouped[m.round] = grouped[m.round] || []).push(m); });
  const roundKeys = Object.keys(grouped).map(Number).sort((a, b) => a - b);
  const played = matchesOfStage("group").filter((m) => m.played).length;
  const total = matchesOfStage("group").length;
  const groupDone = total > 0 && played === total;

  /* Build columns left → right */
  const cols = [];
  roundKeys.forEach((rk) => {
    const done = grouped[rk].filter((m) => m.played).length;
    cols.push(colWrap(`Round ${rk}`, `${done}/${grouped[rk].length}`, grouped[rk].map(matchCardHTML).join("")));
  });

  if (qual === 4) {
    const semiBody = ko && ko.semis && ko.semis.length
      ? ko.semis.map(matchCardHTML).join("")
      : tbdCard("1st vs 4th") + tbdCard("2nd vs 3rd");
    cols.push(colWrap("Semi-finals", "Best of 5", semiBody, "amber"));
  }

  const finalBody = ko && ko.final
    ? matchCardHTML(ko.final)
    : tbdCard(qual === 4 ? "Semi-final winners" : "Top 2 clash");
  cols.push(colWrap("Final", "Best of 5", finalBody, "gold"));
  cols.push(champCol());

  const bracketHTML = cols
    .map((c, i) => (i ? `<div class="col-sep">➔</div>` : "") + c)
    .join("");

  /* Standings (collapsible) */
  const tableHTML = `
    <details class="card table-card">
      <summary>🏆 Points Table &amp; Qualification <span class="rbadge">${qual === 2 ? "Top 2 → Final" : "Top 4 → Semis"}</span></summary>
      <div class="table-wrap" style="margin-top:12px;">
        <table>
          <thead><tr>
            <th>#</th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">L</th>
            <th class="num">Sets</th><th class="num">Pts</th>
          </tr></thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr class="${i < qual ? "q" : (qual === 4 && i === qual ? "qz" : "")}">
                <td class="pos">${i + 1}</td>
                <td class="tname">${esc(r.t.name)}</td>
                <td class="num">${r.p}</td>
                <td class="num">${r.w}</td>
                <td class="num">${r.l}</td>
                <td class="num muted">${r.sf}:${r.sa}</td>
                <td class="num pts">${r.pts}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </details>
  `;

  const banner = groupDone && !koStage ? `
    <div class="banner gold">
      <span class="big">🏁</span>
      <div style="flex:1;">Group stage complete — ${qual === 2 ? "the top 2" : "the top 4"} team${qual === 2 ? "s are" : "s are"} through!</div>
      <button class="btn primary" id="btnToKO">Start Knockout →</button>
    </div>` : "";

  $("app").innerHTML = `
    <div class="roadmap-page">
      <div class="stage-head">
        <h2 class="stage-title">${koStage ? "Knockout Roadmap 🥊" : "Tournament Roadmap 🗺️"}</h2>
        <p class="stage-sub">Left to right: group rounds ${qual === 4 ? "→ semi-finals " : ""}→ final → champion. Click any match to enter its score. Use <b>Ctrl + scroll</b> or the buttons to zoom.</p>
      </div>
      <div class="bracket-toolbar">
        <div class="btn-row" style="margin:0;">
          ${koStage
            ? `<button class="btn ghost" id="btnBackFix">← Group stage only</button>`
            : `<button class="btn ghost" id="btnBackTeams2">← Teams</button>`}
          <span class="muted" style="align-self:center;font-size:13px;">${played}/${total} group matches played</span>
        </div>
        <div class="zoom-pill">
          <button class="zbtn" id="zOut" title="Zoom out">−</button>
          <span class="zval" id="zoomVal">100%</span>
          <button class="zbtn" id="zIn" title="Zoom in">＋</button>
          <button class="zbtn" id="zReset" title="Reset zoom">⟲</button>
        </div>
      </div>
      <div class="bracket-viewport" id="bracketViewport">
        <div class="bracket" id="bracket">${bracketHTML}</div>
      </div>
    </div>
    <div class="roadmap-aux">
      ${banner}
      ${tableHTML}
    </div>
  `;

  applyZoom();
  $("zIn").addEventListener("click", () => setZoom(state.zoom + 0.1));
  $("zOut").addEventListener("click", () => setZoom(state.zoom - 0.1));
  $("zReset").addEventListener("click", () => setZoom(1));
  $("bracketViewport").addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(state.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });

  const bb = $("btnBackTeams2");
  if (bb) bb.addEventListener("click", () => { state.stage = "teams"; save(); render(); });
  const bf = $("btnBackFix");
  if (bf) bf.addEventListener("click", () => { window.scrollTo({ top: 0, behavior: "smooth" }); });
  const bk = $("btnToKO");
  if (bk) bk.addEventListener("click", buildKnockout);
  bindMatchClicks();
}

/* ---------------- Score modal ---------------- */
function openScoreModal(mid) {
  const m = findMatchAny(mid);
  if (!m) return;
  modalCtx = { matchId: mid, ko: m.stage === "ko" };
  const t1 = teamById(m.t1), t2 = teamById(m.t2);
  const bo = GAMES_OF[m.stage];
  const need = SETS_TO_WIN[m.stage];

  const setRows = Array.from({ length: bo }, (_, i) => {
    const g = m.games[i] || { p1: "", p2: "" };
    const res = g.p1 === "" || g.p2 === "" ? "" : (g.p1 > g.p2 ? "W" : "L");
    return `
      <div class="set-row">
        <span class="slbl">Set ${i + 1}</span>
        <span></span>
        <input type="number" min="0" max="60" class="score-in" id="g${i}_1" value="${g.p1}" inputmode="numeric" />
        <input type="number" min="0" max="60" class="score-in" id="g${i}_2" value="${g.p2}" inputmode="numeric" />
        <span class="set-res ${res === "W" ? "w" : res === "L" ? "l" : ""}" id="res${i}">${res === "W" ? "✔" : res === "L" ? "–" : ""}</span>
      </div>
    `;
  }).join("");

  openModal(`
    <div class="m-title-row">
      <h3>${esc(t1?.name ?? "?")} <span class="muted">vs</span> ${esc(t2?.name ?? "?")}</h3>
      <button class="m-close" data-close="1" title="Close">✕</button>
    </div>
    <p class="m-sub">${m.stage === "group" ? "Match #" + m.num : esc(m.label || "Knockout")} · Best of ${bo} — first to <b>${need} sets</b>. Each set to 11 points (win by 2).</p>
    <div class="m-vs">
      <div class="vs-side"><div class="vn">🟠 ${esc(t1?.name ?? "?")}</div><div class="vt">${esc(playerName(t1?.pa))}</div></div>
      <div class="vs-x">VS</div>
      <div class="vs-side"><div class="vn">${esc(t2?.name ?? "?")} 🔵</div><div class="vt">${esc(playerName(t2?.pb))}</div></div>
    </div>
    <div class="set-row" style="margin-bottom:6px;">
      <span class="slbl"></span><span></span>
      <span class="slbl" style="text-align:center;">🟠 ${esc(playerName(t1?.pa))}</span>
      <span class="slbl" style="text-align:center;">🔵 ${esc(playerName(t2?.pb))}</span>
      <span></span>
    </div>
    ${setRows}
    <div class="form-err" id="scoreErr"></div>
    <div class="m-actions">
      <button class="btn ghost" id="btnClearScore">Clear</button>
      <button class="btn green" id="btnSaveScore">Save Result ✓</button>
    </div>
  `);

  $("btnSaveScore").addEventListener("click", () => saveScore(m));
  $("btnClearScore").addEventListener("click", () => {
    m.games = []; m.played = false; m.s1 = null; m.s2 = null; m.winner = null;
    save(); closeModal(); render(); toast("Result cleared.");
  });
  document.querySelectorAll(".score-in").forEach((inp) => {
    inp.addEventListener("input", liveValidate);
    inp.addEventListener("focus", () => inp.select());
  });
  liveValidate();
}

function readGames(m) {
  const bo = GAMES_OF[m.stage];
  const games = [];
  for (let i = 0; i < bo; i++) {
    const e1 = $("g" + i + "_1"), e2 = $("g" + i + "_2");
    const v1 = e1.value === "" ? null : parseInt(e1.value, 10);
    const v2 = e2.value === "" ? null : parseInt(e2.value, 10);
    games.push({ p1: v1, p2: v2 });
  }
  return games;
}

function validGame(a, b) {
  if (a == null || b == null) return false;
  if (a < 0 || b < 0 || a > 60 || b > 60) return false;
  if (a === b) return false;
  const hi = Math.max(a, b);
  if (hi < POINTS_TO_WIN_SET) return false;
  if (hi === POINTS_TO_WIN_SET) return true;   // 11:x (x <= 9)
  return hi - Math.min(a, b) === 2;            // deuce: win by 2
}

function liveValidate() {
  if (!modalCtx) return;
  const m = findMatchAny(modalCtx.matchId);
  const games = readGames(m);
  const bo = GAMES_OF[m.stage];
  let s1 = 0, s2 = 0, err = "";
  for (let i = 0; i < bo; i++) {
    const e1 = $("g" + i + "_1"), e2 = $("g" + i + "_2"), re = $("res" + i);
    e1.classList.remove("err"); e2.classList.remove("err");
    const g = games[i];
    const empty = g.p1 == null && g.p2 == null;
    const full = g.p1 != null && g.p2 != null;
    if (empty) { re.textContent = ""; continue; }
    if (!full) { re.textContent = "…"; continue; }
    if (!validGame(g.p1, g.p2)) {
      re.textContent = "✕"; re.className = "set-res l";
      e1.classList.add("err"); e2.classList.add("err");
      if (!err) err = `Set ${i + 1}: must reach 11 and win by 2 (e.g. 11-9, 13-11).`;
      continue;
    }
    if (g.p1 > g.p2) { s1++; re.textContent = "✔"; re.className = "set-res w"; }
    else { s2++; re.textContent = "✔"; re.className = "set-res w"; }
  }
  const decided = s1 === SETS_TO_WIN[m.stage] || s2 === SETS_TO_WIN[m.stage];
  if (!err && !decided && games.some((g) => g.p1 != null && g.p2 != null)) {
    err = `One side must reach ${SETS_TO_WIN[m.stage]} set wins.`;
  }
  $("scoreErr").textContent = err;
  return { games, s1, s2, err, decided };
}

function saveScore(m) {
  const r = liveValidate();
  if (r.err) { toast("Please fix the highlighted sets."); return; }
  m.games = r.games;
  m.s1 = r.s1; m.s2 = r.s2;
  m.played = true;
  m.winner = r.s1 > r.s2 ? 1 : 2;
  m.date = resultDate(); // audit: when this result was recorded
  if (!state.dateStamp) { state.dateStamp = m.date; save(); }
  const wid = m.winner === 1 ? m.t1 : m.t2;
  closeModal();
  render();
  toast(`✅ ${teamById(wid)?.name ?? "Team"} wins ${m.s1}:${m.s2}! (dated ${fmtDate(m.date)})`);
}

/* ============================================================
   KNOCKOUT — semis (T1vT4, T2vT3) + final, or straight final
   ============================================================ */
function buildKnockout() {
  const rows = standings();
  const qual = knockoutSize();
  const top = rows.slice(0, qual).map((r) => r.t.id);
  state.ko = { size: qual, semis: [], final: null, createdAt: resultDate() };
  if (qual === 4) {
    state.ko.semis = [
      { id: "S1", num: 1, stage: "ko", label: "Semi-final 1", t1: top[0], t2: top[3], s1: null, s2: null, games: [], played: false, winner: null },
      { id: "S2", num: 2, stage: "ko", label: "Semi-final 2", t1: top[1], t2: top[2], s1: null, s2: null, games: [], played: false, winner: null },
    ];
  } else {
    state.ko.final = { id: "F", num: 1, stage: "ko", label: "Final", t1: top[0], t2: top[1], s1: null, s2: null, games: [], played: false, winner: null };
  }
  save();
  render();
  toast(qual === 4 ? "Semi-finals created!" : "Final created!");
}

/* ============================================================
   RESET + ROUTER
   ============================================================ */
$("btnReset").addEventListener("click", () => {
  if (!confirm("Reset everything — players, teams, fixtures and results will be wiped. Continue?")) return;
  state = fresh();
  save();
  render();
  toast("Tournament reset.");
});

function render() {
  document.body.classList.toggle("roadmap-mode", state.stage === "fixtures");
  renderStepper();
  switch (state.stage) {
    case "draw": renderDraw(); break;
    case "teams": renderTeams(); break;
    case "fixtures": renderRoadmap(); break;
    default: renderPlayers();
  }
}

render();
