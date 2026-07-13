const TOLERANCE_SECONDS = 0.05;

const setupShell = document.querySelector(".presentation-shell");
const stage = document.getElementById("presentation-stage");
const videoInput = document.getElementById("video-file");
const timestampInput = document.getElementById("timestamp-file");
const startButton = document.getElementById("start-button");
const statusText = document.getElementById("presentation-status");
const video = document.getElementById("presentation-video");

let videoUrl = null;
let rawTimestamps = null;
let timestamps = [];
let currentSegmentIndex = 0;
let activeTarget = null;
let isPlayingSegment = false;
let metadataLoaded = false;
let isPresenting = false;

function setStatus(message, kind = "") {
  statusText.textContent = message;
  statusText.classList.remove("ok", "err", "busy");
  if (kind) {
    statusText.classList.add(kind);
  }
}

function parseTimestampToken(token) {
  if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(token)) {
    throw new Error(`Invalid timestamp "${token}".`);
  }

  const parts = token.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    throw new Error(`Invalid timestamp "${token}".`);
  }

  if (parts.length > 1 && parts.slice(1).some((part) => part >= 60)) {
    throw new Error(`Minutes and seconds must be below 60 in "${token}".`);
  }

  if (parts.length === 1) {
    return parts[0];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parseTimestampText(text) {
  const parsed = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    try {
      parsed.push(parseTimestampToken(line));
    } catch (error) {
      throw new Error(`Line ${i + 1}: ${error.message}`);
    }
  }

  if (!parsed.length) {
    throw new Error("Timestamp file does not contain any pause points.");
  }

  for (let i = 0; i < parsed.length; i += 1) {
    if (parsed[i] < 0) {
      throw new Error("Timestamps must be non-negative.");
    }
    if (i > 0 && parsed[i] <= parsed[i - 1]) {
      throw new Error("Timestamps must be strictly increasing.");
    }
  }

  return parsed;
}

