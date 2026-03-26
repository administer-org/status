// ---------------------------------------------------------------------------
// STATUS WORKER  –  administer-org/status
//
// Handles:
//   • Scheduled health checks with D1 persistence
//   • Discord webhook alerts (node down / recovery / daily report)
//   • GET /  →  rendered status page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DB SETUP
// ---------------------------------------------------------------------------
async function ensureTables(db) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS health_checks (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT," +
      "node_name TEXT," +
      "is_up INTEGER," +
      "timestamp DATETIME DEFAULT CURRENT_TIMESTAMP" +
    ");" +
    "CREATE TABLE IF NOT EXISTS node_status (" +
      "node_name TEXT PRIMARY KEY," +
      "alerted_down INTEGER DEFAULT 0" +
    ");" +
    "CREATE TABLE IF NOT EXISTS meta (" +
      "key TEXT PRIMARY KEY," +
      "value TEXT" +
    ");"
  );
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function parseInstances(instancesEnv) {
  try {
    const parsed = typeof instancesEnv === "string" ? JSON.parse(instancesEnv) : instancesEnv;
    const list   = Array.isArray(parsed) ? parsed : (parsed.instances || []);
    return list.map(i => typeof i === "string" ? { url: i, name: i } : i);
  } catch { return []; }
}

async function sendEmbed(webhookUrl, embed) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });
  } catch {}
}

async function sendDailyReport(db, instances, webhookUrl) {
  if (!webhookUrl) return;
  const fields = [];
  for (const inst of instances) {
    const name = inst.name || inst.url;
    const displayName = (() => {
      try { return new URL(inst.url).hostname.split(".")[0]; } catch { return name; }
    })();
    let uptimeText = "No data";
    try {
      const row = await db.prepare(
        "SELECT AVG(is_up) as uptime FROM health_checks " +
        "WHERE node_name = ? AND timestamp >= datetime('now', '-1 day')"
      ).bind(name).first();
      if (row && row.uptime !== null) {
        uptimeText = (row.uptime * 100).toFixed(1) + "%";
      }
    } catch {}
    fields.push({ name: displayName, value: uptimeText, inline: true });
  }

  await sendEmbed(webhookUrl, {
    title: "Daily Uptime Report",
    color: 0x3498DB,
    description: "Uptime summary for the last 24 hours.",
    fields: fields,
    timestamp: new Date().toISOString(),
    footer: { text: "ADM Software - Status Monitor" }
  });
}

