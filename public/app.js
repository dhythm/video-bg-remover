const fileInput = document.querySelector("#fileInput");
const pickButton = document.querySelector("#pickButton");
const dropZone = document.querySelector("#dropZone");
const emptyState = document.querySelector("#emptyState");
const video = document.querySelector("#sourceVideo");
const canvas = document.querySelector("#previewCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const videoName = document.querySelector("#videoName");
const videoMeta = document.querySelector("#videoMeta");
const scrubber = document.querySelector("#scrubber");
const currentTime = document.querySelector("#currentTime");
const durationTime = document.querySelector("#durationTime");
const tolerance = document.querySelector("#tolerance");
const feather = document.querySelector("#feather");
const despill = document.querySelector("#despill");
const fps = document.querySelector("#fps");
const toleranceValue = document.querySelector("#toleranceValue");
const featherValue = document.querySelector("#featherValue");
const despillValue = document.querySelector("#despillValue");
const exportButton = document.querySelector("#exportButton");
const progressFill = document.querySelector("#progressFill");
const jobStage = document.querySelector("#jobStage");
const jobPercent = document.querySelector("#jobPercent");
const jobDetail = document.querySelector("#jobDetail");
const ffmpegLog = document.querySelector("#ffmpegLog");
const ffmpegStatus = document.querySelector("#ffmpegStatus");

const keyColors = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  green: [0, 255, 0]
};

let selectedFile = null;
let objectUrl = null;
let rendering = false;
let pendingRender = false;
let isSeekingByScrubber = false;
let activeJobId = null;

bindEvents();
syncControlLabels();

function bindEvents() {
  pickButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const [file] = fileInput.files;
    if (file) loadVideo(file);
  });

  for (const eventName of ["dragenter", "dragover"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove("is-dragging"));
  }
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    const [file] = event.dataTransfer.files;
    if (file?.type.startsWith("video/")) {
      loadVideo(file);
    }
  });

  for (const input of [tolerance, feather, despill]) {
    input.addEventListener("input", () => {
      syncControlLabels();
      renderCurrentFrame();
    });
  }
  document.querySelectorAll('input[name="background"]').forEach((input) => {
    input.addEventListener("change", renderCurrentFrame);
  });

  video.addEventListener("loadedmetadata", () => {
    fitCanvasToVideo();
    scrubber.disabled = false;
    scrubber.max = "1000";
    videoMeta.textContent = `${video.videoWidth} x ${video.videoHeight} / ${formatTime(video.duration)}`;
    durationTime.textContent = formatTime(video.duration);
    renderCurrentFrame();
  });

  video.addEventListener("timeupdate", () => {
    if (!isSeekingByScrubber && Number.isFinite(video.duration) && video.duration > 0) {
      scrubber.value = String(Math.round((video.currentTime / video.duration) * 1000));
    }
    currentTime.textContent = formatTime(video.currentTime);
  });

  video.addEventListener("play", () => startPreviewLoop());
  video.addEventListener("pause", () => renderCurrentFrame());
  video.addEventListener("seeked", () => renderCurrentFrame());

  scrubber.addEventListener("input", () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    isSeekingByScrubber = true;
    video.currentTime = (Number(scrubber.value) / 1000) * video.duration;
    currentTime.textContent = formatTime(video.currentTime);
  });
  scrubber.addEventListener("change", () => {
    isSeekingByScrubber = false;
  });

  exportButton.addEventListener("click", exportVideo);
}

function loadVideo(file) {
  selectedFile = file;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;
  videoName.textContent = file.name;
  emptyState.hidden = true;
  exportButton.disabled = false;
  resetJobUi("Ready to export", `${formatBytes(file.size)} source video loaded`);
}

function startPreviewLoop() {
  if (rendering) return;
  rendering = true;

  const draw = () => {
    if (!video.paused && !video.ended) {
      renderCurrentFrame();
      if ("requestVideoFrameCallback" in video) {
        video.requestVideoFrameCallback(draw);
      } else {
        requestAnimationFrame(draw);
      }
    } else {
      rendering = false;
    }
  };

  if ("requestVideoFrameCallback" in video) {
    video.requestVideoFrameCallback(draw);
  } else {
    requestAnimationFrame(draw);
  }
}

function fitCanvasToVideo() {
  const maxSide = 1280;
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  canvas.width = Math.max(2, Math.round(width * scale));
  canvas.height = Math.max(2, Math.round(height * scale));
}

function renderCurrentFrame() {
  if (!selectedFile || !video.videoWidth || pendingRender) return;
  pendingRender = true;

  requestAnimationFrame(() => {
    pendingRender = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    processFrame(frame.data);
    ctx.putImageData(frame, 0, 0);
  });
}

