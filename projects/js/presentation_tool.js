const BACK_STEP_SECONDS = 0.5;
const FAST_FORWARD_RATE = 2;
const NORMAL_FORWARD_RATE = 1;

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
let isControlDown = false;

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
  setStatus("Video loaded. Press Start, then hold right arrow to play. Hold Ctrl + right arrow for 2x.", "ok");
}

function pauseVideo() {
  video.pause();
  video.playbackRate = NORMAL_FORWARD_RATE;
  heldDirection = null;
}

function isInterruptedPlayError(error) {
  return error && (error.name === "AbortError" || String(error.message || "").includes("interrupted by a call to pause"));
}

function playForward() {
  heldDirection = "forward";
  video.playbackRate = isControlDown ? FAST_FORWARD_RATE : NORMAL_FORWARD_RATE;
  video.play().catch((error) => {
    if (isInterruptedPlayError(error)) {
      return;
    }
    pauseVideo();
    exitPresentationModeWithError(`Could not play video: ${error.message}`);
  });
}

function stepBackward() {
  pauseVideo();
  video.currentTime = Math.max(0, video.currentTime - BACK_STEP_SECONDS);
}

function updateForwardRate() {
  if (heldDirection === "forward" && !video.paused) {
    video.playbackRate = isControlDown ? FAST_FORWARD_RATE : NORMAL_FORWARD_RATE;
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
    stepBackward();
  }
}

function handleArrowUp(key) {
  if (!isPresenting) {
    return;
  }
  if (key === "ArrowRight" && heldDirection === "forward") {
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
  if (event.key === "Control") {
    if (isPresenting) {
      event.preventDefault();
    }
    isControlDown = true;
    updateForwardRate();
    return;
  }
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
    return;
  }
  const tagName = event.target && event.target.tagName;
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return;
  }
  event.preventDefault();
  if (event.key === "ArrowLeft" || !event.repeat) {
    handleArrowDown(event.key);
  }
});

document.addEventListener("keyup", (event) => {
  if (event.key === "Control") {
    if (isPresenting) {
      event.preventDefault();
    }
    isControlDown = false;
    updateForwardRate();
    return;
  }
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
    return;
  }
  event.preventDefault();
  handleArrowUp(event.key);
});

window.addEventListener("blur", () => {
  isControlDown = false;
  pauseVideo();
});
