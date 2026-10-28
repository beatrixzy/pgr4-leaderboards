// PGR4 live leaderboards: polls the PGR4-Leaderboard backend (Cloudflare
// Worker) for board activity, the selected board, and the latest results.
(() => {
  const cfg = window.PGR4_LEADERBOARD || {};
  const params = new URLSearchParams(location.search);
  const API = (params.get("api") || cfg.api || "").replace(/\/+$/, "");
  const TITLE = cfg.title || "4D5307F9";
  const BASE = `${API}/v1/${TITLE}`;
  const PAGE = 25;
  const POLL_BOARD_MS = 5000;
  const POLL_FEED_MS = 5000;
  const POLL_VIEWS_MS = 15000;

  const COL_RANK = 65535, COL_RATING = 65534, COL_GAMERTAG = 65533;

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k ?? "")));
    return n;
  };

  let schema = null;
  let activity = new Map(); // view id -> {rows, updated}
  let current = null; // view id
  let page = 0;
  let lastRows = new Map(); // xuid -> signature, for flashing changes
  let feedSince = 0;
  let feedItems = [];
  let pageLoadedAt = Date.now();

  // ---- Names --------------------------------------------------------------
  const CITY_FIX = { "New York": "New York", "St Petersburg": "St. Petersburg" };

  function describe(viewId) {
    const v = schema?.views[String(viewId)];
    if (!v) return { group: "Other", title: `View ${viewId}`, sort: [9, viewId] };
    // PGR4 keeps career totals (the 57-59 column layout) under some views
    // whose SPA names say otherwise.
    if (schema.layouts[v.layout].length > 50) {
      return { group: "Career", title: v.key === "Player_Statistics" ? "Player statistics" : `Career stats (${v.key.replace(/_/g, " ")})`, career: true, sort: [0, v.key] };
    }
    let key = v.key;
    const bonus = key.startsWith("zz_");
    if (bonus) key = key.slice(3);
    let m;
    if ((m = key.match(/^TimeAttack_(.+)_(\d+)_([A-Z])$/))) {
      const city = m[1].replace(/_/g, " ");
      return {
        group: `Time Attack · ${CITY_FIX[city] || city}`,
        title: `${CITY_FIX[city] || city} · Route ${m[2]} · Class ${m[3]}`,
        kind: "time",
        sort: [1, city, +m[2], m[3]],
      };
    }
    if ((m = key.match(/^ArcadeMode_Chapter_(\d+)_Event_(\d+)_(\w+)$/))) {
      return {
        group: "Arcade",
        title: `Chapter ${m[1]} · Event ${m[2]} (${m[3] === "Car" ? "car" : m[3].toLowerCase()})`,
        sort: [2, +m[1], +m[2], m[3]],
      };
    }
    if ((m = key.match(/^TestTrack_(\w+?)_(.+)$/))) {
      return {
        group: "Test Track",
        title: `${m[1]} · ${m[2].replace(/_/g, " ").replace(/Class/, "Class ")}`,
        kind: m[1] === "Timed" ? "time" : undefined,
        sort: [3, key],
      };
    }
    if (key.startsWith("Coop")) return { group: "Co-op", title: key.replace(/^Coop_?/, "").replace(/_/g, " "), sort: [4, key] };
    if (key.startsWith("WorldChallengeMode")) {
      return { group: "World Challenge", title: key.replace(/^WorldChallengeMode_?/, "").replace(/([a-z])([A-Z0-9])/g, "$1 $2"), sort: [5, key] };
    }
    if (key === "Player_Statistics") return { group: "Career", title: "Player statistics", sort: [0, key] };
    return { group: "Other", title: key.replace(/_/g, " "), sort: [9, key] };
  }

  function columnsFor(viewId) {
    const v = schema?.views[String(viewId)];
    return v ? schema.layouts[v.layout] : [];
  }

  // ---- Values -------------------------------------------------------------
  function fmtTime(ms) {
    ms = Number(ms);
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = Math.floor(ms % 1000);
    return `${m}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
  }
  function fmtNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString() : String(v);
  }
  function cellValue(col, value, kind) {
    if (!value) return "—";
    const [t, v] = value;
    if (t === 7) return new Date(Number((BigInt(v) - 116444736000000000n) / 10000n)).toLocaleDateString();
    if (kind === "time" && col.name === "Result") return fmtTime(v);
    if (t === 3 || t === 5) return Number(v).toFixed(2);
    return fmtNumber(v);
  }
  // The headline figure for a row: the result time on timed boards, else the rating.
  function headline(viewId, row) {
    const d = describe(viewId);
    const result = columnsFor(viewId).find((c) => c.name === "Result");
    if (d.kind === "time" && result && row.columns[result.id]) return fmtTime(row.columns[result.id][1]);
    const score = columnsFor(viewId).find((c) => c.id === COL_RATING);
    return score ? `${fmtNumber(row.rating)} ${score.name === "RATING" || score.name === "Rating" ? "pts" : score.name.toLowerCase()}` : fmtNumber(row.rating);
  }
  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(ms).toLocaleDateString();
  }

  // ---- Network ------------------------------------------------------------
  async function get(path) {
    const r = await fetch(`${BASE}/${path}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }
  function setStatus(ok, text) {
    $("status").className = `status ${ok ? "live" : "down"}`;
    $("status-text").textContent = text;
  }

  // ---- Board list ---------------------------------------------------------
  function renderBoards() {
    const q = $("search").value.trim().toLowerCase();
    const onlyActive = $("only-active").checked;
    const groups = new Map();
    for (const id of Object.keys(schema.views)) {
      const a = activity.get(+id);
      if (onlyActive && !a) continue;
      const d = describe(id);
      if (q && !`${d.group} ${d.title}`.toLowerCase().includes(q)) continue;
      if (!groups.has(d.group)) groups.set(d.group, []);
      groups.get(d.group).push({ id: +id, d, a });
    }
    const nav = $("boards");
    nav.replaceChildren();
    if (!groups.size) {
      nav.append(el("p", { class: "empty" }, onlyActive ? "No times posted yet. Untick the box to see every board." : "No boards match."));
      return;
    }
    const sorted = [...groups.entries()].sort((x, y) => cmpSort(x[1][0].d.sort, y[1][0].d.sort));
    for (const [name, items] of sorted) {
      items.sort((x, y) => cmpSort(x.d.sort, y.d.sort));
      const open = q !== "" || onlyActive || items.some((i) => i.id === current);
      const det = el("details", { class: "group" });
      det.open = open;
      det.append(el("summary", {}, name, el("span", { class: "count" }, items.length)));
      for (const { id, d, a } of items) {
        const fresh = a && a.updated > pageLoadedAt;
        const b = el("button", { type: "button", class: `board-link${id === current ? " active" : ""}${fresh ? " fresh" : ""}`, onclick: () => select(id) },
          el("span", {}, name.includes(" · ") ? d.title.replace(`${name.split(" · ")[1]} · `, "") : d.title),
          el("span", { class: "n" }, a ? a.rows : ""));
        det.append(b);
      }
      nav.append(det);
    }
  }
  function cmpSort(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      if (a[i] === undefined) return -1;
      if (b[i] === undefined) return 1;
      return typeof a[i] === "number" && typeof b[i] === "number" ? a[i] - b[i] : String(a[i]).localeCompare(String(b[i]));
    }
    return 0;
  }

  async function pollViews() {
    try {
      const r = await get("views");
      activity = new Map(r.views.map((v) => [v.view, v]));
      renderBoards();
      if (current === null && r.views.length) {
        const latest = [...r.views].sort((a, b) => b.updated - a.updated)[0];
        select(latest.view);
      }
    } catch {
      /* status shows feed health */
    }
  }

  // ---- Selected board -----------------------------------------------------
  function select(id) {
    current = id;
    page = 0;
    lastRows = new Map();
    const d = describe(id);
    $("board-group").textContent = d.group;
    $("board-title").textContent = d.title;
    history.replaceState(null, "", `#${id}`);
    renderBoards();
    pollBoard();
  }

  async function pollBoard() {
    if (current === null) return;
    const id = current;
    try {
      const r = await get(`leaderboard?view=${id}&start=${page * PAGE + 1}&count=${PAGE}`);
      if (id !== current) return;
      renderBoard(id, r);
    } catch (e) {
      if (id === current) $("board-meta").textContent = `Couldn't load (${e.message})`;
    }
  }

  function renderBoard(id, r) {
    const d = describe(id);
    const cols = columnsFor(id).filter(
      (c) =>
        ![COL_RANK, COL_GAMERTAG, COL_RATING].includes(c.id) &&
        c.name !== "Nationality" &&
        (!c.hidden || c.name === "Result" || d.career),
    );
    const scoreCol = columnsFor(id).find((c) => c.id === COL_RATING);
    const thead = $("board-table").tHead;
    thead.replaceChildren(
      el("tr", {},
        el("th", {}, "#"),
        el("th", {}, "Player"),
        ...cols.map((c) => el("th", { class: "num" }, d.kind === "time" && c.name === "Result" ? "Time" : c.name)),
        d.kind === "time" ? "" : el("th", { class: "num" }, scoreCol ? (scoreCol.name.toUpperCase() === "RATING" ? "Score" : scoreCol.name) : "Score"),
        el("th", { class: "num" }, "Set")));
    const tbody = $("board-table").tBodies[0];
    tbody.replaceChildren();
    if (!r.rows.length) {
      tbody.append(el("tr", {}, el("td", { class: "empty", colspan: cols.length + 4 }, "No times on this board yet.")));
    }
    const seen = new Map();
    for (const row of r.rows) {
      const sig = `${row.rank}|${row.rating}|${row.updated}`;
      const changed = lastRows.size && lastRows.get(row.xuid) !== sig;
      seen.set(row.xuid, sig);
      tbody.append(
        el("tr", { class: `${row.rank <= 3 ? `r${row.rank}` : ""}${changed ? " flash" : ""}` },
          el("td", { class: "rank" }, row.rank),
          el("td", { class: "player" }, row.gamertag),
          ...cols.map((c) => el("td", { class: `num${d.kind === "time" && c.name === "Result" ? " mono" : ""}` }, cellValue(c, row.columns[c.id], d.kind))),
          d.kind === "time" ? "" : el("td", { class: "num mono" }, fmtNumber(row.rating)),
          el("td", { class: "num", title: new Date(row.updated).toLocaleString() }, ago(row.updated))));
    }
    lastRows = seen;
    $("board-meta").textContent = `${r.total.toLocaleString()} ${r.total === 1 ? "player" : "players"}`;
    const pages = Math.max(1, Math.ceil(r.total / PAGE));
    $("pager").hidden = pages <= 1;
    $("page-label").textContent = `Page ${page + 1} of ${pages}`;
    $("prev").disabled = page === 0;
    $("next").disabled = page + 1 >= pages;
  }

  // ---- Live feed ----------------------------------------------------------
  async function pollFeed() {
    try {
      const r = await get(`recent?since=${feedSince}&limit=25`);
      setStatus(true, "Live");
      const fresh = feedSince !== 0;
      feedSince = Math.max(feedSince, ...r.rows.map((x) => x.updated), 0) || feedSince;
      r.rows = r.rows.filter((x) => !describe(x.view).career);
      if (r.rows.length) {
        const keyed = new Map(feedItems.map((x) => [`${x.view}|${x.xuid}`, x]));
        for (const row of r.rows) keyed.set(`${row.view}|${row.xuid}`, { ...row, isNew: fresh });
        feedItems = [...keyed.values()].sort((a, b) => b.updated - a.updated).slice(0, 25);
        if (fresh && r.rows.some((x) => x.view === current)) pollBoard();
        if (fresh) pollViews();
      }
      renderFeed();
      if (feedSince === 0) feedSince = 1;
    } catch {
      setStatus(false, API ? "Server unreachable" : "No server configured");
    }
  }

  function renderFeed() {
    const list = $("feed");
    list.replaceChildren();
    if (!feedItems.length) {
      list.append(el("li", { class: "empty" }, "Nothing yet. Results show up here as soon as someone finishes a run."));
      return;
    }
    for (const it of feedItems) {
      const d = describe(it.view);
      list.append(
        el("li", { class: it.isNew ? "new" : "" },
          el("span", { class: "who" }, it.gamertag),
          el("span", { class: "what" }, `#${it.rank} on `, el("button", { type: "button", onclick: () => select(it.view) }, d.title)),
          el("span", { class: "val" }, headline(it.view, it)),
          el("span", { class: "when" }, ago(it.updated))));
      it.isNew = false;
    }
  }

  // ---- Start --------------------------------------------------------------
  async function start() {
    $("search").addEventListener("input", renderBoards);
    $("only-active").addEventListener("change", renderBoards);
    $("prev").addEventListener("click", () => { page = Math.max(0, page - 1); pollBoard(); });
    $("next").addEventListener("click", () => { page += 1; pollBoard(); });
    if (!API || API.startsWith("REPLACE")) {
      setStatus(false, "No server configured");
      return;
    }
    try {
      schema = await get("schema");
    } catch (e) {
      setStatus(false, "Server unreachable");
      setTimeout(start, 10000);
      return;
    }
    const fromHash = Number(location.hash.slice(1));
    if (fromHash && schema.views[String(fromHash)]) select(fromHash);
    await Promise.all([pollViews(), pollFeed()]);
    // Background tabs don't poll (keeps the free Cloudflare quota for people
    // actually looking); coming back refreshes at once.
    const whenVisible = (fn) => () => { if (!document.hidden) fn(); };
    setInterval(whenVisible(pollFeed), POLL_FEED_MS);
    setInterval(whenVisible(pollBoard), POLL_BOARD_MS);
    setInterval(whenVisible(pollViews), POLL_VIEWS_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { pollFeed(); pollBoard(); pollViews(); }
    });
    setInterval(renderFeed, 30000); // refresh "x ago"
  }
  start();
})();
