/*
 * Mawari PoC — 回り道ウォーキング＆運賃節約アプリ (Web版)
 *
 * 経路データは Transit API (ls8h) をブラウザから直接取得する。
 *   - 無認証・読み取り専用・CORS有効 (Access-Control-Allow-Origin: *)
 *   - 運賃(fare)はフィード依存で返る (メトロ/バス=○, JR等=null)
 *
 * 回り道の生成方針 (この API だけで成立させるための PoC ロジック):
 *   1. 最短経路(最速)を基準 T0/F0 とする
 *   2. 複数経路(numItineraries)で代替ルートを列挙
 *   3. 「鉄道を避ける」検索(avoidModes)でバス＋徒歩寄りの候補も追加
 *   4. 許容追加時間内に収まるものを残し、運賃差額・徒歩量を算出して提示
 */

const API_BASE = "https://api.transit.ls8h.com";

// 徒歩の推定パラメータ (API は徒歩距離[m]を返さないため時間から換算)
const WALK_SPEED_M_PER_MIN = 80; // 一般的な徒歩速度
const STRIDE_M = 0.7; // 1歩の歩幅
const WALK_MET = 3.5; // 徒歩のメッツ
const BODY_WEIGHT_KG = 60; // 消費カロリー推定用の体重仮定

// numItineraries は 8 以上で空配列が返ることがあるため 5 に抑える
const MAX_ITINERARIES = 5;

// ---- API クライアント -------------------------------------------------

async function apiGet(path, params) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  const data = await res.json();
  if (data && data.error) {
    throw new Error("API error: " + JSON.stringify(data.error));
  }
  return data;
}