// ---------------------------------------------------------------------------
// STATUS PAGE RENDERER
// ---------------------------------------------------------------------------
async function renderStatusPage(env, instances) {
  let results = [];
  try {
    const res = await env.DB.prepare(
      "SELECT node_name, date(timestamp) as day, AVG(is_up) as uptime " +
      "FROM health_checks " +
      "WHERE timestamp >= date('now', '-30 days') " +
      "GROUP BY node_name, day ORDER BY day ASC"
    ).all();
    results = res.results || [];
  } catch (err) {
    console.log("DB error: " + err.message);
  }

  const latestStatus = {};
  try {
    const res = await env.DB.prepare(
      "SELECT node_name, is_up FROM health_checks WHERE id IN " +
      "(SELECT MAX(id) FROM health_checks GROUP BY node_name)"
    ).all();
    for (const r of (res.results || [])) {
      latestStatus[r.node_name] = r.is_up;
    }
  } catch {}

  const historyMap = {};
  for (const r of results) {
    if (!historyMap[r.node_name]) historyMap[r.node_name] = {};
    historyMap[r.node_name][r.day] = r.uptime;
  }

  const last30Days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last30Days.push(d.toISOString().split("T")[0]);
  }

  let anyDown = false;
  for (const inst of instances) {
    const name = inst.name || inst.url;
    if (latestStatus[name] === 0) { anyDown = true; break; }
  }

  // Bar stagger CSS
  let barStagger = "";
  for (let i = 1; i <= 30; i++) {
    barStagger += ".bars .bar:nth-child(" + i + "){animation-delay:" + (0.4 + i * 0.025).toFixed(3) + "s}";
  }

  // Build cards
  let cardsHtml = "";
  let cardIndex = 0;

  for (const inst of instances) {
    const name = inst.name || inst.url;
    const data = historyMap[name] || {};
    const displayName = (() => {
      try { return new URL(inst.url).hostname.split(".")[0]; } catch { return name; }
    })();

    const nodeIsDown = latestStatus[name] === 0;
    const cardDelay  = (0.25 + cardIndex * 0.13).toFixed(2);

    let barsHtml = "";
    let uptimeSum = 0, uptimeCount = 0;

    for (const day of last30Days) {
      const u   = data[day];
      const pct = u !== undefined ? Math.round(u * 100) : undefined;
      const cls = u === undefined ? "nodata" : u > 0.9 ? "up" : u > 0.5 ? "degraded" : "down";
      if (pct !== undefined) { uptimeSum += pct; uptimeCount++; }

      const dateObj = new Date(day + "T00:00:00");
      const dateStr = dateObj.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      const statusLabel = cls === "up" ? "Operational" : cls === "degraded" ? "Degraded" : cls === "down" ? "Outage" : "No data";
      const tooltip = dateStr + "  \u2022  " + statusLabel + (pct !== undefined ? "  (" + pct + "%)" : "");

      barsHtml += '<div class="bar ' + cls + '" data-tooltip="' + tooltip + '"></div>';
    }

    const avgUptime  = uptimeCount > 0 ? (uptimeSum / uptimeCount).toFixed(1) + "% uptime" : "";
    const badgeCls   = nodeIsDown ? "status-badge outage" : "status-badge";
    const badgeTxt   = nodeIsDown ? "&#9888; Outage" : "Operational";
    const dotCls     = nodeIsDown ? "node-dot outage" : "node-dot";
    const uptimeCls  = nodeIsDown ? "uptime-avg outage" : "uptime-avg";

    const miniHb = nodeIsDown
      ? "<svg class='mini-hb outage' viewBox='0 0 80 20' fill='none'>" +
        "<polyline class='mini-hb-line flat' points='0,10 30,10 36,8 42,12 48,10 80,10' " +
        "stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>"
      : "<svg class='mini-hb' viewBox='0 0 80 20' fill='none'>" +
        "<polyline class='mini-hb-line' points='0,10 15,10 21,10 25,3 29,17 33,6 37,10 52,10 56,7 60,13 64,10 80,10' " +
        "stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>";

    cardsHtml +=
      '<div class="card" style="animation-delay:' + cardDelay + 's">' +
        '<div class="card-header">' +
          '<div class="node-info">' +
            '<span class="' + dotCls + '"></span>' +
            '<span class="node-name">' + displayName + '</span>' +
            miniHb +
          '</div>' +
          '<span class="' + badgeCls + '">' + badgeTxt + '</span>' +
        '</div>' +
        '<div class="bars">' + barsHtml + '</div>' +
        '<div class="bar-labels">' +
          '<span>30 days ago</span>' +
          '<span class="' + uptimeCls + '">' + avgUptime + '</span>' +
          '<span>Today</span>' +
        '</div>' +
      '</div>';

    cardIndex++;
  }

  const nowStr     = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const bannerMod  = anyDown ? " warn" : "";
  const bannerText = anyDown ? "Partial Outage" : "All Systems Operational";
  const bannerSub  = anyDown
    ? "One or more nodes are currently unavailable."
    : "Everything is running smoothly.";

  const bannerIconSvg = anyDown
    ? "<svg viewBox='0 0 24 24' width='22' height='22' fill='none' stroke='currentColor' " +
      "stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
      "<path d='M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z'/>" +
      "<line x1='12' y1='9' x2='12' y2='13'/>" +
      "<line x1='12' y1='17' x2='12.01' y2='17'/></svg>"
    : "<svg viewBox='0 0 28 18' width='26' height='17' fill='none' stroke='currentColor' " +
      "stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'>" +
      "<polyline points='1,9 6,9 9,3 13,15 16,7 19,9 27,9'/></svg>";

  const hbInline = anyDown ? ""
    : "<svg class='hb-inline' viewBox='0 0 28 18' width='16' height='11' fill='none' " +
      "stroke='currentColor' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round' " +
      "aria-hidden='true'>" +
      "<polyline points='1,9 6,9 9,3 13,15 16,7 19,9 27,9'/>" +
      "</svg>";

  const css =
    ":root{" +
      "--bg-start:#ffffff;--bg-end:#1a3560;" +
      "--surface:rgba(255,255,255,0.82);--surface-solid:#ffffff;" +
      "--border:#d0d5e0;--text:#111827;--muted:#6b7280;" +
      "--green:#22c55e;--yellow:#d97706;--red:#ef4444;--nodata:#d1d5db;" +
      "--dot-color:rgba(0,0,0,.035);" +
      "--shadow:0 1px 3px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.04);" +
      "--shadow-lg:0 8px 32px rgba(0,0,0,.12);" +
      "--r:16px" +
    "}" +
    "@media(prefers-color-scheme:dark){:root{" +
      "--bg-start:#000000;--bg-end:#0a1a3a;" +
      "--surface:rgba(10,14,26,0.78);--surface-solid:#0a0e1a;" +
      "--border:#162040;--text:#f1f3f9;--muted:#7c8494;--nodata:#1a2240;" +
      "--dot-color:rgba(255,255,255,.018);" +
      "--shadow:0 1px 3px rgba(0,0,0,.55),0 4px 16px rgba(0,0,0,.4);" +
      "--shadow-lg:0 8px 40px rgba(0,0,0,.6)" +
    "}}" +
    "@keyframes fadeInUp{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:translateY(0)}}" +
    "@keyframes slideInLeft{from{opacity:0;transform:translateX(-30px)}to{opacity:1;transform:translateX(0)}}" +
    "@keyframes textReveal{from{clip-path:inset(0 100% 0 0);opacity:0}to{clip-path:inset(0 0 0 0);opacity:1}}" +
    "@keyframes pulseDot{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.4);opacity:.65}}" +
    "@keyframes hbDraw{to{stroke-dashoffset:0}}" +
    "@keyframes hbLoop{0%{stroke-dashoffset:0}100%{stroke-dashoffset:-260}}" +
    "@keyframes hbFlatPulse{0%,100%{opacity:.5}50%{opacity:1}}" +
    "@keyframes barGrow{from{transform:scaleY(0);opacity:.3}to{transform:scaleY(1);opacity:1}}" +
    "@keyframes shimmer{0%{left:-100%}100%{left:200%}}" +
    "@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}" +
    "@keyframes orbDrift{0%{transform:translate(0,0) scale(1)}33%{transform:translate(30px,-20px) scale(1.05)}66%{transform:translate(-20px,10px) scale(.95)}100%{transform:translate(0,0) scale(1)}}" +
    "@keyframes badgePop{0%{transform:scale(0);opacity:0}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}" +
    "@keyframes warningPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}" +
    "@keyframes glowPulse{0%,100%{box-shadow:0 0 14px color-mix(in srgb,var(--green) 22%,transparent)}50%{box-shadow:0 0 24px color-mix(in srgb,var(--green) 36%,transparent)}}" +
    barStagger +
    "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}" +
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif;" +
      "background:linear-gradient(145deg,var(--bg-start) 0%,var(--bg-end) 100%);" +
      "background-attachment:fixed;color:var(--text);min-height:100vh;" +
      "padding:48px 20px 80px;position:relative;overflow-x:hidden}" +
    "body::before{content:'';position:fixed;inset:0;" +
      "background:radial-gradient(circle at 1px 1px,var(--dot-color) 1px,transparent 0);" +
      "background-size:44px 44px;pointer-events:none;z-index:0}" +
    "body::after{content:'';position:fixed;top:12%;right:-8%;width:380px;height:380px;" +
      "background:radial-gradient(circle,color-mix(in srgb,var(--green) 7%,transparent),transparent 70%);" +
      "border-radius:50%;animation:orbDrift 18s ease-in-out infinite;pointer-events:none;z-index:0}" +
    ".container{max-width:760px;margin:0 auto;position:relative;z-index:1}" +
    ".page-header{display:flex;align-items:flex-end;justify-content:space-between;" +
      "margin-bottom:28px;gap:12px;flex-wrap:wrap;animation:slideInLeft .65s ease}" +
    ".header-left{display:flex;align-items:center;gap:14px}" +
    ".site-logo{width:42px;height:42px;border-radius:12px;object-fit:contain;flex-shrink:0;" +
      "animation:fadeInUp .5s ease backwards;" +
      "filter:drop-shadow(0 2px 6px rgba(0,0,0,.18))}" +
    "@media(prefers-color-scheme:dark){.site-logo{filter:drop-shadow(0 2px 8px rgba(0,0,0,.55)) brightness(1.05)}}" +
    ".page-title{font-size:1.6rem;font-weight:700;letter-spacing:-.4px;" +
      "animation:textReveal .9s cubic-bezier(.4,0,.2,1) forwards}" +
    ".page-subtitle{font-size:.8rem;color:var(--muted);margin-top:3px;" +
      "animation:fadeInUp .6s ease .25s backwards}" +
    ".last-updated{font-size:.75rem;color:var(--muted);text-align:right;" +
      "animation:fadeInUp .8s ease .45s backwards}" +
    ".last-updated::after{content:'\\a0\\2502';animation:blink 1.1s step-end infinite;font-weight:300}" +
    ".banner{display:flex;align-items:center;gap:16px;background:var(--surface);" +
      "backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);" +
      "border:1px solid var(--border);border-radius:var(--r);" +
      "padding:18px 24px;margin-bottom:24px;box-shadow:var(--shadow);" +
      "font-weight:600;font-size:.95rem;animation:fadeInUp .55s ease .12s backwards;" +
      "position:relative;overflow:hidden}" +
    ".banner::after{content:'';position:absolute;top:0;left:-100%;width:50%;height:100%;" +
      "background:linear-gradient(90deg,transparent,rgba(255,255,255,.07),transparent);" +
      "animation:shimmer 5s ease-in-out 1.5s infinite;pointer-events:none}" +
    ".banner-icon{width:52px;height:52px;border-radius:50%;" +
      "background:color-mix(in srgb,var(--green) 12%,transparent);" +
      "display:flex;align-items:center;justify-content:center;flex-shrink:0;" +
      "color:var(--green);" +
      "box-shadow:0 0 14px color-mix(in srgb,var(--green) 22%,transparent);" +
      "animation:glowPulse 3s ease infinite}" +
    ".banner.warn .banner-icon{" +
      "background:color-mix(in srgb,var(--yellow) 12%,transparent);" +
      "color:var(--yellow);" +
      "animation:warningPulse 1.5s ease infinite;" +
      "box-shadow:0 0 14px color-mix(in srgb,var(--yellow) 22%,transparent)}" +
    ".hb-inline{display:inline-block;vertical-align:middle;" +
      "margin-left:6px;margin-bottom:1px;color:var(--green);opacity:.75;flex-shrink:0}" +
    ".banner-text{color:var(--green);display:flex;align-items:center;gap:0}" +
    ".banner.warn .banner-text{color:var(--yellow)}" +
    ".banner-sub{font-size:.78rem;color:var(--muted);font-weight:400;margin-top:2px}" +
    ".card{background:var(--surface);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);" +
      "border:1px solid var(--border);border-radius:var(--r);" +
      "padding:20px 22px;margin-bottom:14px;box-shadow:var(--shadow);" +
      "transition:box-shadow .3s ease,transform .3s ease,border-color .3s ease;" +
      "animation:fadeInUp .5s ease backwards;position:relative}" +
    ".card:hover{box-shadow:var(--shadow-lg);transform:translateY(-3px);" +
      "border-color:color-mix(in srgb,var(--green) 28%,var(--border));z-index:5}" +
    ".card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}" +
    ".node-info{display:flex;align-items:center;gap:10px}" +
    ".node-dot{width:9px;height:9px;border-radius:50%;background:var(--green);" +
      "box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 22%,transparent);" +
      "animation:pulseDot 2.5s ease infinite;flex-shrink:0}" +
    ".node-dot.outage{background:var(--red);" +
      "box-shadow:0 0 0 3px color-mix(in srgb,var(--red) 22%,transparent)}" +
    ".node-name{font-weight:650;font-size:.95rem;text-transform:capitalize}" +
    ".mini-hb{width:42px;height:16px;color:var(--green);opacity:.55;margin-left:2px;flex-shrink:0}" +
    ".mini-hb.outage{color:var(--red)}" +
    ".mini-hb-line{stroke-dasharray:160;stroke-dashoffset:160;" +
      "animation:hbDraw 1.1s ease .6s forwards,hbLoop 2s linear 2s infinite}" +
    ".mini-hb-line.flat{stroke-dasharray:100;stroke-dashoffset:100;" +
      "animation:hbDraw .8s ease .6s forwards,hbFlatPulse 2.5s ease 1.5s infinite}" +
    ".status-badge{font-size:.72rem;font-weight:600;color:var(--green);" +
      "background:color-mix(in srgb,var(--green) 12%,transparent);" +
      "padding:4px 12px;border-radius:99px;" +
      "animation:badgePop .4s ease .6s backwards;" +
      "transition:transform .2s,box-shadow .2s}" +
    ".status-badge:hover{transform:scale(1.06);" +
      "box-shadow:0 2px 10px color-mix(in srgb,var(--green) 18%,transparent)}" +
    ".status-badge.outage{color:var(--red);background:color-mix(in srgb,var(--red) 12%,transparent)}" +
    ".status-badge.outage:hover{box-shadow:0 2px 10px color-mix(in srgb,var(--red) 18%,transparent)}" +
    ".bars{display:flex;gap:3px;height:38px;position:relative}" +
    ".bar{flex:1;border-radius:4px;cursor:pointer;" +
      "transition:filter .18s,transform .18s;" +
      "position:relative;transform-origin:bottom;" +
      "animation:barGrow .55s ease backwards}" +
    ".bar:hover{filter:brightness(1.3);transform:scaleY(1.15);z-index:20}" +
    ".bar::after{content:attr(data-tooltip);position:absolute;bottom:calc(100% + 10px);left:50%;" +
      "transform:translateX(-50%) translateY(4px);background:var(--surface-solid);" +
      "border:1px solid var(--border);color:var(--text);font-size:.72rem;font-weight:500;" +
      "white-space:nowrap;padding:6px 10px;border-radius:8px;box-shadow:var(--shadow-lg);" +
      "opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:50}" +
    ".bar:hover::after{opacity:1;transform:translateX(-50%) translateY(0)}" +
    ".bar:first-child::after{left:0;transform:translateX(0) translateY(4px)}" +
    ".bar:first-child:hover::after{transform:translateX(0) translateY(0)}" +
    ".bar:last-child::after{left:auto;right:0;transform:translateX(0) translateY(4px)}" +
    ".bar:last-child:hover::after{transform:translateX(0) translateY(0)}" +
    ".up{background:var(--green)}.degraded{background:var(--yellow)}" +
    ".down{background:var(--red)}.nodata{background:var(--nodata)}" +
    ".bar-labels{display:flex;justify-content:space-between;margin-top:7px;font-size:.71rem;color:var(--muted)}" +
    ".uptime-avg{font-weight:600;color:var(--green)}" +
    ".uptime-avg.outage{color:var(--red)}" +
    ".footer{text-align:center;margin-top:48px;font-size:.72rem;color:var(--muted);" +
      "animation:fadeInUp .8s ease 1.2s backwards}" +
    ".footer span{opacity:.7}" +
    "@media(max-width:600px){" +
      "body{padding:24px 14px 60px}" +
      ".page-title{font-size:1.3rem}" +
      ".card{padding:16px}" +
      ".banner{padding:14px 16px;gap:12px}" +
      ".banner-icon{width:44px;height:44px}" +
      ".bars{height:32px}" +
      ".mini-hb{display:none}" +
      ".site-logo{width:36px;height:36px}" +
      ".header-left{gap:10px}" +
    "}";

  const html =
    "<!DOCTYPE html>" +
    "<html lang='en'><head>" +
    "<meta charset='UTF-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1.0'>" +
    "<title>System Status</title>" +
    "<style>" + css + "</style>" +
    "</head><body>" +
    "<div class='container'>" +
      "<div class='page-header'>" +
        "<div class='header-left'>" +
          "<img class='site-logo' src='https://admsoftware.org/img/administer.png' alt='ADM Software'>" +
          "<div>" +
            "<div class='page-title'>System Status</div>" +
            "<div class='page-subtitle'>Real-time health monitoring</div>" +
          "</div>" +
        "</div>" +
        "<div class='last-updated'>Updated " + nowStr + "</div>" +
      "</div>" +
      "<div class='banner" + bannerMod + "'>" +
        "<div class='banner-icon'>" + bannerIconSvg + "</div>" +
        "<div>" +
          "<div class='banner-text'>" + bannerText + hbInline + "</div>" +
          "<div class='banner-sub'>" + bannerSub + "</div>" +
        "</div>" +
      "</div>" +
      cardsHtml +
      "<div class='footer'><span>Powered by ADM Software &middot; Status Monitor</span></div>" +
    "</div>" +
    "</body></html>";

  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