function validateAgainstDuration(parsed) {
  if (!metadataLoaded) {
    return parsed;
  }
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration is not available.");
  }
  const tooLate = parsed.find((timestamp) => timestamp > duration + TOLERANCE_SECONDS);
  if (tooLate !== undefined) {
    throw new Error(`Timestamp ${formatTime(tooLate)} is beyond the video duration.`);
  }
  return parsed;
}

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  const fraction = seconds - whole;
  const hrs = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const decimal = fraction > 0 ? fraction.toFixed(2).replace(/^0/, "").replace(/0+$/, "").replace(/\.$/, "") : "";

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}${decimal}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}${decimal}`;
}

function resetPlayback(message = null) {
  video.pause();
  video.currentTime = 0;
  currentSegmentIndex = 0;
  activeTarget = null;
  isPlayingSegment = false;
  if (message) {
    setStatus(message, "ok");
  } else {
    updateReadyStatus();
  }
}

function canPresent() {
  return Boolean(video.src && metadataLoaded && timestamps.length);
}

function updateReadyStatus() {
  if (!video.src && !rawTimestamps) {
    setStatus("Upload an MP4 and timestamp file.");
    return;
  }
  if (!video.src) {
    setStatus("Upload an MP4 video.");
    return;
  }
  if (!rawTimestamps) {
    setStatus("Upload a timestamp TXT file.");
    return;
  }
  if (!metadataLoaded) {
    setStatus("Loading video metadata...", "busy");
    return;
  }
  setStatus(`${timestamps.length} pause points loaded. Press Start to begin.`, "ok");
}

function refreshTimestamps() {
  if (!rawTimestamps) {
    timestamps = [];
    return;
  }
  timestamps = validateAgainstDuration(rawTimestamps);
  currentSegmentIndex = 0;
  activeTarget = null;
  isPlayingSegment = false;
}

async function loadTimestampFile(file) {
  if (!file) {
    return;
  }
  try {
    const text = await file.text();
    rawTimestamps = parseTimestampText(text);
    refreshTimestamps();
    resetPlayback(`${timestamps.length} pause points loaded. Press Start to begin.`);
  } catch (error) {
    rawTimestamps = null;
    timestamps = [];
    setStatus(error.message, "err");
  }
}

function loadVideoFile(file) {
  if (!file) {
    return;
  }
  if (videoUrl) {
    URL.revokeObjectURL(videoUrl);
  }
  metadataLoaded = false;
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;
  resetPlayback("Loading video metadata...");
  setStatus("Loading video metadata...", "busy");
}

function enterPresentationMode() {
  if (!canPresent()) {
    updateReadyStatus();
    return false;
  }
  isPresenting = true;
  document.body.classList.add("is-presenting");
  setupShell.classList.add("hidden");
  stage.classList.remove("hidden");
  video.removeAttribute("controls");
  video.controls = false;
  video.focus();
  return true;
}

function exitPresentationModeWithError(message) {
  isPresenting = false;
  document.body.classList.remove("is-presenting");
  stage.classList.add("hidden");
  setupShell.classList.remove("hidden");
  setStatus(message, "err");
}

async function playSegment(direction) {
  if (isPlayingSegment) {
    if (direction === "backward") {
      video.pause();
      activeTarget = null;
      isPlayingSegment = false;
    } else {
      return;
    }
  }
  if (!isPresenting) {
    return;
  }
  if (!video.src || !metadataLoaded || !timestamps.length) {
    return;
  }
  if (direction === "backward") {
    currentSegmentIndex = Math.max(0, currentSegmentIndex - 1);
  }
  if (currentSegmentIndex >= timestamps.length) {
    if (direction === "backward") {
      currentSegmentIndex = timestamps.length - 1;
    } else {
      video.pause();
      return;
    }
  }
  if (currentSegmentIndex < 0) {
    currentSegmentIndex = 0;
  }

  const segmentStart = currentSegmentIndex === 0 ? 0 : timestamps[currentSegmentIndex - 1];
  const target = timestamps[currentSegmentIndex];
  if (target === undefined) {
    return;
  }

  activeTarget = target;
  isPlayingSegment = true;
  video.currentTime = segmentStart;

  try {
    await video.play();
  } catch (error) {
    isPlayingSegment = false;
    activeTarget = null;
    exitPresentationModeWithError(`Could not play video: ${error.message}`);
  }
}

function pauseAtTarget() {
  if (activeTarget === null || video.currentTime < activeTarget - TOLERANCE_SECONDS) {
    return;
  }

  video.currentTime = activeTarget;
  video.pause();
  currentSegmentIndex += 1;
  isPlayingSegment = false;
  activeTarget = null;

  if (currentSegmentIndex >= timestamps.length) {
    setStatus("Presentation complete.", "ok");
  } else {
    setStatus(`Paused at ${formatTime(video.currentTime)}.`, "ok");
  }
}

videoInput.addEventListener("change", () => {
  loadVideoFile(videoInput.files[0]);
});

timestampInput.addEventListener("change", () => {
  loadTimestampFile(timestampInput.files[0]);
});

startButton.addEventListener("click", () => {
  resetPlayback();
  if (enterPresentationMode()) {
    playSegment("forward");
  }
});

video.addEventListener("loadedmetadata", () => {
  metadataLoaded = true;
  try {
    refreshTimestamps();
    resetPlayback();
  } catch (error) {
    timestamps = [];
    setStatus(error.message, "err");
  }
});

video.addEventListener("timeupdate", pauseAtTarget);
video.addEventListener("pause", () => {
  if (!isPresenting || activeTarget === null || video.currentTime >= activeTarget - TOLERANCE_SECONDS) {
    return;
  }
  activeTarget = null;
  isPlayingSegment = false;
});
video.addEventListener("ended", () => {
  if (activeTarget !== null) {
    currentSegmentIndex = timestamps.length;
    activeTarget = null;
    isPlayingSegment = false;
    setStatus("Presentation complete.", "ok");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
    return;
  }
  const tagName = event.target && event.target.tagName;
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return;
  }
  event.preventDefault();
  playSegment(event.key === "ArrowLeft" ? "backward" : "forward");
});
