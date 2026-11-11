import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

// ============================================================
// 国科大硕士学位英语（慕课学习）自动刷课脚本 — 2026 秋季版
//
// 适配说明（相对旧版 ucas-mooc-helper 的变更）：
//  1. 课程树结构回退为 posCatalog_select（不再是 #coursetree .ncells）
//  2. 登录页为 passport2.chaoxing.com（占位符不变）
//  3. 文档任务端点改为 /mooc-ans/job/document；当前课程中文档非计分任务点
//  4. 使用持久化浏览器 profile，只登录一次，减少验证码触发
//  5. 视频必须顺序播放（seek 会被服务器拒绝并回跳），2 倍速可用
// ============================================================

// ---------------- 配置 ----------------
// 账号、课程链接等私密信息放在 config.mjs（已被 .gitignore 排除）。
// 首次使用请复制 config.example.mjs 为 config.mjs 并填写。
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(ROOT, ".profile"); // 持久化登录态

if (!fs.existsSync(path.join(ROOT, "config.mjs"))) {
  console.error("缺少配置文件 config.mjs —— 请复制 config.example.mjs 为 config.mjs 并填写账号信息。");
  process.exit(1);
}
const { url_login, edge_path, username, password } = await import("./config.mjs");

const PLAYBACK_RATE = 2; // 播放倍速（本课程官方允许 doublespeed:1）
const MAX_ATTEMPTS = 3; // 同一小节最多尝试次数（真实失败才计数）
const RECHECK_COOLDOWN = 90_000; // 同一小节两次处理之间的最短间隔
const MAX_SECTIONS = Number(process.env.MAX_SECTIONS || 0); // >0 时最多处理 N 节（测试用）

// ---------------- 日志 ----------------
const T0 = Date.now();
const ts = () => {
  const s = Math.floor((Date.now() - T0) / 1000);
  return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
};
const C = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m", bold: "\x1b[1m",
};
const say = (color, msg) => console.log(`${C.gray}${ts()}${C.reset} ${color}${msg}${C.reset}`);
const info = (msg) => say(C.reset, msg);
const ok = (msg) => say(C.green, `✔ ${msg}`);
const warn = (msg) => say(C.yellow, `⚠ ${msg}`);
const err = (msg) => say(C.red, `✘ ${msg}`);
const step = (msg) => say(C.blue + C.bold, msg);
const shortErr = (e) => String(e && e.message ? e.message : e).split("\n")[0].slice(0, 140);

// ---------------- 主流程 ----------------
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  executablePath: edge_path, // 使用系统 Edge（Playwright 自带 Chromium 无 Flash 时代码兼容性差）
  ignoreHTTPSErrors: true,
  viewport: null,
  args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

// isPassed 监听：全局挂一次，按 jobid 分发
const passFlags = new Map(); // jobid -> true（收到 isPassed:true）
const onResp = async (resp) => {
  try {
    const u = resp.url();
    if (!u.includes("multimedia/log")) return;
    const m = u.match(/[?&]jobid=(\d+)/);
    if (!m) return;
    const jobid = m[1];
    if (!passFlags.has(jobid)) return;
    const data = await resp.json().catch(() => null);
    if (!data) return;
    const pt = new URL(u).searchParams.get("playingTime");
    const dur = new URL(u).searchParams.get("duration");
    say(
      C.cyan,
      `      [上报] playingTime=${pt}/${dur} isPassed=${data.isPassed}`,
    );
    if (data.isPassed) passFlags.set(jobid, true);
  } catch {
    /* 忽略监听错误 */
  }
};
page.on("response", onResp);

process.on("SIGINT", async () => {
  console.log("");
  warn("收到中断信号，进度已保存在服务端，重跑脚本会自动继续。");
  try { await context.close(); } catch { /* 忽略 */ }
  process.exit(0);
});

try {
  await ensureLogin(page);
  await mainLoop();
} catch (e) {
  err(`脚本异常退出：${e.message}`);
  info("进度已保存在服务端，修复问题后重跑即可继续。");
} finally {
  page.off("response", onResp);
  await context.close().catch(() => {});
  process.exit(0);
}