function processFrame(data) {
  const background = getBackground();
  const [kr, kg, kb] = keyColors[background];
  const tol = map(Number(tolerance.value), 1, 100, 0.01, 0.45);
  const soft = map(Number(feather.value), 0, 100, 0, 0.32);
  const despillAmount = Number(despill.value) / 100;
  const maxDistance = Math.sqrt(3 * 255 * 255);

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const dist = Math.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) / maxDistance;
    const alpha = smoothAlpha(dist, tol, soft);
    const edge = 1 - alpha / 255;

    if (despillAmount > 0 && edge > 0) {
      if (background === "green") {
        const spill = Math.max(0, g - Math.max(r, b));
        data[index + 1] = clampByte(g - spill * despillAmount * (0.55 + edge * 0.45));
      } else if (background === "white") {
        const lift = Math.min(r, g, b) * despillAmount * edge * 0.22;
        data[index] = clampByte(r - lift);
        data[index + 1] = clampByte(g - lift);
        data[index + 2] = clampByte(b - lift);
      } else if (background === "black") {
        const add = (255 - Math.max(r, g, b)) * despillAmount * edge * 0.16;
        data[index] = clampByte(r + add);
        data[index + 1] = clampByte(g + add);
        data[index + 2] = clampByte(b + add);
      }
    }

    data[index + 3] = alpha;
  }
}

async function exportVideo() {
  if (!selectedFile) return;

  exportButton.disabled = true;
  ffmpegStatus.textContent = "Exporting";
  resetJobUi("Uploading source video", "Streaming source file to local server");

  try {
    const query = new URLSearchParams({
      background: getBackground(),
      tolerance: tolerance.value,
      feather: feather.value,
      despill: despill.value,
      fps: fps.value
    });

    const createResponse = await fetch(`/api/export?${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": selectedFile.name
      },
      body: selectedFile
    });

    if (!createResponse.ok) {
      throw new Error(await responseError(createResponse));
    }

    const job = await createResponse.json();
    activeJobId = job.id;
    await pollJob(job.id);
  } catch (error) {
    setJobError(error.message || "Export failed");
  } finally {
    exportButton.disabled = false;
  }
}

async function pollJob(jobId) {
  while (activeJobId === jobId) {
    const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const job = await response.json();
    updateJobUi(job);

    if (job.status === "complete") {
      await saveOutput(job);
      ffmpegStatus.textContent = "Ready";
      activeJobId = null;
      return;
    }

    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(job.error || job.stage || "Export did not complete");
    }

    await wait(900);
  }
}

async function saveOutput(job) {
  jobStage.textContent = "Choose save location";
  jobDetail.textContent = "Output is streamed from the local server into the selected file.";

  if ("showSaveFilePicker" in window) {
    const handle = await window.showSaveFilePicker({
      suggestedName: job.outputName,
      types: [
        {
          description: "ProRes 4444 MOV",
          accept: { "video/quicktime": [".mov"] }
        }
      ]
    });
    const writable = await handle.createWritable();
    const response = await fetch(`/api/jobs/${job.id}/output`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    await streamResponseToFile(response, writable, job.bytes);
    jobStage.textContent = "Saved";
    jobDetail.textContent = handle.name;
    return;
  }

  const link = document.createElement("a");
  link.href = `/api/jobs/${job.id}/output`;
  link.download = job.outputName;
  link.click();
  jobStage.textContent = "Download started";
  jobDetail.textContent = "This browser does not support the save-location picker.";
}

async function streamResponseToFile(response, writable, expectedBytes) {
  if (!response.body) {
    await writable.write(await response.blob());
    await writable.close();
    return;
  }

  const reader = response.body.getReader();
  let written = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.byteLength;
      if (expectedBytes) {
        const pct = Math.min(100, Math.round((written / expectedBytes) * 100));
        jobPercent.textContent = `${pct}%`;
        progressFill.style.width = `${pct}%`;
      }
    }
    await writable.close();
  } catch (error) {
    await writable.abort();
    throw error;
  }
}

function updateJobUi(job) {
  const percent = Math.round((job.progress || 0) * 100);
  jobStage.textContent = job.stage || job.status;
  jobPercent.textContent = `${percent}%`;
  progressFill.style.width = `${percent}%`;
  ffmpegLog.textContent = (job.logs || []).join("\n");
  if (job.status === "complete") {
    jobDetail.textContent = `${formatBytes(job.bytes)} ProRes 4444 MOV ready`;
  } else if (job.error) {
    jobDetail.textContent = job.error;
  } else {
    jobDetail.textContent = job.status === "processing" ? "ffmpeg is writing a transparent alpha movie" : job.status;
  }
}

function resetJobUi(stage, detail) {
  jobStage.textContent = stage;
  jobDetail.textContent = detail;
  jobPercent.textContent = "0%";
  progressFill.style.width = "0%";
  ffmpegLog.textContent = "";
  ffmpegStatus.textContent = "Ready";
}

function setJobError(message) {
  ffmpegStatus.textContent = "Error";
  jobStage.textContent = "Export failed";
  jobDetail.textContent = message;
  progressFill.style.width = "0%";
  jobPercent.textContent = "0%";
}

function syncControlLabels() {
  toleranceValue.textContent = tolerance.value;
  featherValue.textContent = feather.value;
  despillValue.textContent = despill.value;
}

function getBackground() {
  return document.querySelector('input[name="background"]:checked')?.value || "green";
}

function smoothAlpha(distance, toleranceValue, featherValue) {
  if (distance <= toleranceValue) return 0;
  if (featherValue <= 0 || distance >= toleranceValue + featherValue) return 255;
  const x = (distance - toleranceValue) / featherValue;
  return clampByte((x * x * (3 - 2 * x)) * 255);
}

function map(value, inMin, inMax, outMin, outMax) {
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function responseError(response) {
  try {
    const json = await response.json();
    return json.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