// ---------------------------------------------------------------------------
// WORKER EXPORT
// ---------------------------------------------------------------------------
export default {
  // ---- Scheduled health checks ----
  async scheduled(event, env, ctx) {
    const instances   = parseInstances(env.INSTANCES);
    const alertWebhook = env.ALERT_WEBHOOK;
    await ensureTables(env.DB);

    const now = Date.now();

    for (const instance of instances) {
      const name = instance.name || instance.url;
      let isUp = 1;
      try {
        const url = instance.url.replace(/\/$/, "") + "/feedback-assistant/ping";
        const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) });
        if (res.status >= 500 || res.status === 404) isUp = 0;
      } catch { isUp = 0; }

      await env.DB.prepare("INSERT INTO health_checks (node_name, is_up) VALUES (?, ?)")
        .bind(name, isUp).run();

      await env.DB.prepare(
        "INSERT OR IGNORE INTO node_status (node_name, alerted_down) VALUES (?, 0)"
      ).bind(name).run();

      const statusRow = await env.DB.prepare(
        "SELECT alerted_down FROM node_status WHERE node_name = ?"
      ).bind(name).first();
      const alertedDown = statusRow ? statusRow.alerted_down : 0;

      const displayName = (() => {
        try { return new URL(instance.url).hostname.split(".")[0]; } catch { return name; }
      })();

      if (isUp === 0 && alertedDown === 0) {
        await env.DB.prepare(
          "UPDATE node_status SET alerted_down = 1 WHERE node_name = ?"
        ).bind(name).run();
        ctx.waitUntil(sendEmbed(alertWebhook, {
          title: "Node Down: " + displayName,
          color: 0xE74C3C,
          description: "The node is no longer responding to health checks.",
          fields: [{ name: "Node", value: displayName, inline: true }],
          timestamp: new Date().toISOString()
        }));
      } else if (isUp === 1 && alertedDown === 1) {
        await env.DB.prepare(
          "UPDATE node_status SET alerted_down = 0 WHERE node_name = ?"
        ).bind(name).run();
        ctx.waitUntil(sendEmbed(alertWebhook, {
          title: "Node Recovered: " + displayName,
          color: 0x2ECC71,
          description: "The node is back online and responding normally.",
          fields: [{ name: "Node", value: displayName, inline: true }],
          timestamp: new Date().toISOString()
        }));
      }
    }

    const lastReportRow = await env.DB.prepare(
      "SELECT value FROM meta WHERE key = 'last_daily_report'"
    ).first();
    const lastReport = lastReportRow ? Number(lastReportRow.value) : 0;

    if (now - lastReport >= 24 * 60 * 60 * 1000) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_daily_report', ?)"
      ).bind(String(now)).run();
      ctx.waitUntil(sendDailyReport(env.DB, instances, alertWebhook));
    }
  },

  // ---- HTTP handler – serves the status page ----
  async fetch(request, env) {
    await ensureTables(env.DB);
    const instances = parseInstances(env.INSTANCES);

    try {
      return await renderStatusPage(env, instances);
    } catch (err) {
      return new Response("Status page error: " + err.message, { status: 500 });
    }
  }
};