// ============================================================
// 登录（持久化 profile 下多数情况直接复用会话）
// ============================================================
async function ensureLogin(page) {
  step("打开课程页面…");
  await page.goto(url_login, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("domcontentloaded");

  // 未登录会重定向到 passport2.chaoxing.com/login
  if (/passport\d*\.chaoxing\.com|passport\.mooc/.test(page.url())) {
    info("检测到未登录，开始自动登录…");
    const phone = page.getByPlaceholder("手机号/超星号");
    await phone.waitFor({ timeout: 20_000 });
    await phone.fill(username);
    await page.getByPlaceholder("学习通密码").fill(password);
    await page.getByRole("button", { name: "登录" }).click();

    // 等待跳回课程页；期间若出现验证码则提示手动处理
    const deadline = Date.now() + 180_000;
    let captchaWarned = false;
    while (Date.now() < deadline) {
      if (!/passport\d*\.chaoxing\.com|passport\.mooc/.test(page.url())) break;
      const st = await page
        .evaluate(() => {
          const v = document.querySelector("#needVcode")?.value || "";
          return { v };
        })
        .catch(() => ({ v: "" }));
      const sliderVisible = await page
        .locator(".geetest_panel, .geetest_widget, .nc-container, #captcha, .tcaptcha-transform")
        .first()
        .isVisible()
        .catch(() => false);
      if ((st.v && st.v !== "0") || sliderVisible) {
        if (!captchaWarned) {
          warn("检测到验证码，请在弹出的浏览器窗口中手动完成验证（最多等待 3 分钟）…");
          captchaWarned = true;
        }
      }
      await page.waitForTimeout(1500);
    }
    if (/passport\d*\.chaoxing\.com|passport\.mooc/.test(page.url())) {
      throw new Error("登录未完成（可能需要验证码/密码有误），请重跑脚本并手动完成验证");
    }
    ok("登录成功");
  }

  // 等课程树渲染
  await page
    .waitForSelector("#coursetree div.posCatalog_select:not(.firstLayer)", { timeout: 60_000 })
    .catch(() => { throw new Error("课程树未加载（页面结构可能又变了）"); });
  ok("课程页就绪");
}

// ============================================================
// 主循环：扫描课程树 → 处理未完成小节
// ============================================================
async function mainLoop() {
  const attempts = new Map(); // chapterId -> 真实失败次数
  const lastTouched = new Map(); // chapterId -> 上次处理时间戳
  const softSkips = new Map(); // chapterId -> "服务端已完成但树未刷新"复查次数
  const serverDone = new Set(); // 软跳过达上限的小节，不再复查
  const processedTitles = [];
  let sectionsDone = 0;

  while (true) {
    if (MAX_SECTIONS > 0 && sectionsDone >= MAX_SECTIONS) {
      info(`已达测试上限（${MAX_SECTIONS} 节），停止。`);
      break;
    }

    const sections = await readCatalog(page);
    if (sections.length === 0) {
      throw new Error("课程树为空，页面结构可能又变了");
    }

    const quizRe = /quiz/i;
    const unfinished = sections.filter(
      (s) => !s.completed && Number(s.unfinish) > 0 && !quizRe.test(s.title) && !quizRe.test(s.nameText),
    );

    if (unfinished.length === 0) {
      ok(`🎉 全部完成！共 ${sections.length} 个小节。`);
      break;
    }

    const now = Date.now();
    const candidate = unfinished.find(
      (s) =>
        (attempts.get(s.id) || 0) < MAX_ATTEMPTS &&
        !serverDone.has(s.id) &&
        now - (lastTouched.get(s.id) || 0) > RECHECK_COOLDOWN,
    );

    if (!candidate) {
      const pending = unfinished.filter(
        (s) => (attempts.get(s.id) || 0) < MAX_ATTEMPTS && !serverDone.has(s.id),
      );
      if (pending.length === 0) {
        const blocked = unfinished.filter((s) => (attempts.get(s.id) || 0) >= MAX_ATTEMPTS);
        if (blocked.length > 0) {
          err("以下小节多次尝试仍未完成，可能包含无法自动完成的任务点（如测验），请手动处理：");
          for (const s of blocked) err(`   - ${s.nameText || s.title}（已尝试 ${attempts.get(s.id)} 次）`);
        } else {
          ok(`🎉 全部完成！共 ${sections.length} 个小节。`);
        }
        break;
      }
      // 剩余小节都在冷却期（多为刚完成、树尚未刷新的快速复查），稍等重扫
      await page.waitForTimeout(15_000);
      continue;
    }

    lastTouched.set(candidate.id, now);
    const attemptNo = (attempts.get(candidate.id) || 0) + 1;
    const total = sections.length;
    const done = sections.filter((s) => s.completed).length;
    step(
      `▶ ${candidate.nameText || candidate.title}（${done}/${total} 已完成，未完成任务点 ${candidate.unfinish}）`,
    );

    const result = await processSection(page, candidate, attemptNo);
    if (result.finished) {
      if (result.nothingToDo) {
        // 服务端已判完成但树未刷新：软跳过计数，连续 3 次后不再复查
        const n = (softSkips.get(candidate.id) || 0) + 1;
        softSkips.set(candidate.id, n);
        if (n >= 3) {
          serverDone.add(candidate.id);
          ok(`服务端已判定完成（树刷新延迟），不再复查：${candidate.nameText || candidate.title}`);
        }
      } else {
        sectionsDone += 1;
        processedTitles.push(candidate.nameText || candidate.title);
      }
    } else {
      attempts.set(candidate.id, (attempts.get(candidate.id) || 0) + 1);
    }
    await page.waitForTimeout(1500); // 稍作停顿再重扫
  }

  console.log("");
  info(`本次共完成 ${sectionsDone} 个小节：`);
  for (const t of processedTitles) info(`   - ${t}`);
}

// 读取课程树目录
async function readCatalog(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("#coursetree div.posCatalog_select"))
      .filter((d) => !d.classList.contains("firstLayer"))
      .map((d) => {
        const nameSpan = d.querySelector("span.posCatalog_name");
        const oc = nameSpan ? nameSpan.getAttribute("onclick") || "" : "";
        const om = oc.match(/getTeacherAjax\('(\d+)','(\d+)','(\d+)'/);
        return {
          id: om ? om[3] : (d.id || "").replace(/^cur/, ""),
          title: nameSpan ? nameSpan.getAttribute("title") || "" : "",
          nameText: nameSpan ? nameSpan.textContent.replace(/\s+/g, " ").trim() : "",
          onclick: oc,
          completed: !!d.querySelector("span.icon_Completed"),
          unfinish: d.querySelector("input.jobUnfinishCount")?.value ?? "0",
          active: d.classList.contains("posCatalog_active"),
        };
      });
  });
}