// 駅 + 場所のサジェストをまとめて取得
async function suggest(q) {
  const [stationsRes, placesRes] = await Promise.allSettled([
    apiGet("/api/v1/locations/suggest", { q, limit: 6 }),
    apiGet("/api/v1/places/suggest", { q, limit: 6 }),
  ]);

  const out = [];
  if (stationsRes.status === "fulfilled") {
    for (const s of stationsRes.value.stations || []) {
      out.push({
        label: s.name,
        meta: s.feedName || "駅",
        value: s.id, // 駅IDをそのまま from/to に使える
        lat: s.lat,
        lon: s.lon,
        kind: "station",
      });
    }
  }
  if (placesRes.status === "fulfilled") {
    for (const p of placesRes.value.places || []) {
      // 駅は上で拾っているので場所/住所/施設を中心に追加
      if (p.kind === "station") continue;
      out.push({
        label: p.name,
        meta: p.description || p.kind || "場所",
        value: p.endpoint || p.id, // endpoint は "geo:lat,lon"
        lat: p.lat,
        lon: p.lon,
        kind: p.kind || "place",
      });
    }
  }
  // ラベル+値で重複排除
  const seen = new Set();
  return out.filter((o) => {
    const key = o.label + "|" + o.value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function planJourney(params) {
  return apiGet("/api/v1/plan", params);
}

// ---- 計算ロジック -----------------------------------------------------

function fareValue(journey) {
  // 運賃は ic を優先、なければ ticket。fare 自体が無ければ null。
  const f = journey.fare;
  if (!f) return null;
  if (typeof f.ic === "number") return f.ic;
  if (typeof f.ticket === "number") return f.ticket;
  return null;
}

function totalWalkSecs(journey) {
  let secs = (journey.accessWalkSecs || 0) + (journey.egressWalkSecs || 0);
  for (const leg of journey.legs || []) {
    if (leg.kind === "walk") {
      secs += Math.max(0, (leg.arrivalSecs || 0) - (leg.departureSecs || 0));
    }
  }
  return secs;
}

function walkStats(journey) {
  const secs = totalWalkSecs(journey);
  const minutes = secs / 60;
  const meters = Math.round(minutes * WALK_SPEED_M_PER_MIN);
  const steps = Math.round(meters / STRIDE_M);
  const kcal = Math.round(WALK_MET * BODY_WEIGHT_KG * (secs / 3600));
  return { secs, minutes: Math.round(minutes), meters, steps, kcal };
}

function transitLegCount(journey) {
  return (journey.legs || []).filter((l) => l.kind === "transit").length;
}

// 経路の同一判定用シグネチャ (発車時刻は含めず「経路の形」で判定)
// → 同じ路線構成の発車時刻違いは1件にまとめ、最速のものを残す
function signature(journey) {
  const legs = (journey.legs || [])
    .map((l) => (l.kind === "transit" ? l.routeName : "walk"))
    .join(">");
  return `${journey.transferCount}|${legs}`;
}

// 秒(サービス日0時起点) → HH:MM 表示
function hhmm(secs) {
  if (secs == null) return "--:--";
  let s = ((secs % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function durText(secs) {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}分`;
  return `${Math.floor(m / 60)}時間${m % 60}分`;
}

// ---- 回り道探索のメイン ----------------------------------------------

async function findDetours(from, to, budgetMin) {
  // 1. 最短(最速)
  const baseResp = await planJourney({ from, to, numItineraries: 1 });
  const base = (baseResp.journeys || [])[0];
  if (!base) throw new Error("最短経路が見つかりませんでした。地点を変えてお試しください。");

  const T0 = base.durationSecs;
  const F0 = fareValue(base);

  // 2 & 3. 候補収集 (複数経路 + 鉄道回避)
  const [altRes, busRes] = await Promise.allSettled([
    planJourney({ from, to, numItineraries: MAX_ITINERARIES }),
    planJourney({ from, to, avoidModes: "rail,subway", numItineraries: 3 }),
  ]);

  const pool = [base];
  if (altRes.status === "fulfilled") pool.push(...(altRes.value.journeys || []));
  if (busRes.status === "fulfilled") pool.push(...(busRes.value.journeys || []));

  // 重複排除 (同じ経路の形は最速のものだけ残す)
  const bySig = new Map();
  for (const j of pool) {
    const sig = signature(j);
    const prev = bySig.get(sig);
    if (!prev || j.durationSecs < prev.durationSecs) bySig.set(sig, j);
  }

  // メトリクス付与
  const budgetSecs = budgetMin * 60;
  const candidates = [];
  for (const j of bySig.values()) {
    const dt = j.durationSecs - T0;
    const fare = fareValue(j);
    const dfare = fare != null && F0 != null ? fare - F0 : null;
    candidates.push({
      journey: j,
      durationSecs: j.durationSecs,
      deltaSecs: dt,
      fare,
      deltaFare: dfare,
      walk: walkStats(j),
      transfers: j.transferCount,
      transitCount: transitLegCount(j),
      sig: signature(j),
    });
  }

  const baseSig = signature(base);

  // 回り道 = 許容追加時間内の別経路 (基準そのものは除外)。
  // 同時間でより安い経路も拾えるよう deltaSecs >= 0 を許容。
  const detours = candidates
    .filter((c) => c.sig !== baseSig)
    .filter((c) => c.deltaSecs >= 0 && c.deltaSecs <= budgetSecs)
    .sort((a, b) => {
      // 運賃が安い順 → 同点なら追加時間が短い順
      const fa = a.deltaFare == null ? Infinity : a.deltaFare;
      const fb = b.deltaFare == null ? Infinity : b.deltaFare;
      if (fa !== fb) return fa - fb;
      return a.deltaSecs - b.deltaSecs;
    });

  const baseCand = candidates.find((c) => c.sig === baseSig);
  return { baseCand, detours, F0, meta: baseResp };
}

// ---- レンダリング -----------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderLegs(journey) {
  const ul = el("ul", "legs");
  // アクセス徒歩
  if (journey.accessWalkSecs) {
    ul.appendChild(legRow("walk", "出発地から徒歩", `約${Math.round(journey.accessWalkSecs / 60)}分`));
  }
  for (const leg of journey.legs || []) {
    if (leg.kind === "transit") {
      const line = leg.routeName || "(路線)";
      const detail = `${leg.from?.name ?? ""} ${hhmm(leg.departureSecs)} → ${leg.to?.name ?? ""} ${hhmm(leg.arrivalSecs)}`;
      ul.appendChild(legRow("transit", line, detail));
    } else {
      const mins = Math.round((leg.arrivalSecs - leg.departureSecs) / 60);
      const detail = `${leg.from?.name ?? ""} → ${leg.to?.name ?? ""}`;
      ul.appendChild(legRow("walk", `徒歩 約${mins}分`, detail));
    }
  }
  if (journey.egressWalkSecs) {
    ul.appendChild(legRow("walk", "目的地まで徒歩", `約${Math.round(journey.egressWalkSecs / 60)}分`));
  }
  return ul;
}

function legRow(kind, line, detail) {
  const li = el("li", `leg-${kind}`);
  li.appendChild(el("span", "dot"));
  const wrap = el("div");
  wrap.appendChild(el("span", "leg-line", line));
  if (detail) {
    wrap.appendChild(document.createTextNode(" "));
    wrap.appendChild(el("span", "leg-detail", detail));
  }
  li.appendChild(wrap);
  return li;
}

function fareBadge(fare, deltaFare) {
  if (fare == null) {
    return badge("unknown", "運賃データなし");
  }
  if (deltaFare == null) {
    return badge("unknown", `運賃 ${fare}円 (比較不可)`);
  }
  if (deltaFare < 0) return badge("save", `運賃 ${Math.abs(deltaFare)}円 節約`);
  if (deltaFare > 0) return badge("add", `運賃 +${deltaFare}円`);
  return badge("save", "運賃 同額");
}

function badge(cls, text) {
  return el("span", `badge ${cls}`, text);
}

function walkBadge(walk) {
  return badge("walk", `徒歩 約${walk.minutes}分 / 約${walk.meters}m / 約${walk.steps}歩 / 約${walk.kcal}kcal`);
}

function renderBaseline(baseCand) {
  const box = document.getElementById("baseline");
  box.innerHTML = "";
  box.appendChild(el("div", "baseline-label", "最短経路（基準）"));
  const head = el("div", "card-head");
  head.appendChild(el("span", "card-time", durText(baseCand.durationSecs)));
  head.appendChild(
    el("span", "card-sub", `${hhmm(baseCand.journey.departureSecs)} → ${hhmm(baseCand.journey.arrivalSecs)} ・ 乗換${baseCand.transfers}回`)
  );
  box.appendChild(head);
  const badges = el("div", "badges");
  badges.appendChild(baseCand.fare != null ? badge("unknown", `運賃 ${baseCand.fare}円`) : badge("unknown", "運賃データなし"));
  badges.appendChild(walkBadge(baseCand.walk));
  box.appendChild(badges);
  box.appendChild(renderLegs(baseCand.journey));
}

function renderCandidates(detours) {
  const box = document.getElementById("candidates");
  box.innerHTML = "";
  if (!detours.length) {
    box.appendChild(el("p", "empty", "許容時間内の回り道候補は見つかりませんでした。追加時間を増やしてみてください。"));
    return;
  }
  for (const c of detours) {
    const card = el("div", "card");
    const head = el("div", "card-head");
    head.appendChild(el("span", "card-time", durText(c.durationSecs)));
    head.appendChild(
      el("span", "card-sub", `${hhmm(c.journey.departureSecs)} → ${hhmm(c.journey.arrivalSecs)} ・ 乗換${c.transfers}回`)
    );
    card.appendChild(head);

    const badges = el("div", "badges");
    const dtMin = Math.round(c.deltaSecs / 60);
    badges.appendChild(badge(dtMin === 0 ? "time zero" : "time", `+${dtMin}分`));
    badges.appendChild(fareBadge(c.fare, c.deltaFare));
    badges.appendChild(walkBadge(c.walk));
    card.appendChild(badges);

    card.appendChild(renderLegs(c.journey));
    box.appendChild(card);
  }
}

// ---- ステータス表示 ---------------------------------------------------

function showStatus(message, type) {
  const s = document.getElementById("status");
  s.className = "status" + (type ? " " + type : "");
  s.textContent = message;
  s.hidden = false;
}
function hideStatus() {
  document.getElementById("status").hidden = true;
}

// ---- オートコンプリート設定 ------------------------------------------

function setupAutocomplete(inputId, listId, onSelect) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let selected = null;
  let timer = null;

  input.addEventListener("input", () => {
    selected = null;
    onSelect(null);
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 1) {
      list.hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      try {
        const items = await suggest(q);
        list.innerHTML = "";
        if (!items.length) {
          list.hidden = true;
          return;
        }
        for (const item of items.slice(0, 10)) {
          const li = el("li");
          li.appendChild(el("span", "name", item.label));
          li.appendChild(el("span", "meta", item.meta));
          li.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            input.value = item.label;
            selected = item;
            onSelect(item);
            list.hidden = true;
          });
          list.appendChild(li);
        }
        list.hidden = false;
      } catch (e) {
        list.hidden = true;
      }
    }, 200);
  });

  input.addEventListener("blur", () => {
    setTimeout(() => (list.hidden = true), 150);
  });

  return () => selected;
}

// ---- 起動 -------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  let fromSel = null;
  let toSel = null;

  setupAutocomplete("from-input", "from-suggestions", (s) => (fromSel = s));
  setupAutocomplete("to-input", "to-suggestions", (s) => (toSel = s));

  const budget = document.getElementById("budget-input");
  const budgetOut = document.getElementById("budget-output");
  budget.addEventListener("input", () => (budgetOut.textContent = budget.value));

  document.getElementById("search-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById("search-btn");

    // 入力解決: サジェスト選択値を優先。未選択ならテキストをそのままサジェスト先頭で解決。
    const from = await resolveInput("from-input", fromSel);
    const to = await resolveInput("to-input", toSel);
    if (!from || !to) {
      showStatus("出発地・目的地を候補から選択してください。", "error");
      return;
    }

    btn.disabled = true;
    showStatus("回り道を探しています…", "loading");
    document.getElementById("results").hidden = true;
    try {
      const budgetMin = parseInt(budget.value, 10);
      const { baseCand, detours } = await findDetours(from, to, budgetMin);
      hideStatus();
      renderBaseline(baseCand);
      renderCandidates(detours);
      document.getElementById("results").hidden = false;
    } catch (e) {
      showStatus("検索に失敗しました: " + e.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
});

// テキストのみ入力された場合のフォールバック解決
async function resolveInput(inputId, selected) {
  if (selected && selected.value) return selected.value;
  const q = document.getElementById(inputId).value.trim();
  if (!q) return null;
  try {
    const items = await suggest(q);
    return items.length ? items[0].value : null;
  } catch {
    return null;
  }
}
