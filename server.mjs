import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const jobsRoot = path.join(tmpdir(), "video-bg-remover-jobs");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5177);

const jobs = new Map();
const colors = {
  white: "0xffffff",
  black: "0x000000",
  green: "0x00ff00"
};

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

await mkdir(jobsRoot, { recursive: true });
cleanupOldJobs().catch(() => {});

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "POST" && url.pathname === "/api/export") {
      await createExportJob(req, res, url.searchParams);
      return;
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(output|cancel))?$/i);
    if (jobMatch) {
      await handleJobRoute(req, res, jobMatch[1], jobMatch[2]);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(res, url.pathname);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Unexpected server error" });
  }
});

server.listen(port, host, () => {
  console.log(`Video Background Remover running at http://${host}:${port}`);
});

async function createExportJob(req, res, searchParams) {
  const options = parseOptions(searchParams);
  const id = randomUUID();
  const originalName = sanitizeFileName(req.headers["x-file-name"] || "source-video");
  const baseName = path.parse(originalName).name || "source-video";
  const jobDir = path.join(jobsRoot, id);
  const inputPath = path.join(jobDir, `input${safeExtension(originalName)}`);
  const outputName = `${baseName}-transparent.mov`;
  const outputPath = path.join(jobDir, outputName);

  const job = {
    id,
    status: "uploading",
    progress: 0,
    stage: "Uploading source video",
    options,
    originalName,
    outputName,
    inputPath,
    outputPath,
    error: null,
    logs: [],
    createdAt: Date.now(),
    ffmpeg: null
  };

  jobs.set(id, job);
  await mkdir(jobDir, { recursive: true });

  const writeStream = createWriteStream(inputPath);
  req.on("aborted", () => {
    job.status = "failed";
    job.error = "Upload was aborted";
    rm(jobDir, { recursive: true, force: true }).catch(() => {});
  });

  pipeline(req, writeStream)
    .then(async () => {
      job.status = "queued";
      job.stage = "Reading video duration";
      job.progress = 0.03;
      job.durationSeconds = await probeDuration(inputPath);
      await runFfmpeg(job);
    })
    .catch((error) => {
      if (job.status !== "failed") {
        job.status = "failed";
        job.stage = "Upload failed";
        job.error = error.message || "Upload failed";
      }
    });

  sendJson(res, 202, {
    id,
    outputName,
    statusUrl: `/api/jobs/${id}`,
    outputUrl: `/api/jobs/${id}/output`
  });
}

async function handleJobRoute(req, res, id, action) {
  const job = jobs.get(id);
  if (!job) {
    sendJson(res, 404, { error: "Job not found" });
    return;
  }

  if (!action && req.method === "GET") {
    sendJson(res, 200, publicJob(job));
    return;
  }

  if (action === "cancel" && req.method === "POST") {
    if (job.ffmpeg && job.status === "processing") {
      job.ffmpeg.kill("SIGTERM");
    }
    job.status = "cancelled";
    job.stage = "Cancelled";
    sendJson(res, 200, publicJob(job));
    return;
  }

  if (action === "output" && req.method === "GET") {
    if (job.status !== "complete") {
      sendJson(res, 409, { error: "Export is not complete yet" });
      return;
    }
    const fileStat = await stat(job.outputPath);
    res.writeHead(200, {
      "Content-Type": "video/quicktime",
      "Content-Length": fileStat.size,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(job.outputName)}"`,
      "Cache-Control": "no-store"
    });
    createReadStream(job.outputPath).pipe(res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const requestedPath = path.normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, requestedPath);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error("Not a file");
    }
    const contentType = mimeTypes.get(path.extname(filePath)) || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function parseOptions(searchParams) {
  const background = colors[searchParams.get("background")] ? searchParams.get("background") : "green";
  const tolerance = clamp(Number(searchParams.get("tolerance") || 24), 1, 100);
  const feather = clamp(Number(searchParams.get("feather") || 8), 0, 100);
  const despill = clamp(Number(searchParams.get("despill") || 45), 0, 100);
  const fps = clamp(Number(searchParams.get("fps") || 30), 1, 120);

  return { background, tolerance, feather, despill, fps };
}

