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

// 純粋な徒歩経路を引くために避ける交通モード
const WALK_ONLY_AVOID = "rail,subway,bus,tram,ferry,monorail,funicular";

// 「乗車 → 徒歩」の合成経路を1件つくる。
//   from → alight(駅) を通常検索(運賃が取れる区間まで乗車)し、
//   alight → to を徒歩のみで検索して末尾につなぐ。
async function composeRideThenWalk(from, to, alight, droppedTrains) {
  const [rideRes, walkRes] = await Promise.allSettled([
    planJourney({ from, to: alight.id, numItineraries: 1 }),
    planJourney({ from: alight.id, to, avoidModes: WALK_ONLY_AVOID, numItineraries: 1 }),
  ]);
  if (rideRes.status !== "fulfilled" || walkRes.status !== "fulfilled") return null;

  const ride = (rideRes.value.journeys || [])[0];
  const walk = (walkRes.value.journeys || [])[0];
  if (!ride || !walk) return null;

  const walkLegs = walk.legs || [];
  // 徒歩のみで到達できない(=途中で鉄道が混ざる)場合は対象外
  if (!walkLegs.length || walkLegs.some((l) => l.kind !== "walk")) return null;

  // 徒歩区間の時刻を、乗車の到着時刻に接続するようオフセット
  const offset = ride.arrivalSecs - walkLegs[0].departureSecs;
  const shiftedWalk = walkLegs.map((l) => ({
    ...l,
    departureSecs: l.departureSecs + offset,
    arrivalSecs: l.arrivalSecs + offset,
  }));
  const arrivalSecs = ride.arrivalSecs + walk.durationSecs;

  return {
    departureSecs: ride.departureSecs,
    arrivalSecs,
    durationSecs: arrivalSecs - ride.departureSecs,
    transferCount: ride.transferCount || 0,
    legs: [...(ride.legs || []), ...shiftedWalk],
    fare: ride.fare || null,
    __mawariWalkLast: {
      alightName: alight.name,
      droppedTrains,
      walkSecs: walk.durationSecs,
    },
  };
}

// 基準経路の末尾の鉄道区間を徒歩に置き換えた候補を生成する。
// → 運賃データのある区間まで乗車し、残りを歩くことで
//   「運賃が表示される」かつ「歩いて節約」を両立できる。
async function buildWalkLastLegCandidates(from, to, base) {
  const transitLegs = (base.legs || []).filter((l) => l.kind === "transit");
  // 置き換えても1区間以上の乗車が残らない場合は対象外
  if (transitLegs.length < 2) return [];

  const out = [];
  const seenAlight = new Set();
  const maxDrop = Math.min(2, transitLegs.length - 1); // 末尾1〜2区間を徒歩化
  for (let drop = 1; drop <= maxDrop; drop++) {
    const alight = transitLegs[transitLegs.length - 1 - drop].to;
    if (!alight || !alight.id || seenAlight.has(alight.id)) continue;
    seenAlight.add(alight.id);
    const droppedTrains = transitLegs
      .slice(transitLegs.length - drop)
      .map((l) => l.routeName)
      .filter(Boolean);
    try {
      const composite = await composeRideThenWalk(from, to, alight, droppedTrains);
      if (composite) out.push(composite);
    } catch {
      /* この候補だけスキップ */
    }
  }
  return out;
}

// ---- ODPT 連携 (運賃補完 + 通過駅) ------------------------------------
//   運賃データの無い区間(東武等)の実額運賃と、各乗車区間の通過駅(駅順)を
//   ODPT から取得する。キーは端末の localStorage にのみ保存する。

const ODPT_BASE = "https://api.odpt.org/api/v4";
const ODPT_KEY_LS = "mawari.odptKey";

function getOdptKey() {
  try {
    return localStorage.getItem(ODPT_KEY_LS) || "";
  } catch {
    return "";
  }
}
function setOdptKey(k) {
  try {
    if (k) localStorage.setItem(ODPT_KEY_LS, k);
    else localStorage.removeItem(ODPT_KEY_LS);
  } catch {
    /* localStorage 不可環境では何もしない */
  }
}
function hasOdptKey() {
  return !!getOdptKey();
}

