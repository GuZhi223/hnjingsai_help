// ==UserScript==
// @name         宗教答题测试助手（v1.3.0：含服务器答案融合 + 模糊匹配 + 多选修复）
// @namespace    https://example.com/userscripts
// @version      1.3.0
// @description  自动匹配并勾选【单选/多选】；融合服务器答案（拦截 getPaper），无须大改题库；更强规范化 + 模糊匹配；多选逐点原生 click；内置答案网格面板与调试工具。
// @author       GuZhi223 & ChatGPT
// @match        *://hnjingsai.cn/cbt/exam/*
// @match        *://hnjingsai.cn/*
// @match        *://hnjingsai.cn/cbt/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  /** ================= 偏好设置（可在菜单里动态修改） ================= */
  const PREFS = {
    autoAnswer: GM_getValue("autoAnswer", true),
    fuzzyThreshold: Number(GM_getValue("fuzzyThreshold", 0.5)), // 0.4~0.7 可调
    bankURL: GM_getValue("qaBankURL", ""),
    preferServer: GM_getValue("preferServerAnswers", true),     // ★ 新增：优先使用服务器答案
    clickDelayMs: Number(GM_getValue("clickDelayMs", 50)),      // 多选逐点点击延时
  };

  /** ================= 数据存储 ================= */
  function getBank() {
    try { return JSON.parse(GM_getValue("qaBank", "{}")); } catch { return {}; }
  }
  function setBank(obj) {
    GM_setValue("qaBank", JSON.stringify(obj || {}));
  }
  // 服务器答案的“临时题库”（会与本地/远端合并使用，不覆盖你的本地库）
  let serverBank = {}; // { normStem: { type: 'single'|'multi', answer: 'C'|['A','C'], source:'server' } }

  /** ================= 工具函数 ================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 更强规范化：清空白/零宽、去【标签】、去空括号、去标点与序号
  function normalizeStem(raw) {
    if (!raw) return "";
    let s = String(raw)
      .replace(/[\s\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000\u200B]+/g, "") // 各种空白
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

  /** ================= 匹配器（含模糊） ================= */
  function tokenizeForFuzzy(s) {
    // 轻量分词：以常见虚词切分，去重（长度>1）
    return Array.from(new Set(
      s.split(/(的|是|与|和|及|于|对|在|为|把|下列|关于|哪些|那些|以下|正确|说法|内容|必须|基本|方略|治藏|新时代)/)
       .filter(x => x && x.length > 1)
    ));
  }

  function findRecordForStem(normStem, mergedBank, threshold = 0.5) {
    if (mergedBank[normStem]) return { key: normStem, record: mergedBank[normStem], reason: "exact" };

    const keys = Object.keys(mergedBank);
    if (!keys.length) return null;

    // 1) 互为包含（优先）：短键命中长题干，或反之
    let hit = keys.find(k => k && (k.includes(normStem) || normStem.includes(k)));
    if (hit) return { key: hit, record: mergedBank[hit], reason: "inclusive" };

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
      return { key: best, record: mergedBank[best], reason: "fuzzy:"+bestScore.toFixed(2) };
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
    try { input.click(); } catch { clickTarget.click(); }
    fireEvents(clickTarget);
    (clickTarget.closest(".el-radio") || clickTarget).style.outline = "2px solid #22c55e";
    return true;
  }

  // 多选逐点点击 + 延时（解决只勾最后一个的问题）
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
      await sleep(PREFS.clickDelayMs); // 40~100ms 之间按站点适配
    };

    for (const i of toCheck)   { await clickInput(i, true);  changed = true; }
    for (const i of toUncheck) { await clickInput(i, false); changed = true; }

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

  /** ================= UI 面板（统计面板） ================= */
  const statPanel = (() => {
    // 延后到 DOM 可用时注入
    function ensurePanel() {
      if (document.getElementById("qa-helper-stat-panel")) return;
      const box = document.createElement("div");
      box.id = "qa-helper-stat-panel";
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
          <div style="margin-left:auto;opacity:.9">
            <label style="display:flex;gap:6px;align-items:center;cursor:pointer;">
              <input id="preferServer" type="checkbox" style="accent-color:#22c55e"> 优先用服务器答案
            </label>
          </div>
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

      const autoToggle = box.querySelector("#autoToggle");
      const fzVal = box.querySelector("#fzVal");
      const preferServer = box.querySelector("#preferServer");

      autoToggle.checked = !!PREFS.autoAnswer;
      preferServer.checked = !!PREFS.preferServer;

      autoToggle.addEventListener("change", () => {
        PREFS.autoAnswer = autoToggle.checked;
        GM_setValue("autoAnswer", PREFS.autoAnswer);
      });

      preferServer.addEventListener("change", () => {
        PREFS.preferServer = preferServer.checked;
        GM_setValue("preferServerAnswers", PREFS.preferServer);
      });

      ensurePanel.hitCount = box.querySelector("#hitCount");
      ensurePanel.missCount = box.querySelector("#missCount");
      ensurePanel.diffCount = box.querySelector("#diffCount");
      ensurePanel.detailList = box.querySelector("#detailList");
      ensurePanel.fzVal = fzVal;
    }

    function addDetail(type, stem, msg) {
      ensurePanel();
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
      ensurePanel.detailList.appendChild(item);
    }

    function setStats({ hit, miss, diff }) {
      ensurePanel();
      ensurePanel.hitCount.textContent = String(hit);
      ensurePanel.missCount.textContent = String(miss);
      ensurePanel.diffCount.textContent = String(diff);
    }

    function refreshFuzzy() {
      ensurePanel();
      ensurePanel.fzVal.textContent = String(PREFS.fuzzyThreshold);
    }

    return { ensurePanel, addDetail, setStats, refreshFuzzy };
  })();

  /** ================= 答案网格面板（来自服务器答案显示） ================= */
  const serverPanel = (() => {
    function injectCSS() {
      if (document.getElementById("server-panel-style")) return;
      const style = document.createElement('style');
      style.id = "server-panel-style";
      style.textContent = `
        #auto-answer-panel {
          position: fixed; top: 20px; left: 20px; width: 360px;
          background: #ffffff; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
          z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #333; overflow: hidden;
        }
        #answer-panel-header {
          padding: 14px 18px; background: #f7f9fa; border-bottom: 1px solid #eee;
          display: flex; justify-content: space-between; align-items: center; cursor: move; user-select: none;
        }
        #answer-grid-container { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; padding: 18px; }
        .grid-answer-box {
          border: 1px solid #dcdfe6; background: #fff; border-radius: 4px; cursor: pointer; transition: all .2s;
          user-select: none; display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 6px 4px; min-height: 42px;
        }
        .grid-answer-box:hover { background: #f5f7fa; border-color: #c0c4cc; }
        .grid-q-num { font-size: 11px; color: #909399; }
        .grid-q-ans { font-size: 15px; font-weight: 700; color: #409EFF; line-height: 1.2; margin-top: 3px; font-family: 'Courier New', monospace; }
        .grid-answer-box.active { background: #409EFF; color: #fff; border-color: #409EFF; }
        .grid-answer-box.active .grid-q-num { color: #e0e0e0; }
        .grid-answer-box.active .grid-q-ans { color: #fff; }
        #answer-display-area { padding: 0 18px 18px 18px; }
        .display-content { background: #f8f9fa; border: 1px solid #eee; border-radius: 6px; padding: 15px; min-height: 120px; user-select: text; }
        .display-prompt { color: #999; text-align: center; padding-top: 35px; font-size: 14px; }
        .display-q-num { font-size: 16px; font-weight: 600; color: #303133; margin-bottom: 12px; }
        .display-q-title { font-size: 14px; color: #333; line-height: 1.6; white-space: normal; word-wrap: break-word; margin-bottom: 15px; }
        .display-q-answer { font-size: 20px; font-weight: 700; color: #E6A23C; background: #fdf6ec; border: 1px solid #faecd8; border-radius: 5px; padding: 8px 12px; font-family: 'Courier New', monospace; }
        #panel-footer { padding: 15px 18px; background: #f7f9fa; border-top: 1px solid #eee; font-size: 13px; color: #606266; line-height: 1.5; text-align: center; }
      `;
      document.head.appendChild(style);
    }

    function makeDraggable(element, handle) {
      let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
      handle.onmousedown = (e) => {
        e.preventDefault();
        pos3 = e.clientX; pos4 = e.clientY;
        document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
        document.onmousemove = (e2) => {
          e2.preventDefault();
          pos1 = pos3 - e2.clientX; pos2 = pos4 - e2.clientY;
          pos3 = e2.clientX; pos4 = e2.clientY;
          const newTop = element.offsetTop - pos2;
          const newLeft = element.offsetLeft - pos1;
          element.style.top = Math.max(0, Math.min(newTop, window.innerHeight - element.offsetHeight)) + 'px';
          element.style.left = Math.max(0, Math.min(newLeft, window.innerWidth - element.offsetWidth)) + 'px';
        };
      };
    }

    

    return {  };
  })();

  /** ================= 服务器答案接入（拦截 getPaper） =================
   * 把服务器返回的题目 + 正确答案转为临时题库（serverBank），并显示答案网格面板。
   * 若“优先使用服务器答案”开启，则自动优先用 serverBank 匹配/作答。
   */
  let questionsList = []; // 仅用于显示网格面板
  function processServerQuestions(questions) {
    if (!questions || !Array.isArray(questions) || !questions.length) return;

    // 组装 serverBank & 面板数据
    questionsList = questions.map(q => {
      const title = String(q.title || "");
      const right = String(q.rightAnswer || "").toUpperCase();
      const letters = (right.match(/[A-D]/gi) || []).map(s => s.toUpperCase());
      const normStem = normalizeStem(title);
      const record = (letters.length <= 1)
        ? { type: "single", answer: (letters[0] || "A"), source: "server" }
        : { type: "multi",  answer: Array.from(new Set(letters)).sort(), source: "server" };

      if (normStem) serverBank[normStem] = record;
      return { title, rightAnswer: right };
    });

    

    // 如果 preferServer 开启，立即尝试自动作答（等 DOM ready）
    // 这里不强行触发；主流程在运行时会合并 serverBank 参与匹配与点击
  }

  // --- 拦截 fetch ---
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    return originalFetch.apply(this, args).then(resp => {
      try {
        const url = String(args[0] || "");
        if (url.includes('/api/onlineExam/getPaper')) {
          const cloned = resp.clone();
          cloned.json().then(data => {
            if (data && data.success && data.result && data.result.questions) {
              processServerQuestions(data.result.questions);
            }
          }).catch(()=>{});
        }
      } catch {}
      return resp;
    });
  };

  // --- 拦截 XHR ---
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._url && String(this._url).includes('/api/onlineExam/getPaper')) {
      this.addEventListener('load', function() {
        try {
          const data = JSON.parse(this.responseText);
          if (data && data.success && data.result && data.result.questions) {
            processServerQuestions(data.result.questions);
          }
        } catch {}
      });
    }
    return originalSend.apply(this, args);
  };

  /** ================= 菜单（导入/导出/阈值/调试/服务器优先/延时） ================= */
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
    const url = prompt("填写题库 JSON 的直链 URL：", cur || "");
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
    statPanel.refreshFuzzy();
    alert("已设置阈值为 " + num);
  });

  GM_registerMenuCommand("切换：优先使用服务器答案", () => {
    PREFS.preferServer = !PREFS.preferServer;
    GM_setValue("preferServerAnswers", PREFS.preferServer);
    alert("已" + (PREFS.preferServer ? "启用" : "关闭") + "服务器答案优先。");
  });

  GM_registerMenuCommand("设置多选点击延时(ms)", () => {
    const v = prompt("每次多选点击的延时（建议 40~100 ms）：", String(PREFS.clickDelayMs));
    if (v == null) return;
    const num = Number(v);
    if (isNaN(num) || num < 0 || num > 500) { alert("无效的延时"); return; }
    PREFS.clickDelayMs = num;
    GM_setValue("clickDelayMs", num);
    alert("已设置延时为 " + num + " ms");
  });

  GM_registerMenuCommand("调试：复制本页规范化题干", () => {
    const singles = extractSingleQuestionBlocks().map(parseSingleBlock);
    const multis  = extractMultiQuestionBlocks().map(parseMultiBlock);
    const all = [...singles, ...multis].map(x => x.normStem).filter(Boolean);
    const text = all.join("\n");
    navigator.clipboard?.writeText(text);
    alert("已复制本页规范化题干，共 " + all.length + " 条。");
  });

  /** ================= 主流程 ================= */
  (async function main() {
    // 等 DOM 大致就绪（statPanel 需要 DOM）
    const ready = () => document.readyState === "interactive" || document.readyState === "complete";
    if (!ready()) await new Promise(r => document.addEventListener("DOMContentLoaded", r, { once:true }));
    statPanel.ensurePanel();

    // 小延迟，等服务器答案机会（若页面先请求 getPaper，会很快进入 serverBank）
    await sleep(300);

    // 拉取并合并题库
    let bank = getBank();
    const remote = await (async () => {
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
    })();
    if (remote && typeof remote === "object") bank = { ...bank, ...remote };

    // 合并 bank 与 serverBank（按“服务器优先”决定覆盖方向）
    let mergedBank = {};
    if (PREFS.preferServer) {
      mergedBank = { ...bank, ...serverBank };  // server 覆盖同键
    } else {
      mergedBank = { ...serverBank, ...bank };  // 本地题库优先
    }

    let hit = 0, miss = 0, diff = 0;

    // 单选题
    for (const b of extractSingleQuestionBlocks()) {
      const parsed = parseSingleBlock(b);
      if (!parsed.normStem) continue;

      const found = findRecordForStem(parsed.normStem, mergedBank, PREFS.fuzzyThreshold);
      if (!found) {
        miss++; statPanel.addDetail("miss", parsed.rawStem, "未在题库/服务器答案中找到（单选）。");
        b.style.outline = "2px dashed #fb7185";
        continue;
      }
      const { record, key, reason } = found;
      if (!record || record.type !== "single") {
        diff++; statPanel.addDetail("diff", parsed.rawStem, `题库键「${key}」类型为「${record && record.type}」，页面识别为「单选」。`);
        b.style.outline = "2px dashed #f59e0b";
        continue;
      }

      const ans = String(record.answer || "").toUpperCase();
      if (!/^[A-Z]$/.test(ans) || !(ans in parsed.options)) {
        diff++; statPanel.addDetail("diff", parsed.rawStem, `键「${key}」答案「${ans}」无效或页面不存在该选项。`);
        b.style.outline = "2px dashed #f59e0b";
        continue;
      }

      const ok = PREFS.autoAnswer ? pickSingleChoice(b, ans) : false;
      hit++;
      const src = record.source === "server" ? "（来自服务器）" : "";
      if (!ok) statPanel.addDetail("hit", parsed.rawStem, `命中${src}（${reason}，键：「${key}」），但未能自动点击或被框架拦截。`);
      else     statPanel.addDetail("hit", parsed.rawStem, `命中${src}（${reason}，键：「${key}」），答案「${ans}」。`);
    }

    // 多选题（注意 await）
    for (const b of extractMultiQuestionBlocks()) {
      const parsed = parseMultiBlock(b);
      if (!parsed.normStem) continue;

      const found = findRecordForStem(parsed.normStem, mergedBank, PREFS.fuzzyThreshold);
      if (!found) {
        miss++; statPanel.addDetail("miss", parsed.rawStem, "未在题库/服务器答案中找到（多选）。");
        b.style.outline = "2px dashed #fb7185";
        continue;
      }
      const { record, key, reason } = found;
      if (!record || record.type !== "multi") {
        diff++; statPanel.addDetail("diff", parsed.rawStem, `题库键「${key}」类型为「${record && record.type}」，页面识别为「多选」。`);
        b.style.outline = "2px dashed #f59e0b";
        continue;
      }

      let ansArr = Array.isArray(record.answer) ? record.answer.map(s => String(s).toUpperCase()) : [];
      ansArr = Array.from(new Set(ansArr)).sort();
      if (!ansArr.length) {
        diff++; statPanel.addDetail("diff", parsed.rawStem, `键「${key}」答案数组为空或无效。`);
        b.style.outline = "2px dashed #f59e0b";
        continue;
      }

      const missing = ansArr.filter(x => !(x in parsed.options));
      if (missing.length) {
        diff++; statPanel.addDetail("diff", parsed.rawStem, `键「${key}」中以下选项在页面不存在：${missing.join("、")}。`);
        b.style.outline = "2px dashed #f59e0b";
        continue;
      }

      let ok = false;
      if (PREFS.autoAnswer) ok = await pickMultiChoices(b, ansArr);

      hit++;
      const src = record.source === "server" ? "（来自服务器）" : "";
      if (PREFS.autoAnswer && !ok) {
        statPanel.addDetail("hit", parsed.rawStem, `命中${src}（${reason}，键：「${key}」），应选：${ansArr.join("、")}，但未能切换勾选。`);
      } else {
        statPanel.addDetail("hit", parsed.rawStem, `命中${src}（${reason}，键：「${key}」），应选：${ansArr.join("、")}。`);
      }
    }

    statPanel.setStats({ hit, miss, diff });
  })();

})();
