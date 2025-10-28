// ==UserScript==
// @name         宗教答题测试助手（v1.2.1，含模糊匹配 & 多选逐点点击修复）
// @namespace    https://example.com/userscripts
// @version      1.2.1
// @description  对照本地/远程题库，自动匹配并勾选【单选】与【多选】题；更强规范化与模糊匹配，尽量避免改题库；修复多选仅勾选最后一个的问题（逐点原生 click + 延时）；统计未命中/不一致并提供调试工具。
// @author       GuZhi_223 & ChatGPT
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /** ================= 偏好设置（可在菜单里动态修改） ================= */
  const PREFS = {
    autoAnswer: GM_getValue("autoAnswer", true),
    fuzzyThreshold: Number(GM_getValue("fuzzyThreshold", 0.9)), //  可调
    bankURL: GM_getValue("qaBankURL", ""),
  };

  /** ================= 工具函数 ================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 更强规范化：清空白/零宽、去【标签】、去空括号、去标点与序号
  function normalizeStem(raw) {
    if (!raw) return "";
    let s = String(raw)
      .replace(/[\s\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000\u200B]+/g, "") // 多种空白
      .replace(/【.*?】/g, "")                           // 去【单选】【多选】
      .replace(/^[\d一二三四五六七八九十百千]+[.)、．]/, "") // 去题号
      .replace(/[（(][ 　]*[)）]/g, "")                 // 去空括号
      .replace(/[“”"『』]/g, "")                        // 去引号
      .replace(/[：:。！？!?，,；;…]/g, "")             // 去常见标点
      .trim();
    s = s.replace(/^[\d\.]+/, "");
    return s;
  }

  function fireEvents(el) {
    ["pointerdown","mousedown","click","input","change"].forEach(type => {
      try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch {}
    });
  }

  function getBank() {
    try { return JSON.parse(GM_getValue("qaBank", "{}")); } catch { return {}; }
  }
  function setBank(obj) {
    GM_setValue("qaBank", JSON.stringify(obj || {}));
  }

  async function fetchRemoteBank() {
    const url = PREFS.bankURL;
    if (!url) return null;
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET", url, timeout: 15000,
        onload: (res) => { try { resolve(JSON.parse(res.responseText)); } catch { resolve(null); } },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  /** ================= UI 面板 ================= */
  const panel = (() => {
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: 999999,
      width: "340px", maxHeight: "62vh", overflow: "auto",
      background: "rgba(24,24,27,.95)", color: "#fff",
      borderRadius: "12px", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      fontSize: "13px", lineHeight: 1.5, padding: "12px 12px 8px",
      backdropFilter: "blur(6px)",
    });
    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <strong>答题测试助手</strong>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input id="autoToggle" type="checkbox" style="accent-color:#22c55e"> 自动答题
        </label>
      </div>
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center;opacity:.85">
        <div>模糊阈值</div>
        <code id="fzVal" style="background:#111827;border:1px solid #27272a;border-radius:6px;padding:1px 6px;">${PREFS.fuzzyThreshold}</code>
      </div>
      <div id="stats" style="margin-top:8px;display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
        <div style="background:#18181b;border:1px solid #27272a;border-radius:8px;padding:8px;">
          <div style="opacity:.7">命中</div><div id="hitCount" style="font-weight:700">0</div>
        </div>
        <div style="background:#18181b;border:1px solid #27272a;border-radius:8px;padding:8px;">
          <div style="opacity:.7">未命中</div><div id="missCount" style="font-weight:700">0</div>
        </div>
        <div style="background:#18181b;border:1px solid #27272a;border-radius:8px;padding:8px;">
          <div style="opacity:.7">疑似不一致</div><div id="diffCount" style="font-weight:700">0</div>
        </div>
      </div>
      <details style="margin-top:8px;">
        <summary style="cursor:pointer;opacity:.9">详情 / 命中方式</summary>
        <div id="detailList" style="margin-top:6px;display:flex;flex-direction:column;gap:6px;"></div>
      </details>
    `;
    document.documentElement.appendChild(box);
    const hitCount = box.querySelector("#hitCount");
    const missCount = box.querySelector("#missCount");
    const diffCount = box.querySelector("#diffCount");
    const detailList = box.querySelector("#detailList");
    const autoToggle = box.querySelector("#autoToggle");
    const fzVal = box.querySelector("#fzVal");

    autoToggle.checked = !!PREFS.autoAnswer;
    autoToggle.addEventListener("change", () => {
      PREFS.autoAnswer = autoToggle.checked;
      GM_setValue("autoAnswer", PREFS.autoAnswer);
    });

    return {
      addDetail(type, stem, msg) {
        const tagColor = type === "miss" ? "#fb7185" : type === "diff" ? "#f59e0b" : "#22c55e";
        const item = document.createElement("div");
        item.style.cssText = "border:1px solid #27272a;border-radius:8px;padding:8px;background:#111827;";
        item.innerHTML = `
          <div style="display:flex;gap:8px;align-items:center;">
            <span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${tagColor}"></span>
            <div style="font-weight:600;flex:1;word-break:break-all">${stem}</div>
          </div>
          <div style="opacity:.9;margin-top:6px;word-break:break-all">${msg}</div>
        `;
        detailList.appendChild(item);
      },
      setStats({ hit, miss, diff }) {
        hitCount.textContent = String(hit);
        missCount.textContent = String(miss);
        diffCount.textContent = String(diff);
      },
      refreshFuzzy() { fzVal.textContent = String(PREFS.fuzzyThreshold); },
      isAuto() { return !!PREFS.autoAnswer; },
    };
  })();

  /** ================= 菜单（导入/导出/阈值/调试） ================= */
  GM_registerMenuCommand("导入题库（JSON）", async () => {
    const text = prompt("请粘贴题库 JSON：\n格式见示例", "");
    if (!text) return;
    try {
      const data = JSON.parse(text);
      setBank(data);
      alert("题库已导入，共 " + Object.keys(data).length + " 条。");
    } catch (e) { alert("JSON 解析失败：" + e.message); }
  });

  GM_registerMenuCommand("导出题库", () => {
    const data = getBank();
    const text = JSON.stringify(data, null, 2);
    navigator.clipboard?.writeText(text);
    alert("题库已复制到剪贴板（共 " + Object.keys(data).length + " 条）。");
  });

  GM_registerMenuCommand("设置题库 URL", () => {
    const cur = PREFS.bankURL;
    const url = prompt("填写题库 JSON 的直链 URL：", cur || "https://od.lk/d/NjNfODI1MDQ2NDNf/%E9%A2%98%E5%BA%93.json");
    if (url != null) {
      PREFS.bankURL = url.trim();
      GM_setValue("qaBankURL", PREFS.bankURL);
      alert("已保存题库 URL。刷新页面以尝试拉取。");
    }
  });

  GM_registerMenuCommand("启/停自动答题", () => {
    PREFS.autoAnswer = !PREFS.autoAnswer;
    GM_setValue("autoAnswer", PREFS.autoAnswer);
    alert("自动答题已" + (PREFS.autoAnswer ? "启用" : "停用"));
    location.reload();
  });

  GM_registerMenuCommand("设置模糊阈值 (0.3~0.8)", () => {
    const v = prompt("请输入模糊匹配阈值（建议 0.4~0.7）：", String(PREFS.fuzzyThreshold));
    if (v == null) return;
    const num = Number(v);
    if (isNaN(num) || num <= 0 || num >= 1) { alert("无效的阈值"); return; }
    PREFS.fuzzyThreshold = num;
    GM_setValue("fuzzyThreshold", num);
    panel.refreshFuzzy();
    alert("已设置阈值为 " + num);
  });

  GM_registerMenuCommand("调试：复制本页规范化题干", () => {
    const singles = extractSingleQuestionBlocks().map(parseSingleBlock);
    const multis  = extractMultiQuestionBlocks().map(parseMultiBlock);
    const all = [...singles, ...multis].map(x => x.normStem).filter(Boolean);
    const text = all.join("\n");
    navigator.clipboard?.writeText(text);
    alert("已复制本页规范化题干，共 " + all.length + " 条。");
  });

  /** ================= 匹配器（含模糊） ================= */
  function tokenizeForFuzzy(s) {
    // 轻量分词：以常见虚词切分，去重（长度>1）
    return Array.from(new Set(
      s.split(/(的|是|与|和|及|于|对|在|为|把|下列|关于|哪些|那些|以下|正确|说法|内容|必须|基本|方略|治藏|新时代)/)
       .filter(x => x && x.length > 1)
    ));
  }

  function findRecordForStem(normStem, bank, threshold = 0.5) {
    if (bank[normStem]) return { key: normStem, record: bank[normStem], reason: "exact" };

    const keys = Object.keys(bank);
    if (!keys.length) return null;

    // 1) 互为包含（优先）：短键命中长题干，或反之
    let hit = keys.find(k => k && (k.includes(normStem) || normStem.includes(k)));
    if (hit) return { key: hit, record: bank[hit], reason: "inclusive" };

    // 2) Jaccard 相似度
    const stemTokens = tokenizeForFuzzy(normStem);
    let best = null, bestScore = 0;
    for (const k of keys) {
      const kt = tokenizeForFuzzy(k);
      const inter = kt.filter(t => stemTokens.includes(t)).length;
      const uni = new Set([...kt, ...stemTokens]).size || 1;
      const jacc = inter / uni;
      if (jacc > bestScore) { bestScore = jacc; best = k; }
    }
    if (best && bestScore >= threshold) {
      return { key: best, record: bank[best], reason: "fuzzy:"+bestScore.toFixed(2) };
    }
    return null;
  }

  /** ================= DOM 选择/点击 ================= */
  function pickSingleChoice(container, answerLetter) {
    const input = container.querySelector(
      'input.el-radio__original[type="radio"][value="' + answerLetter + '"]'
    );
    if (!input) return false;
    const clickTarget = input.closest("label") || input;
    clickTarget.scrollIntoView({ block: "center", behavior: "instant" });
    // 原生 click + 事件
    try { input.click(); } catch { clickTarget.click(); }
    fireEvents(clickTarget);
    (clickTarget.closest(".el-radio") || clickTarget).style.outline = "2px solid #22c55e";
    return true;
  }

  // === 修复版：多选逐点点击 + 小延时 ===
  async function pickMultiChoices(container, answerLetters) {
    const allInputs = Array.from(
      container.querySelectorAll('input.el-checkbox__original[type="checkbox"]')
    );
    if (!allInputs.length) return false;

    let changed = false;
    const need = new Set((answerLetters || []).map(x => (x || "").toUpperCase()));

    const toCheck   = allInputs.filter(i => need.has((i.value || "").toUpperCase()) && !i.checked);
    const toUncheck = allInputs.filter(i => !need.has((i.value || "").toUpperCase()) &&  i.checked);

    const clickInput = async (inp, highlight) => {
      const label = inp.closest("label") || inp;
      try { inp.click(); } catch { label.click(); }
      if (highlight) (label.closest(".el-checkbox") || label).style.outline = "2px solid #22c55e";
      await sleep(50); // 关键：等待前端框架同步（可调 40~100ms）
    };

    // 先勾选需要的
    for (const i of toCheck) {
      await clickInput(i, true);
      changed = true;
    }
    // 再取消多余的
    for (const i of toUncheck) {
      await clickInput(i, false);
      changed = true;
    }

    return changed;
  }

  /** ================= 解析器 ================= */
  function extractSingleQuestionBlocks(root = document) {
    const blocks = Array.from(root.querySelectorAll(".item-view"));
    return blocks.filter((el) => /【\s*单选\s*】/.test(el.textContent || ""));
  }

  function parseSingleBlock(block) {
    const stemNode = block.querySelector(".w-full");
    const rawStem = stemNode ? stemNode.textContent.trim() : "";
    const optionLabels = Array.from(block.querySelectorAll("label.el-radio"));
    const options = {};
    optionLabels.forEach((lab) => {
      const input = lab.querySelector('input.el-radio__original[type="radio"]');
      if (!input) return;
      const letter = (input.value || "").trim();
      const text = lab.textContent.replace(/[A-Z]\.\s*/, "").trim();
      if (letter) options[letter] = text;
    });
    return { rawStem, normStem: normalizeStem(rawStem), options, block };
  }

  function extractMultiQuestionBlocks(root = document) {
    const blocks = Array.from(root.querySelectorAll(".item-view"));
    return blocks.filter((el) => /【\s*多选\s*】/.test(el.textContent || ""));
  }

  function parseMultiBlock(block) {
    const stemNode = block.querySelector(".w-full");
    const rawStem = stemNode ? stemNode.textContent.trim() : "";
    const optionLabels = Array.from(block.querySelectorAll("label.el-checkbox"));
    const options = {};
    optionLabels.forEach((lab) => {
      const input = lab.querySelector('input.el-checkbox__original[type="checkbox"]');
      if (!input) return;
      const letter = (input.value || "").trim();
      const text = lab.textContent.replace(/[A-Z]\.\s*/, "").trim();
      if (letter) options[letter] = text;
    });
    return { rawStem, normStem: normalizeStem(rawStem), options, block };
  }

  /** ================= 主流程 ================= */
  (async function main() {
    await sleep(300);

    // 拉取并合并题库
    let bank = getBank();
    const remote = await fetchRemoteBank();
    if (remote && typeof remote === "object") bank = { ...bank, ...remote };

    let hit = 0, miss = 0, diff = 0;

    // 单选题
    for (const b of extractSingleQuestionBlocks()) {
      const parsed = parseSingleBlock(b);
      if (!parsed.normStem) continue;

      const found = findRecordForStem(parsed.normStem, bank, PREFS.fuzzyThreshold);
      if (!found) {
        miss++; panel.addDetail("miss", parsed.rawStem, "未在题库中找到（单选）。");
        b.style.outline = "2px dashed #fb7185";
        continue;
      }

      const { record, key, reason } = found;
      if (!record || record.type !== "single") {
        diff++; panel.addDetail("diff", parsed.rawStem, `题库键「${key}」类型为「${record && record.type}」，页面识别为「单选」。`);
        b.style.outline = "2px dashed #f59e0b";
        continue;
      }

      const ans = String(record.answer || "").toUpperCase();
      if (!/^[A-Z]$/.test(ans) || !(ans in parsed.options)) {
        diff++; panel.addDetail("diff", parsed.rawStem, `题库键「${key}」答案「${ans}」无效或页面不存在该选项。`);
        b.style.outline = "2px dashed #f59e0b";
        continue;
      }

      const ok = panel.isAuto() ? pickSingleChoice(b, ans) : false;
      hit++;
      if (!ok) panel.addDetail("hit", parsed.rawStem, `命中（${reason}，键：「${key}」），但未能自动点击或被框架拦截。`);
      else panel.addDetail("hit", parsed.rawStem, `命中（${reason}，键：「${key}」），答案「${ans}」。`);
    }

    // 多选题（注意 await）
    for (const b of extractMultiQuestionBlocks()) {
      const parsed = parseMultiBlock(b);
      if (!parsed.normStem) continue;

      const found = findRecordForStem(parsed.normStem, bank, PREFS.fuzzyThreshold);
      if (!found) {
        miss++; panel.addDetail("miss", parsed.rawStem, "未在题库中找到（多选）。");
        b.style.outline = "2px dashed #fb7185";
        continue;
      }

      const { record, key, reason } = found;
      if (!record || record.type !== "multi") {
        diff++; panel.addDetail("diff", parsed.rawStem, `题库键「${key}」类型为「${record && record.type}」，页面识别为「多选」。`);
        b.style.outline = "2px dashed #f59e0b";
        continue;
      }

      let ansArr = Array.isArray(record.answer) ? record.answer.map(s => String(s).toUpperCase()) : [];
      ansArr = Array.from(new Set(ansArr)).sort();
      if (!ansArr.length) {
        diff++; panel.addDetail("diff", parsed.rawStem, `题库键「${key}」答案数组为空或无效。`);
        b.style.outline = "2px dashed #f59e0b";
        continue;
      }

      const missing = ansArr.filter(x => !(x in parsed.options));
      if (missing.length) {
        diff++; panel.addDetail("diff", parsed.rawStem, `题库键「${key}」中以下选项在页面不存在：${missing.join("、")}。`);
        b.style.outline = "2px dashed #f59e0b";
        continue;
      }

      let ok = false;
      if (panel.isAuto()) ok = await pickMultiChoices(b, ansArr); // ★ 关键：await

      hit++;
      if (panel.isAuto() && !ok) {
        panel.addDetail("hit", parsed.rawStem, `命中（${reason}，键：「${key}」），应选：${ansArr.join("、")}，但未能切换勾选。`);
      } else {
        panel.addDetail("hit", parsed.rawStem, `命中（${reason}，键：「${key}」），应选：${ansArr.join("、")}。`);
      }
    }

    panel.setStats({ hit, miss, diff });
  })();

  /** ================= 可选“学习模式”（默认关闭，防误写） =================
   * 若你想让脚本根据你手动选择来回写题库（补录/修订），去掉下面注释即可。
   */
  
  document.addEventListener("change", (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    const isRadio = input.type === "radio" && input.classList.contains("el-radio__original");
    const isCheckbox = input.type === "checkbox" && input.classList.contains("el-checkbox__original");
    if (!isRadio && !isCheckbox) return;

    const block = input.closest(".item-view");
    if (!block) return;

    if (/【\s*多选\s*】/.test(block.textContent || "")) {
      const { rawStem, normStem } = parseMultiBlock(block);
      const checked = Array.from(block.querySelectorAll('input.el-checkbox__original[type="checkbox"]:checked'))
        .map(i => (i.value || "").toUpperCase())
        .filter(Boolean).sort();
      const bank = getBank();
      bank[normStem] = { type: "multi", answer: checked };
      setBank(bank);
      panel.addDetail("hit", rawStem, `已学习（多选）答案：[${checked.join(", ")}]。`);
    } else {
      const { rawStem, normStem } = parseSingleBlock(block);
      const letter = (input.value || "").toUpperCase();
      const bank = getBank();
      bank[normStem] = { type: "single", answer: letter };
      setBank(bank);
      panel.addDetail("hit", rawStem, `已学习（单选）答案「${letter}」。`);
    }
  });
  
})();