async function runFfmpeg(job) {
  job.status = "processing";
  job.stage = "Removing background with ffmpeg";
  job.progress = 0.05;

  const args = buildFfmpegArgs(job);
  job.logs.push(`ffmpeg ${args.map(shellQuote).join(" ")}`);

  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe", "pipe"] });
    job.ffmpeg = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      job.logs.push(...chunk.trim().split(/\r?\n/).filter(Boolean).slice(-12));
      job.logs = job.logs.slice(-60);
    });

    child.stdio[3].setEncoding("utf8");
    child.stdio[3].on("data", (chunk) => {
      parseProgress(chunk, job);
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      job.ffmpeg = null;
      if (job.status === "cancelled") {
        reject(new Error("Export cancelled"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with ${signal || code}`));
      }
    });
  })
    .then(async () => {
      const fileStat = await stat(job.outputPath);
      job.status = "complete";
      job.stage = "Ready to save";
      job.progress = 1;
      job.bytes = fileStat.size;
    })
    .catch((error) => {
      if (job.status !== "cancelled") {
        job.status = "failed";
        job.stage = "Export failed";
        job.error = error.message || "ffmpeg failed";
      }
    });
}

function buildFfmpegArgs(job) {
  const { background, tolerance, feather, despill, fps } = job.options;
  const similarity = mapRange(tolerance, 1, 100, 0.005, 0.42);
  const blend = mapRange(feather, 0, 100, 0, 0.35);
  const filterParts = [
    "format=rgba",
    `colorkey=${colors[background]}:${fixed(similarity)}:${fixed(blend)}`
  ];

  if (background === "green" && despill > 0) {
    const mix = mapRange(despill, 0, 100, 0, 1);
    const expand = mapRange(feather, 0, 100, 0, 0.28);
    filterParts.push(`despill=type=green:mix=${fixed(mix)}:expand=${fixed(expand)}`);
  }

  filterParts.push(`fps=${fps}`, "format=yuva444p10le");

  return [
    "-hide_banner",
    "-y",
    "-i",
    job.inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    filterParts.join(","),
    "-c:v",
    "prores_ks",
    "-profile:v",
    "4444",
    "-pix_fmt",
    "yuva444p10le",
    "-alpha_bits",
    "16",
    "-c:a",
    "copy",
    "-progress",
    "pipe:3",
    job.outputPath
  ];
}

async function probeDuration(inputPath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath
    ]);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", () => {
      const duration = Number(stdout.trim());
      resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
    });
    child.on("error", () => resolve(null));
  });
}

function parseProgress(chunk, job) {
  const lines = chunk.trim().split(/\r?\n/);
  for (const line of lines) {
    const [key, value] = line.split("=");
    if (key === "out_time_ms" && job.durationSeconds) {
      const seconds = Number(value) / 1_000_000;
      if (Number.isFinite(seconds)) {
        job.progress = clamp(0.05 + (seconds / job.durationSeconds) * 0.92, 0.05, 0.97);
      }
    }
    if (key === "progress" && value === "end") {
      job.progress = 0.99;
    }
  }
}

async function cleanupOldJobs() {
  const entries = await readdir(jobsRoot, { withFileTypes: true });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = path.join(jobsRoot, entry.name);
        try {
          const dirStat = await stat(dir);
          if (dirStat.mtimeMs < cutoff) {
            await rm(dir, { recursive: true, force: true });
          }
        } catch {
          await rm(dir, { recursive: true, force: true });
        }
      })
  );
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    outputName: job.outputName,
    bytes: job.bytes || null,
    error: job.error,
    logs: job.logs.slice(-10)
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sanitizeFileName(value) {
  return String(value)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "source-video";
}

function safeExtension(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return /^[a-z0-9.]{1,12}$/.test(ext) ? ext : ".video";
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function mapRange(value, inMin, inMax, outMin, outMax) {
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

function fixed(value) {
  return Number(value).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function shellQuote(value) {
  return String(value).replace(/[\s"'$`\\]/g, "\\$&");
}
