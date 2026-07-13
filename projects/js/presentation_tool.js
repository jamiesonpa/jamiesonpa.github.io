const REVERSE_SECONDS_PER_SECOND = 1;

const setupShell = document.querySelector(".presentation-shell");
const stage = document.getElementById("presentation-stage");
const videoInput = document.getElementById("video-file");
const startButton = document.getElementById("start-button");
const statusText = document.getElementById("presentation-status");
const video = document.getElementById("presentation-video");

let videoUrl = null;
let metadataLoaded = false;
let isPresenting = false;
let heldDirection = null;
let reverseFrameId = null;
let lastReverseFrameAt = null;

function setStatus(message, kind = "") {
  statusText.textContent = message;
  statusText.classList.remove("ok", "err", "busy");
  if (kind) {
    statusText.classList.add(kind);
  }
}

function canPresent() {
  return Boolean(video.src && metadataLoaded);
}

function updateReadyStatus() {
  if (!video.src) {
    setStatus("Upload an MP4 video.");
    return;
  }
  if (!metadataLoaded) {
    setStatus("Loading video metadata...", "busy");
    return;
  }
  setStatus("Video loaded. Press Start, then hold right arrow to play or left arrow to reverse.", "ok");
}

function stopReverseLoop() {
  if (reverseFrameId !== null) {
    cancelAnimationFrame(reverseFrameId);
    reverseFrameId = null;
  }
  lastReverseFrameAt = null;
}

function pauseVideo() {
  stopReverseLoop();
  video.pause();
  heldDirection = null;
}

function reverseStep(now) {
  if (!isPresenting || heldDirection !== "backward") {
    stopReverseLoop();
    return;
  }

  if (lastReverseFrameAt === null) {
    lastReverseFrameAt = now;
  }

  const elapsedSeconds = Math.min((now - lastReverseFrameAt) / 1000, 0.08);
  lastReverseFrameAt = now;
  video.currentTime = Math.max(0, video.currentTime - elapsedSeconds * REVERSE_SECONDS_PER_SECOND);

  if (video.currentTime <= 0) {
    pauseVideo();
    return;
  }

  reverseFrameId = requestAnimationFrame(reverseStep);
}

async function playForward() {
  stopReverseLoop();
  heldDirection = "forward";
  try {
    await video.play();
  } catch (error) {
    pauseVideo();
    exitPresentationModeWithError(`Could not play video: ${error.message}`);
  }
}

function playBackward() {
  video.pause();
  heldDirection = "backward";
  if (reverseFrameId === null) {
    reverseFrameId = requestAnimationFrame(reverseStep);
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
  pauseVideo();
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;
  video.load();
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
  pauseVideo();
  isPresenting = false;
  document.body.classList.remove("is-presenting");
  stage.classList.add("hidden");
  setupShell.classList.remove("hidden");
  setStatus(message, "err");
}

function handleArrowDown(key) {
  if (!isPresenting) {
    return;
  }
  if (key === "ArrowRight") {
    playForward();
  } else if (key === "ArrowLeft") {
    playBackward();
  }
}

function handleArrowUp(key) {
  if (!isPresenting) {
    return;
  }
  if ((key === "ArrowRight" && heldDirection === "forward") || (key === "ArrowLeft" && heldDirection === "backward")) {
    pauseVideo();
  }
}

videoInput.addEventListener("change", () => {
  loadVideoFile(videoInput.files[0]);
});

startButton.addEventListener("click", () => {
  if (enterPresentationMode()) {
    pauseVideo();
  }
});

video.addEventListener("loadedmetadata", () => {
  metadataLoaded = true;
  video.currentTime = 0;
  updateReadyStatus();
});

video.addEventListener("ended", () => {
  pauseVideo();
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
  if (!event.repeat) {
    handleArrowDown(event.key);
  }
});

document.addEventListener("keyup", (event) => {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
    return;
  }
  event.preventDefault();
  handleArrowUp(event.key);
});

window.addEventListener("blur", () => {
  pauseVideo();
});