async function odptGet(type, params) {
  const key = getOdptKey();
  if (!key) throw new Error("ODPTキー未設定");
  const url = new URL(`${ODPT_BASE}/${type}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  url.searchParams.set("acl:consumerKey", key);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`ODPT ${res.status}`);
  return res.json();
}

// ls8h の駅id → ODPT の駅id(odpt.Station:...) を推定。
//   メトロ/都営: "odpt-...:odpt.Station:..." → そのまま後半を使う
//   その他(東武等): "tokyo-tobu-rail:Tobu.TobuSkytree.Hikifune" → "odpt.Station:Tobu.TobuSkytree.Hikifune"
function toOdptStationId(ls8hId) {
  if (!ls8hId) return null;
  const i = ls8hId.indexOf(":");
  const local = i >= 0 ? ls8hId.slice(i + 1) : ls8hId;
  if (local.startsWith("odpt.Station:")) return local;
  if (/^[A-Za-z0-9]+\.[A-Za-z0-9]+\.[A-Za-z0-9]+/.test(local)) return "odpt.Station:" + local;
  return null;
}
function odptOperatorOfStation(odptStationId) {
  const body = odptStationId.replace(/^odpt\.Station:/, "");
  return "odpt.Operator:" + body.split(".")[0];
}
function odptRailwayOfStation(odptStationId) {
  const body = odptStationId.replace(/^odpt\.Station:/, "");
  const parts = body.split(".");
  if (parts.length < 3) return null;
  return "odpt.Railway:" + parts.slice(0, 2).join(".");
}
function shortStationName(odptStationId) {
  return odptStationId.split(".").pop();
}

// 路線の駅順(通過駅含む) を取得してキャッシュ。失敗時は null。
const _railwayCache = new Map();
async function fetchRailwayStations(odptStationId) {
  const railway = odptRailwayOfStation(odptStationId);
  if (!railway) return null;
  if (_railwayCache.has(railway)) return _railwayCache.get(railway);
  let result = null;
  try {
    const [rwArr, staArr] = await Promise.all([
      odptGet("odpt:Railway", { "owl:sameAs": railway }),
      odptGet("odpt:Station", { "odpt:railway": railway }),
    ]);
    const rw = (rwArr || [])[0];
    const order = ((rw && rw["odpt:stationOrder"]) || [])
      .map((o) => ({ id: o["odpt:station"], index: o["odpt:index"] }))
      .sort((a, b) => a.index - b.index);
    const infoMap = {};
    for (const s of staArr || []) {
      const t = s["dc:title"] || (s["odpt:stationTitle"] && s["odpt:stationTitle"].ja);
      if (s["owl:sameAs"]) {
        infoMap[s["owl:sameAs"]] = {
          name: t || shortStationName(s["owl:sameAs"]),
          lat: s["geo:lat"],
          lon: s["geo:long"],
        };
      }
    }
    result = order.map((o) => {
      const info = infoMap[o.id] || {};
      return { id: o.id, name: info.name || shortStationName(o.id), lat: info.lat, lon: info.lon };
    });
    if (!result.length) result = null;
  } catch {
    result = null;
  }
  _railwayCache.set(railway, result);
  return result;
}

// 1乗車レッグの [乗車駅 … 通過駅 … 降車駅] を順序付きで返す(ls8h leg)。
async function legStationSequence(leg) {
  const boardOdpt = toOdptStationId(leg.from && leg.from.id);
  const alightOdpt = toOdptStationId(leg.to && leg.to.id);
  if (!boardOdpt || !alightOdpt) return null;
  const stations = await fetchRailwayStations(boardOdpt);
  if (!stations) return null;
  const bi = stations.findIndex((s) => s.id === boardOdpt);
  const ai = stations.findIndex((s) => s.id === alightOdpt);
  if (bi < 0 || ai < 0) return null;
  const slice = bi <= ai ? stations.slice(bi, ai + 1) : stations.slice(ai, bi + 1).reverse();
  return slice; // [{id(odpt), name}], 乗車→降車の順
}

// ODPT 実額運賃 (fromStation→toStation)。IC優先。
async function odptFare(fromOdpt, toOdpt) {
  try {
    const arr = await odptGet("odpt:RailwayFare", {
      "odpt:operator": odptOperatorOfStation(fromOdpt),
      "odpt:fromStation": fromOdpt,
      "odpt:toStation": toOdpt,
    });
    const f = (arr || [])[0];
    if (!f) return null;
    const ic = f["odpt:icCardFare"];
    const ticket = f["odpt:ticketFare"];
    return typeof ic === "number" ? ic : typeof ticket === "number" ? ticket : null;
  } catch {
    return null;
  }
}

// 経路全体の運賃を可能な限り埋める。
//   直接運賃があればそれを使う。無ければ ODPT で事業者連続区間ごとに合算。
//   { amount, complete } を返す。complete=false は一部不明(下限値)。
async function fareFilled(journey) {
  const direct = fareValue(journey);
  if (direct != null) return { amount: direct, complete: true };
  if (!hasOdptKey()) return { amount: null, complete: false };

  const transit = (journey.legs || []).filter((l) => l.kind === "transit");
  if (!transit.length) return { amount: null, complete: false };

  // 事業者が連続する区間でグループ化
  const groups = [];
  for (const leg of transit) {
    const fromO = toOdptStationId(leg.from && leg.from.id);
    const toO = toOdptStationId(leg.to && leg.to.id);
    const op = fromO ? odptOperatorOfStation(fromO) : null;
    const last = groups[groups.length - 1];
    if (last && last.op === op && fromO && last.toO === toO) continue; // 同一は稀
    if (last && last.op === op) {
      last.toO = toO; // 同事業者の続きは降車だけ伸ばす
    } else {
      groups.push({ op, fromO, toO });
    }
  }

  let sum = 0;
  let complete = true;
  for (const g of groups) {
    if (!g.fromO || !g.toO) {
      complete = false;
      continue;
    }
    const fare = await odptFare(g.fromO, g.toO);
    if (fare == null) complete = false;
    else sum += fare;
  }
  return { amount: complete || sum > 0 ? sum : null, complete };
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

// 並び替え用の運賃キー。値が小さいほど上位。
function fareSortKey(c, F0) {
  if (c.deltaFare != null) return c.deltaFare; // 基準と比較できる → 差額順
  if (c.fare != null && F0 == null) return -1e6 + c.fare; // 基準不明だが運賃判明 → 最優先
  return Infinity; // 運賃不明
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

  // 4. 末尾の鉄道区間を徒歩に置き換えた候補(例: 押上で降りて曳舟まで歩く)
  try {
    pool.push(...(await buildWalkLastLegCandidates(from, to, base)));
  } catch {
    /* 徒歩置換候補が作れなくても他候補は出す */
  }

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
      // 運賃が安い順 → 同点なら追加時間が短い順。
      // 基準の運賃が不明なときは、運賃が判明している候補(=徒歩置換で
      // 運賃の取れる区間まで乗車した候補など)を先頭に出す。
      const fa = fareSortKey(a, F0);
      const fb = fareSortKey(b, F0);
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

function normHexColor(c) {
  if (!c) return null;
  const h = String(c).replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(h) ? "#" + h : null;
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
      ul.appendChild(legRow("transit", line, detail, normHexColor(leg.color)));
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

function legRow(kind, line, detail, color) {
  const li = el("li", `leg-${kind}`);
  const dot = el("span", "dot");
  if (kind === "transit" && color) {
    li.style.borderLeftColor = color;
    dot.style.background = color;
  }
  li.appendChild(dot);
  const wrap = el("div");
  const lineEl = el("span", "leg-line", line);
  if (kind === "transit" && color) lineEl.style.color = color;
  wrap.appendChild(lineEl);
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

function fareText(info) {
  if (!info || info.amount == null) return null;
  return info.complete ? `運賃 ${info.amount}円` : `運賃 概算 ${info.amount}円〜`;
}

async function renderBaseline(baseCand, ctx) {
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
  const fareInfo = await fareFilled(baseCand.journey);
  ctx.baseFareInfo = fareInfo;
  const ft = fareText(fareInfo);
  badges.appendChild(
    ft ? badge(fareInfo.complete ? "unknown" : "save", ft) : badge("unknown", "運賃データなし")
  );
  badges.appendChild(walkBadge(baseCand.walk));
  box.appendChild(badges);
  box.appendChild(renderLegs(baseCand.journey));

  // 通過駅スライダー(途中下車して歩く)をマウント
  const slot = el("div", "alight-slot");
  box.appendChild(slot);
  mountInteractiveAlight(slot, ctx).catch(() => {});
}

// ---- インタラクティブ「降りて歩く」 ----------------------------------
// 経路が通過する駅を一列に並べ、スライダーで降車駅を選ぶと、
// そこから目的地までを徒歩で補完して再検索し、運賃・割引を更新する。

async function buildPassedStations(base) {
  const transit = (base.legs || []).filter((l) => l.kind === "transit");
  const passed = [];
  for (const leg of transit) {
    const seq = await legStationSequence(leg);
    if (!seq) return null; // 1区間でも駅順が取れなければ不可
    for (const s of seq) {
      const prev = passed[passed.length - 1];
      // 乗換駅の重複を除去 (id一致 or 同名の連続)
      if (prev && (prev.id === s.id || prev.name === s.name)) continue;
      passed.push(s);
    }
  }
  return passed.length >= 2 ? passed : null;
}

async function mountInteractiveAlight(slot, ctx) {
  slot.innerHTML = "";
  if (!hasOdptKey()) {
    slot.appendChild(
      el("p", "alight-hint", "🔧 「運賃・通過駅の設定」で ODPT キーを入れると、通過駅で降りて歩く調整ができます。")
    );
    return;
  }
  slot.appendChild(el("p", "alight-loading", "通過駅を取得中…"));
  let passed;
  try {
    passed = await buildPassedStations(ctx.base);
  } catch {
    passed = null;
  }
  slot.innerHTML = "";
  if (!passed) {
    slot.appendChild(
      el("p", "alight-hint", "この経路の通過駅は ODPT から取得できませんでした（JR・一部私鉄など未対応の場合があります）。")
    );
    return;
  }
  ctx.passed = passed;

  const panel = el("div", "alight-panel");
  panel.appendChild(el("div", "alight-title", "🚶 どこで降りて歩く？"));

  // 駅の並び(乗車→…→降車)。最終駅=元の降車。途中を選ぶと残りを徒歩化。
  const labels = el("div", "alight-stations");
  passed.forEach((s, i) => {
    const chip = el("span", "alight-chip", s.name);
    chip.dataset.idx = String(i);
    labels.appendChild(chip);
  });
  panel.appendChild(labels);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "1";
  slider.max = String(passed.length - 1);
  slider.value = String(passed.length - 1);
  slider.className = "alight-range";
  panel.appendChild(slider);

  const out = el("div", "alight-result");
  panel.appendChild(out);
  slot.appendChild(panel);

  const highlight = (idx) => {
    for (const chip of labels.children) {
      const i = Number(chip.dataset.idx);
      chip.classList.toggle("active", i === idx);
      chip.classList.toggle("ride", i <= idx);
      chip.classList.toggle("walk", i > idx);
    }
  };

  let timer = null;
  let token = 0;
  const onChange = () => {
    const idx = Number(slider.value);
    highlight(idx);
    clearTimeout(timer);
    if (idx >= passed.length - 1) {
      out.innerHTML = "";
      out.appendChild(el("p", "alight-note", "最後まで乗車（基準どおり）。スライダーを左に動かすと手前で降りて歩きます。"));
      return;
    }
    out.innerHTML = "";
    out.appendChild(el("p", "alight-loading", "再検索中…"));
    const my = ++token;
    timer = setTimeout(() => recomputeAlight(ctx, idx, out, my, () => token), 250);
  };
  slider.addEventListener("input", onChange);
  highlight(passed.length - 1);
}

async function recomputeAlight(ctx, idx, out, my, currentToken) {
  const station = ctx.passed[idx];
  if (station.lat == null || station.lon == null) {
    out.innerHTML = "";
    out.appendChild(el("p", "alight-hint", `${station.name} の座標が取得できず、再検索できませんでした。`));
    return;
  }
  const geo = `geo:${station.lat},${station.lon}`;
  try {
    const [rideRes, walkRes] = await Promise.allSettled([
      planJourney({ from: ctx.from, to: geo, numItineraries: 1 }),
      planJourney({ from: geo, to: ctx.to, avoidModes: WALK_ONLY_AVOID, numItineraries: 1 }),
    ]);
    if (my !== currentToken()) return; // 古い結果は破棄
    const ride = rideRes.status === "fulfilled" ? (rideRes.value.journeys || [])[0] : null;
    const walk = walkRes.status === "fulfilled" ? (walkRes.value.journeys || [])[0] : null;
    if (!ride || !walk || (walk.legs || []).some((l) => l.kind !== "walk")) {
      out.innerHTML = "";
      out.appendChild(el("p", "alight-hint", `${station.name} から目的地まで徒歩経路が見つかりませんでした。`));
      return;
    }

    const totalSecs = ride.durationSecs + walk.durationSecs;
    const addSecs = totalSecs - ctx.base.durationSecs;
    const walkMin = Math.round(walk.durationSecs / 60);
    const walkMeters = Math.round((walk.durationSecs / 60) * WALK_SPEED_M_PER_MIN);

    const rideFare = await fareFilled(ride);
    if (my !== currentToken()) return;

    out.innerHTML = "";
    const sum = el("div", "badges");
    sum.appendChild(badge("walklast", `🚶 ${station.name} で降りて徒歩`));
    sum.appendChild(badge(addSecs <= 0 ? "time zero" : "time", `所要 ${durText(totalSecs)}（${addSecs <= 0 ? "短縮" : "+" + Math.round(addSecs / 60) + "分"}）`));

    const ft = fareText(rideFare);
    if (ft) sum.appendChild(badge("unknown", ft));

    // 割引額 = 基準運賃 - 乗車運賃
    const baseAmt = ctx.baseFareInfo && ctx.baseFareInfo.amount;
    if (baseAmt != null && rideFare.amount != null) {
      const disc = baseAmt - rideFare.amount;
      if (disc > 0) sum.appendChild(badge("save", `割引 −${disc}円${ctx.baseFareInfo.complete && rideFare.complete ? "" : "（概算）"}`));
      else if (disc === 0) sum.appendChild(badge("unknown", "割引なし（同額）"));
    }
    sum.appendChild(badge("walk", `徒歩 約${walkMin}分 / 約${walkMeters}m`));
    out.appendChild(sum);

    const route = el("div", "alight-route");
    route.appendChild(renderLegs(ride));
    route.appendChild(el("div", "alight-walkline", `🚶 ${station.name} → 目的地（徒歩 約${walkMin}分）`));
    out.appendChild(route);
  } catch (e) {
    if (my !== currentToken()) return;
    out.innerHTML = "";
    out.appendChild(el("p", "alight-hint", "再検索に失敗しました: " + e.message));
  }
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
    const wl = c.journey.__mawariWalkLast;
    badges.appendChild(badge(dtMin === 0 ? "time zero" : "time", `+${dtMin}分`));
    if (wl && c.deltaFare == null && c.fare != null) {
      // 基準の運賃が不明でも、乗車区間の運賃は表示できる
      badges.appendChild(badge("save", `運賃 ${c.fare}円（鉄道区間のみ／歩く区間は不要）`));
    } else {
      badges.appendChild(fareBadge(c.fare, c.deltaFare));
    }
    badges.appendChild(walkBadge(c.walk));
    if (wl) {
      badges.appendChild(badge("walklast", `🚶 ${wl.alightName}で降りて徒歩`));
    }
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

  // ODPT キー入力 (localStorage に保存)
  const odptInput = document.getElementById("odpt-key");
  const odptStatus = document.getElementById("odpt-status");
  if (odptInput) {
    odptInput.value = getOdptKey();
    const reflect = () => {
      if (odptStatus) {
        odptStatus.textContent = hasOdptKey() ? "✅ キー設定済み（運賃・通過駅の補完が有効）" : "";
      }
    };
    reflect();
    odptInput.addEventListener("change", () => {
      setOdptKey(odptInput.value.trim());
      reflect();
    });
  }

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
      const ctx = { from, to, base: baseCand.journey, baseFareInfo: null };
      renderCandidates(detours);
      document.getElementById("results").hidden = false;
      await renderBaseline(baseCand, ctx);
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
