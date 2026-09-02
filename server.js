#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data", "captures");
const SLOTS_PATH = path.join(ROOT, "slots.json");
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || "0.0.0.0";

fs.mkdirSync(DATA, { recursive: true });

const slots = JSON.parse(fs.readFileSync(SLOTS_PATH, "utf8"));
const questionCount = Array.isArray(slots.questions)
  ? slots.questions.filter((q) => String(q || "").trim()).slice(0, 3).length
  : 0;
const expectedPulses = 1 + questionCount;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function send(res, status, body, headers) {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function safeId(id) {
  return typeof id === "string" && /^[a-f0-9-]{8,64}$/i.test(id);
}

function sessionDir(id) {
  return path.join(DATA, id);
}

function readMeta(id) {
  const file = path.join(sessionDir(id), "meta.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeMeta(id, meta) {
  fs.writeFileSync(
    path.join(sessionDir(id), "meta.json"),
    JSON.stringify(meta, null, 2)
  );
}

function htmlPage() {
  const index = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const json = JSON.stringify(slots).replace(/</g, "\\u003c");
  return index.replace("__SLOTS__", json);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function driveStamp(d) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}`
  );
}

function uploadDrive(dir, pack) {
  if (process.env.VIDBX_SKIP_DRIVE === "1") {
    console.log("uploadDrive skipped (VIDBX_SKIP_DRIVE=1)");
    return;
  }
  try {
    const remote = process.env.VIDBX_DRIVE_REMOTE || "vidbxdrive";
    const slug = String((pack && pack.slug) || slots.slug || "capture");
    const root = process.env.VIDBX_DRIVE_ROOT || `Vidbx/${slug}`;
    const rawName = String((pack && pack.name) || "capture").trim() || "capture";
    const folderName = `${rawName}-${driveStamp(new Date())}`;
    const dest = `${remote}:${root}/${folderName}`;
    const child = spawn(
      "rclone",
      [
        "copy",
        dir,
        dest,
        "--include",
        "pulse-*.mp4",
        "--include",
        "readme.txt",
        "--include",
        "package.json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let errBuf = "";
    child.stderr.on("data", (chunk) => {
      errBuf += chunk.toString();
    });
    child.on("error", (err) => {
      console.error(`uploadDrive fail: ${err.message}`);
    });
    child.on("close", (code) => {
      if (code === 0) {
        console.log(`uploadDrive ok ${dest}`);
      } else {
        const detail = errBuf.trim();
        console.error(
          `uploadDrive fail rclone exit ${code}${detail ? `: ${detail}` : ""}`
        );
      }
    });
  } catch (err) {
    console.error(`uploadDrive fail: ${err && err.message ? err.message : err}`);
  }
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    send(res, 403, "forbidden");
    return;
  }
  if (rel === "/index.html") {
    const html = htmlPage();
    send(res, 200, html, { "Content-Type": "text/html; charset=utf-8" });
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, "not found");
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control":
      ext === ".html" || ext === ".js" ? "no-store" : "public, max-age=3600",
  });
  fs.createReadStream(file).pipe(res);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error("too large");
      err.code = "TOO_LARGE";
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, slug: slots.slug });
    return;
  }

  if (req.method === "GET" && url.pathname === "/slots.json") {
    sendJson(res, 200, slots);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    const id = crypto.randomUUID();
    const dir = sessionDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const meta = {
      id,
      slug: slots.slug,
      created_at: new Date().toISOString(),
      pulses: {},
      submitted: false,
    };
    writeMeta(id, meta);
    sendJson(res, 200, { id });
    return;
  }

  const pulseMatch = url.pathname.match(
    /^\/api\/session\/([^/]+)\/pulse\/(\d+)$/
  );
  if (req.method === "POST" && pulseMatch) {
    const id = pulseMatch[1];
    const index = Number(pulseMatch[2]);
    if (!safeId(id) || !Number.isInteger(index) || index < 0 || index >= expectedPulses) {
      sendJson(res, 400, { error: "bad pulse" });
      return;
    }
    const meta = readMeta(id);
    if (!meta || meta.submitted) {
      sendJson(res, 404, { error: "session" });
      return;
    }
    const ext = (url.searchParams.get("ext") || "mp4").replace(/[^a-z0-9]/gi, "");
    const fileName = `pulse-${index}.${ext || "mp4"}`;
    const dest = path.join(sessionDir(id), fileName);
    const tmp = dest + ".part";
    await pipeline(req, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    const stat = fs.statSync(dest);
    meta.pulses[String(index)] = {
      index,
      file: fileName,
      bytes: stat.size,
      uploaded_at: new Date().toISOString(),
    };
    writeMeta(id, meta);
    sendJson(res, 200, { ok: true, index, file: fileName, bytes: stat.size });
    return;
  }

  const submitMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/submit$/);
  if (req.method === "POST" && submitMatch) {
    const id = submitMatch[1];
    if (!safeId(id)) {
      sendJson(res, 400, { error: "bad session" });
      return;
    }
    const meta = readMeta(id);
    if (!meta) {
      sendJson(res, 404, { error: "session" });
      return;
    }
    let payload;
    try {
      payload = JSON.parse((await readBody(req, 1_000_000)).toString("utf8"));
    } catch (_) {
      sendJson(res, 400, { error: "json" });
      return;
    }
    const name = String(payload.name || "").trim();
    const email = String(payload.email || "").trim();
    const consent = payload.consent === true;
    if (!name || !email || !consent) {
      sendJson(res, 400, { error: "missing fields" });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJson(res, 400, { error: "email" });
      return;
    }
    const now = new Date().toISOString();
    const pulseList = [];
    for (let i = 0; i < expectedPulses; i++) {
      const p = meta.pulses[String(i)];
      if (!p) {
        sendJson(res, 409, { error: `missing pulse ${i}` });
        return;
      }
      pulseList.push(p);
    }
    const pack = {
      slug: slots.slug,
      name,
      email,
      consent: true,
      consent_timestamp: now,
      datetime: now,
      pulses: pulseList,
    };
    meta.submitted = true;
    meta.package = pack;
    writeMeta(id, meta);
    const readme = [
      `slug: ${slots.slug}`,
      `name: ${name}`,
      `email: ${email}`,
      `date: ${now}`,
      `consent_timestamp: ${now}`,
      "",
      ...pulseList.map((p) => `pulse ${p.index}: ${p.file}`),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(sessionDir(id), "readme.txt"), readme);
    fs.writeFileSync(
      path.join(sessionDir(id), "package.json"),
      JSON.stringify(pack, null, 2)
    );
    uploadDrive(sessionDir(id), pack);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const slug = String(slots.slug || "");
    if (slug) {
      const slugPath = `/${slug}`;
      if (url.pathname === slugPath || url.pathname === `${slugPath}/`) {
        url.pathname = "/";
      }
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/slots.json") {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) send(res, 500, "error");
    console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`vidbx capture on http://${HOST}:${PORT}/${slots.slug}`);
});