// ============================================================
// 处理一个小节：加载内容 → 视频 → 文档
// ============================================================
async function processSection(page, sec, attemptNo) {
  const result = { finished: true };

  // 点击小节（onclick 里带章节 id，定位最稳）
  const clickLoc = page.locator(
    `#coursetree span.posCatalog_name[onclick*="'${sec.id}'"]`,
  );
  try {
    await clickLoc.click({ timeout: 10_000 });
  } catch {
    // 兜底：直接调用页面自己的加载函数
    const om = sec.onclick.match(/getTeacherAjax\('(\d+)','(\d+)','(\d+)'/);
    if (om) await page.evaluate((args) => getTeacherAjax(...args), [om[1], om[2], om[3]]);
    else return { finished: false };
  }

  // 等待新内容加载完成（mArg.defaults.knowledgeid 必须等于目标章节，防止拿到旧内容）
  try {
    await page.waitForSelector("#iframe", { timeout: 20_000, state: "attached" });
  } catch (e) {
    warn(`   内容区未出现（${shortErr(e)}）`);
    return { finished: false };
  }
  try {
    await page.waitForFunction(
      (wantId) => {
        try {
          const f = document.querySelector("#iframe");
          const a = f && f.contentWindow ? f.contentWindow.mArg : null;
          return (
            a && typeof a === "object" && Array.isArray(a.attachments) &&
            String(a.defaults?.knowledgeid) === String(wantId)
          );
        } catch {
          // iframe 替换瞬间可能出现跨域访问（SecurityError），忽略并继续轮询
          return false;
        }
      },
      sec.id,
      { timeout: 45_000 },
    );
  } catch (e) {
    warn(`   内容加载超时（第 ${attemptNo} 次：${shortErr(e)}）`);
    return { finished: false };
  }

  // 人脸识别弹窗检测（无法自动化）
  const face = await page.evaluate(() => {
    const f = document.querySelector("#iframe");
    try {
      return !!(f.contentDocument && f.contentDocument.getElementById("chapterFaceState"));
    } catch { return false; }
  });
  if (face) {
    warn("   本节需要人脸识别，无法自动完成，跳过");
    return { finished: false };
  }

  const secInfo = await readSectionInfo(page);
  if (!secInfo) {
    warn("   无法读取任务配置，跳过本节");
    return { finished: false };
  }

  // ---- 视频任务点 ----
  const videoAtts = secInfo.attachments.filter((a) => a.type === "video" && a.job);
  if (videoAtts.length === 0) {
    info("   本节无视频任务点");
  }
  let nothingToDo = true; // mArg 中所有计分任务点均已完成（树刷新滞后时出现）
  for (const att of videoAtts) {
    if (att.isPassed) {
      ok(`   视频任务点已完成，跳过（jobid=${att.jobid}）`);
      continue;
    }
    nothingToDo = false;
    const done = await watchVideo(page, att);
    if (!done) result.finished = false; // 超时不终止，继续处理后续
  }

  // ---- 文档任务点（当前课程非计分，仅兼容未来变化）----
  await processDocuments(page, secInfo);

  return { ...result, nothingToDo };
}

// 读取 mArg 任务配置
async function readSectionInfo(page) {
  return page.evaluate(() => {
    const f = document.querySelector("#iframe");
    const m = f.contentWindow && f.contentWindow.mArg;
    if (!m || !Array.isArray(m.attachments)) return null;
    const d = m.defaults || {};
    return {
      attachments: m.attachments.map((a) => ({
        type: a.type,
        job: !!a.job,
        isPassed: !!a.isPassed,
        objectId: a.objectId || (a.property && a.property.objectid) || "",
        jobid: String(a.jobid || (a.property && a.property._jobid) || ""),
        jtoken: a.jtoken || "",
        microTopicId: a.microTopicId,
        attDuration: a.attDuration || Number(a.property && a.property.duration) || 0,
      })),
      defaults: {
        knowledgeid: String(d.knowledgeid || ""),
        courseid: String(d.courseid || ""),
        clazzId: String(d.clazzId || ""),
        cpi: String(d.cpi || ""),
      },
    };
  }).catch(() => null);
}

// ============================================================
// 视频任务点：真实播放（2 倍速 + 防暂停 + 防跳节），等 isPassed:true
// ============================================================
async function watchVideo(page, att) {
  const cardsFrame = page.frames().find((f) => f.url().includes("/mooc-ans/knowledge/cards"));
  if (!cardsFrame) {
    warn("   找不到内容 iframe");
    return false;
  }

  // 找到本任务点对应的视频 iframe
  const el = await cardsFrame
    .waitForSelector(`iframe.ans-insertvideo-online[objectid="${att.objectId}"]`, { timeout: 10_000 })
    .catch(() => null);
  if (!el) {
    warn(`   找不到视频 iframe（objectId=${att.objectId}）`);
    return false;
  }
  const vf = await el.contentFrame();
  if (!vf) {
    warn("   视频 iframe 无法访问");
    return false;
  }

  // 等待视频元素在 iframe 内真正渲染出来（播放器 HTML 异步加载）
  const videoReady = await vf
    .waitForSelector("video", { timeout: 20_000, state: "attached" })
    .catch(() => null);
  if (!videoReady) {
    warn("   视频 iframe 内无 video 元素（加载超时）");
    return false;
  }

  passFlags.set(att.jobid, false);

  // 注入播放控制（防暂停 / 2倍速 / 防 ended 自动跳节）
  const inject = await vf
    .evaluate((rate) => {
      const w = window;
      w.__moocTimers = w.__moocTimers || [];
      w.__moocTimers.forEach(clearInterval);
      w.__moocTimers.length = 0;
      const v = document.querySelector("video");
      if (!v) return "novideo";
      v.muted = true;
      v.playbackRate = rate;
      // 防 ended：事件拦截 + 回跳 10 秒继续播（服务器认的是上报，不是 ended）
      v.addEventListener(
        "ended",
        (e) => {
          e.stopPropagation();
          e.stopImmediatePropagation();
          try {
            v.currentTime = Math.max(0, v.duration - 10);
            v.play();
          } catch { /* 忽略 */ }
        },
        true,
      );
      // 防 pause（鼠标移走/失焦检测）
      v.addEventListener("pause", () => {
        try { v.play(); } catch { /* 忽略 */ }
      });
      // 吞掉 Video.js 内部 ended（防自动跳下一节）
      setTimeout(() => {
        const el2 = document.querySelector(".video-js");
        const p = el2 && el2.player;
        if (p) {
          const orig = p.trigger.bind(p);
          p.trigger = (name, ...rest) => (name === "ended" ? undefined : orig(name, ...rest));
        }
      }, 1200);
      // 定时器：强制倍速 + 恢复播放
      w.__moocTimers.push(
        w.setInterval(() => {
          const vv = document.querySelector("video");
          if (vv) {
            if (vv.playbackRate !== rate) vv.playbackRate = rate;
            if (vv.paused) vv.play().catch(() => {});
          }
        }, 700),
      );
      return "ok";
    }, PLAYBACK_RATE)
    .catch(() => "inject-fail");

  if (inject !== "ok") {
    warn(`   视频控制注入失败（${inject}）`);
    passFlags.delete(att.jobid);
    return false;
  }

  // 点击大播放按钮（让页面自己的播放器逻辑正常上报）
  const bigBtn = vf.locator(".vjs-big-play-button");
  if ((await bigBtn.count()) > 0) {
    await bigBtn.click({ timeout: 3000 }).catch(() => {});
  }
  await vf
    .evaluate(() => {
      const v = document.querySelector("video");
      if (v && v.paused) v.play().catch(() => {});
    })
    .catch(() => {});

  // 视频时长：优先 mArg 里的 attDuration，其次真实读取
  let duration = att.attDuration;
  if (!duration) {
    duration = await vf
      .evaluate(
        () =>
          new Promise((resolve) => {
            const v = document.querySelector("video");
            if (!v) return resolve(0);
            if (v.duration && !isNaN(v.duration)) return resolve(v.duration);
            const done = () => resolve(v.duration || 0);
            v.addEventListener("loadedmetadata", done, { once: true });
            setTimeout(() => done(), 8000);
          }),
      )
      .catch(() => 0);
  }
  duration = duration || 600;

  // 等待完成：2倍速下约 duration/2 秒，再加上报间隔与缓冲
  const timeoutMs = Math.max((duration / 2) * 1.4 * 1000 + 150_000, 240_000);
  info(`   播放中：时长 ${Math.floor(duration)}s，倍速 ${PLAYBACK_RATE}，最长等待 ${Math.floor(timeoutMs / 60000)} 分钟…`);

  const start = Date.now();
  let lastBeat = 0;
  let passed = false;
  while (Date.now() - start < timeoutMs) {
    if (passFlags.get(att.jobid) === true) {
      passed = true;
      break;
    }
    if (Date.now() - lastBeat > 30_000) {
      lastBeat = Date.now();
      const st = await vf
        .evaluate(() => {
          const v = document.querySelector("video");
          return v ? { t: Math.round(v.currentTime), d: Math.round(v.duration || 0), r: v.playbackRate, p: v.paused } : null;
        })
        .catch(() => null);
      if (st) {
        say(C.cyan, `      ▶ ${st.t}/${st.d}s ×${st.r}${st.p ? "（暂停→恢复中）" : ""}`);
      }
    }
    await page.waitForTimeout(1000);
  }

  // 清理注入的定时器
  await vf
    .evaluate(() => {
      (window.__moocTimers || []).forEach(clearInterval);
      window.__moocTimers = [];
    })
    .catch(() => {});
  passFlags.delete(att.jobid);

  if (passed) {
    ok(`   视频任务点完成（jobid=${att.jobid}）`);
    return true;
  }
  warn(`   视频等待超时，服务端已记录进度，稍后/重跑会自动续播`);
  return false;
}

// ============================================================
// 文档任务点（PPT/PDF）：仅当计分（job:true）时上报
// ============================================================
async function processDocuments(page, secInfo) {
  const cardsFrame = page.frames().find((f) => f.url().includes("/mooc-ans/knowledge/cards"));
  if (!cardsFrame) return;

  const docEls = await cardsFrame
    .$$("iframe.ans-attach-online.insertdoc-online-ppt, iframe[src*='modules/pdf']")
    .catch(() => []);

  for (const el of docEls) {
    const dataRaw = await el.getAttribute("data").catch(() => null);
    if (!dataRaw) continue;
    let data = {};
    try { data = JSON.parse(dataRaw); } catch { continue; }
    const jobid = String(data.jobid || "");
    if (!jobid) continue; // 非计分任务点（本课程文档均属此类）

    const att = secInfo.attachments.find((a) => a.jobid === jobid);
    if (!att || !att.job) {
      info("   文档为非计分任务点，跳过");
      continue;
    }

    const base = new URL(cardsFrame.url()).origin;
    const q = new URLSearchParams({
      jobid,
      knowledgeid: secInfo.defaults.knowledgeid,
      courseid: secInfo.defaults.courseid,
      clazzid: secInfo.defaults.clazzId,
      jtoken: att.jtoken || "",
      checkMicroTopic: "true",
      microTopicId: att.microTopicId == null ? "undefined" : String(att.microTopicId),
      courseEngineInfo: "false",
      _dc: String(Date.now()),
    });
    const resp = await page.request.get(`${base}/mooc-ans/job/document?${q}`).catch(() => null);
    if (!resp) {
      warn("   文档任务点上报请求失败");
      continue;
    }
    const j = await resp.json().catch(() => null);
    if (j && j.status) ok(`   文档任务点完成（jobid=${jobid}）`);
    else warn(`   文档任务点上报返回异常：${JSON.stringify(j)}`);
  }
}
