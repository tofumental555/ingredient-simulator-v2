/* =====================================================================
 * calc.js — 食材シミュレーター（index.html）とエナジー最適化ツール（optimizer.html）の共通部分
 *
 *  ・ポケモン1匹の基本性能（お手伝い時間・食材確率・スキル確率・食材スロット・最大所持数・きのみの数）
 *  ・保存ポケモンの検証・読み書き（localStorage）。2つのツールは同じ保存データを使う
 *  ・ミュウの食材／メインスキルの差し替え
 *
 *  式を直すときは、このファイルだけを直せば、両方のツールに反映されます。
 * ===================================================================== */
(function (root) {
  "use strict";
  const PKS = {};

  /* ---------- 定数 ---------- */
  PKS.SUB_SKILLS   = ["その他","きのみの数S","おてスピM","おてスピS","おてぼ","食材確率M","食材確率S","スキル確率M","スキル確率S","最大所持数アップS","最大所持数アップM","最大所持数アップL"];
  PKS.PATTERNS     = ["aaa","aab","aac","aba","abb","abc"];
  PKS.NATURES_UP   = [["other","その他（補正なし）"],["speedUp","おてスピ↑"],["foodUp","食材確率↑"],["skillUp","スキル確率↑"]];
  PKS.NATURES_DOWN = [["other","その他（補正なし）"],["speedDown","おてスピ↓"],["foodDown","食材確率↓"],["skillDown","スキル確率↓"]];
  PKS.SUB_IDS      = ["sub10","sub25","sub50","sub70","sub80"];
  PKS.SUB_LABELS   = ["Lv10","Lv25","Lv50","Lv70","Lv80"];
  PKS.SUB_UNLOCK   = [10, 25, 50, 70, 80];
  PKS.WEEK_SECONDS = 7 * 86400;
  PKS.LEVEL_TIME_COEF = 0.002;
  PKS.GENKI_TOP_MULT = 0.45;                          // げんき81以上のお手伝い時間の倍率
  PKS.CAMP = { speed: 1.2, inventory: 1.2 };          // いいキャンプチケット：お手伝いスピード・最大所持数
  PKS.MEW_NAMES = ["ミュウ"];
  PKS.SAVED_KEY = "pks_ing_sim_saved_pokemon_v1";
  PKS.SAVED_MAX = 200;

  /* ---------- 小物 ---------- */
  PKS.esc = function (s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  };
  PKS.newSavedId = function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  };

  /* ---------- 保存ポケモン ---------- */
  // 保存・読み込み時の値検証（不正なJSONが混ざっても壊れないようにする）。
  // sl=スキルレベル、sk=ミュウのメインスキル、mi=ミュウの食材（3枠）。知らない項目は消えないよう、ここで通す
  PKS.sanitizeSaved = function (raw) {
    if (!raw || typeof raw !== "object") return null;
    const p = String(raw.p ?? "").trim().slice(0, 60);
    if (!p) return null;
    let lv = Math.round(Number(raw.lv));
    if (!Number.isFinite(lv)) lv = 50;
    lv = Math.min(100, Math.max(1, lv));
    const pat = PKS.PATTERNS.includes(raw.pat) ? raw.pat : "aab";
    const nu = PKS.NATURES_UP.some(([v]) => v === raw.nu) ? raw.nu : "other";
    const nd = PKS.NATURES_DOWN.some(([v]) => v === raw.nd) ? raw.nd : "other";
    const subsIn = Array.isArray(raw.subs) ? raw.subs : [];
    const subs = PKS.SUB_IDS.map((_, i) => PKS.SUB_SKILLS.includes(subsIn[i]) ? subsIn[i] : "その他");
    const label = String(raw.label ?? "").trim().slice(0, 40) || `${p} Lv${lv}`;
    const id = (typeof raw.id === "string" && /^[a-z0-9]{4,24}$/i.test(raw.id)) ? raw.id : PKS.newSavedId();
    let sl = Math.round(Number(raw.sl));
    if (!Number.isFinite(sl)) sl = 6;
    sl = Math.min(7, Math.max(1, sl));
    const sk = typeof raw.sk === "string" ? raw.sk.trim().slice(0, 40) : "";
    const mi = Array.isArray(raw.mi) ? [0, 1, 2].map(i => String(raw.mi[i] ?? "").trim().slice(0, 20)) : [];
    const out = { id, label, p, lv, pat, nu, nd, subs, sl };
    if (sk) out.sk = sk;
    if (mi.some(Boolean)) out.mi = mi;
    return out;
  };
  PKS.sameContent = function (a, b) {
    return a.p === b.p && a.lv === b.lv && a.pat === b.pat && a.nu === b.nu && a.nd === b.nd && a.sl === b.sl
      && (a.sk || "") === (b.sk || "") && (a.mi || []).join("|") === (b.mi || []).join("|")
      && a.subs.join("|") === b.subs.join("|");
  };
  PKS.uniqueLabel = function (list, base) {
    let label = base, n = 2;
    while (list.some(s => s.label === label)) label = `${base} (${n++})`;
    return label;
  };
  PKS.loadSaved = function () {
    try {
      const raw = root.localStorage.getItem(PKS.SAVED_KEY);
      if (!raw) return { list: [], ok: true };
      const arr = JSON.parse(raw);
      return { list: (Array.isArray(arr) ? arr : []).map(PKS.sanitizeSaved).filter(Boolean).slice(0, PKS.SAVED_MAX), ok: true };
    } catch (e) {
      console.warn("保存データの読み込みに失敗:", e);
      return { list: [], ok: false };
    }
  };
  PKS.persistSaved = function (list) {
    try { root.localStorage.setItem(PKS.SAVED_KEY, JSON.stringify(list)); return true; }
    catch (e) { console.warn("保存データの書き込みに失敗:", e); return false; }
  };

  /* ---------- ミュウ：選んだ食材・メインスキルに差し替える ---------- */
  // 返り値：{ pokemon: 差し替え後のポケモンデータ, saved: 食材の並び(pat)を直した保存データ }
  PKS.resolvePokemon = function (pokemon, saved) {
    if (pokemon.mewIngredients || pokemon.mewSkills) {
      const ov = {};
      const pools = pokemon.mewIngredients;
      if (pools && saved.mi && saved.mi.some(Boolean)) {
        const pick = i => (saved.mi[i] && pools[i] && pools[i][saved.mi[i]] != null) ? saved.mi[i] : null;
        const m0 = pick(0), m1 = pick(1), m2 = pick(2);
        if (m0) { ov.ingredientA = m0; ov["1a"] = pools[0][m0]; }
        if (m1) { ov.ingredientB = m1; ov["2b"] = pools[1][m1]; }
        if (m2) { ov.ingredientC = m2; ov["3c"] = pools[2][m2]; }
        saved = Object.assign({}, saved, { pat: "a" + (m1 ? "b" : "a") + (m2 ? "c" : "a") });   // 1・2・3枠目をそれぞれ別の食材として扱う
      }
      const skName = saved.sk || pokemon.skillType;
      if (saved.sk) ov.skillType = saved.sk;
      if (pokemon.mewSkills && Object.prototype.hasOwnProperty.call(pokemon.mewSkills, skName)) ov.skillRate = pokemon.mewSkills[skName];   // ミュウは、スキルごとに発動確率が違う
      pokemon = Object.assign({}, pokemon, ov);
    } else if (saved.sk) {
      pokemon = Object.assign({}, pokemon, { skillType: saved.sk });
    }
    return { pokemon, saved };
  };

  /* ---------- ポケモン1匹の基本性能 ----------
   * pokemon: pokemon_data.json の1件（ミュウは resolvePokemon を通した後のもの）
   * saved  : { lv, pat, nu, nd, subs }
   * opt    : { camp, campSpeed, campInv, timeMult, ingPlus, invPlus, skillRateMult, extraPerHelp }
   *          camp=いいキャンプチケット使用／timeMult=お手伝い時間の倍率（EXなど）／ingPlus=食材獲得数の追加
   *          invPlus=最大所持数の追加／skillRateMult=スキル確率の倍率／extraPerHelp=1回のお手伝いで追加で拾う食材数
   * 返り値：baseTime=げんき・おてスピ補正前のお手伝い時間（秒）。実際の間隔=baseTime×(1−おてスピ)×げんき倍率
   */
  PKS.pokemonStats = function (pokemon, saved, opt) {
    opt = opt || {};
    const level = saved.lv, subs = saved.subs, pattern = saved.pat;
    const act = subs.filter((_, i) => level >= PKS.SUB_UNLOCK[i]);
    const cnt = s => act.filter(x => x === s).length;

    // お手伝い時間
    let tf = 1.0;
    if (saved.nu === "speedUp") tf *= 0.9;
    if (saved.nd === "speedDown") tf *= 1.075;
    const levelCoef = 1 - (level - 1) * PKS.LEVEL_TIME_COEF;
    const campCoef = opt.camp ? (1 / (opt.campSpeed || PKS.CAMP.speed)) : 1.0;
    const baseTime = pokemon.helpTime * levelCoef * tf * campCoef * (opt.timeMult ?? 1);
    const ownSpeed = cnt("おてスピM") * 0.14 + cnt("おてスピS") * 0.07;
    const otebo = cnt("おてぼ") * 0.05;

    // 食材確率（基礎×(1＋サブスキル加算)×性格）
    let fr = (pokemon.ingredientFindRate ?? 0) / 100;
    fr *= (1 + 0.36 * cnt("食材確率M") + 0.18 * cnt("食材確率S"));
    if (saved.nu === "foodUp") fr *= 1.2;
    if (saved.nd === "foodDown") fr *= 0.8;
    fr = Math.max(0, Math.min(1, fr));

    // スキル確率
    let skillRate = (pokemon.skillRate ?? 0) / 100;
    skillRate *= (1 + 0.36 * cnt("スキル確率M") + 0.18 * cnt("スキル確率S"));
    if (saved.nu === "skillUp") skillRate *= 1.1;
    if (saved.nd === "skillDown") skillRate *= 0.9;
    skillRate = Math.max(0, skillRate * (opt.skillRateMult ?? 1));

    // 食材スロット（Lv30で2枠目、Lv60で3枠目が解放）。sp=スロットの配分（解放済みの枠で等分）
    const slots = level < 30 ? [1] : level < 60 ? [1, 2] : [1, 2, 3];
    const sp = 1 / slots.length;
    const slotIng = [];
    const ingList = [];
    let avgIng = 0;
    const ingPlus = opt.ingPlus || 0;
    for (const slot of slots) {
      let ing = null, c = 0;
      if (slot === 1) { ing = pokemon.ingredientA; c = pokemon["1a"] ?? 0; }
      else if (slot === 2) {
        const t = pattern[1];
        ing = t === "a" ? pokemon.ingredientA : pokemon.ingredientB;
        c = t === "a" ? (pokemon["2a"] ?? 0) : (pokemon["2b"] ?? 0);
      } else {
        const t = pattern[2];
        if (t === "a") { ing = pokemon.ingredientA; c = pokemon["3a"] ?? 0; }
        else if (t === "b") { ing = pokemon.ingredientB; c = pokemon["3b"] ?? 0; }
        else { ing = pokemon.ingredientC; c = pokemon["3c"] ?? 0; }
      }
      if (ing && c > 0) c += ingPlus;
      if (ing && c > 0) {
        slotIng.push({ slot, ing, cnt: c, sp });
        ingList.push([ing, c * sp]);
        avgIng += c * sp;
      }
    }

    // きのみの数・最大所持数・満タンまでのお手伝い回数
    const bp = (pokemon.berryCount ?? (pokemon.category === "きのみ" ? 2 : 1)) + cnt("きのみの数S");   // berryCount：きのみの数を個別に指定するポケモン（ミュウなど）
    const invMult = opt.camp ? (opt.campInv || PKS.CAMP.inventory) : 1;
    const maxInv = (pokemon.maxInventory != null)
      ? Math.round((pokemon.maxInventory + cnt("最大所持数アップS") * 6 + cnt("最大所持数アップM") * 12 + cnt("最大所持数アップL") * 18 + (opt.invPlus || 0)) * invMult) : null;
    const avgPerHelp = (1 - fr) * bp + fr * avgIng + (opt.extraPerHelp || 0);
    const helpsUntilFull = (maxInv && maxInv > 0 && avgPerHelp > 0) ? maxInv / avgPerHelp : Infinity;

    return { level, cnt, baseTime, ownSpeed, otebo, fr, skillRate, slotIng, ingList, avgIng, bp, maxInv, avgPerHelp, helpsUntilFull };
  };

  if (typeof module !== "undefined" && module.exports) module.exports = PKS;
  else root.PKS = PKS;
})(typeof window !== "undefined" ? window : globalThis);
