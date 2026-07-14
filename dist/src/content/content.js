(() => {
const SUPPORTED_OBJECT_FITS = new Set(['contain', 'cover', 'fill']);

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function assertRect(rect, name) {
  if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
    throw new TypeError(`${name} must have finite left and top values`);
  }
  assertPositiveFinite(rect.width, `${name}.width`);
  assertPositiveFinite(rect.height, `${name}.height`);
}

function assertInput({ box, videoWidth, videoHeight, objectFit }) {
  assertRect(box, 'box');
  assertPositiveFinite(videoWidth, 'videoWidth');
  assertPositiveFinite(videoHeight, 'videoHeight');
  if (!SUPPORTED_OBJECT_FITS.has(objectFit)) {
    throw new RangeError(`Unsupported object-fit: ${objectFit}`);
  }
}

function getRenderGeometry({ box, videoWidth, videoHeight, objectFit }) {
  assertInput({ box, videoWidth, videoHeight, objectFit });

  if (objectFit === 'fill') {
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      scaleX: box.width / videoWidth,
      scaleY: box.height / videoHeight,
    };
  }

  const scale = objectFit === 'contain'
    ? Math.min(box.width / videoWidth, box.height / videoHeight)
    : Math.max(box.width / videoWidth, box.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;

  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
    scaleX: scale,
    scaleY: scale,
  };
}

function intersect(first, second) {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.left + first.width, second.left + second.width);
  const bottom = Math.min(first.top + first.height, second.top + second.height);

  if (right <= left || bottom <= top) {
    throw new RangeError('Selection does not overlap the visible video content');
  }

  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Returns the rectangular portion of the element that contains visible video.
 */
function getVideoContentRect({ box, videoWidth, videoHeight, objectFit }) {
  const render = getRenderGeometry({ box, videoWidth, videoHeight, objectFit });
  return objectFit === 'cover' ? { ...box } : {
    left: render.left,
    top: render.top,
    width: render.width,
    height: render.height,
  };
}

/**
 * Maps a viewport-CSS-pixel selection to a source-video-pixel rectangle.
 */
function selectionToSourceRect({
  box,
  selection,
  videoWidth,
  videoHeight,
  objectFit,
}) {
  assertRect(selection, 'selection');
  const render = getRenderGeometry({ box, videoWidth, videoHeight, objectFit });
  const visibleContent = objectFit === 'cover' ? box : render;
  const clipped = intersect(selection, visibleContent);

  const sx = (clipped.left - render.left) / render.scaleX;
  const sy = (clipped.top - render.top) / render.scaleY;
  const sw = clipped.width / render.scaleX;
  const sh = clipped.height / render.scaleY;

  return {
    sx: roundAndClamp(sx, 0, videoWidth),
    sy: roundAndClamp(sy, 0, videoHeight),
    sw: roundAndClamp(sw, 0, videoWidth),
    sh: roundAndClamp(sh, 0, videoHeight),
  };
}

/**
 * Chooses a non-upscaled canvas size with a conservative 1280px long-edge cap.
 */
function getOutputSize({ sw, sh, maxLongEdge = 1280 }) {
  assertPositiveFinite(sw, 'sw');
  assertPositiveFinite(sh, 'sh');
  assertPositiveFinite(maxLongEdge, 'maxLongEdge');

  const scale = Math.min(1, maxLongEdge / Math.max(sw, sh));
  return {
    width: Math.max(1, Math.round(sw * scale)),
    height: Math.max(1, Math.round(sh * scale)),
  };
}

function roundAndClamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value * 1_000) / 1_000));
}

class PiPSessionState {
  #mode = 'selecting';

  get isSelectionEnabled() {
    return this.#mode === 'selecting';
  }

  get isDestroyed() {
    return this.#mode === 'destroyed';
  }

  get isPiPActive() {
    return this.#mode === 'pip-active';
  }

  activatePiP() {
    if (this.#mode !== 'selecting') {
      throw new Error('PiP can only be activated while selecting a region');
    }
    this.#mode = 'pip-active';
  }

  closePiP() {
    if (this.#mode === 'pip-active') {
      this.#mode = 'destroyed';
    }
  }

  cancel() {
    this.#mode = 'destroyed';
  }
}


const CONTROLLER_KEY = '__pipZoomController__';
const MIN_SELECTION_SIZE = 48;
const OUTPUT_FPS = 30;

class PiPZoomController {
  constructor(video) {
    this.video = video;
    this.state = new PiPSessionState();
    this.objectFit = getComputedStyle(video).objectFit || 'fill';
    this.contentRect = this.readContentRect();
    this.selection = centeredSelection(this.contentRect);
    this.frameRequestId = null;
    this.stream = null;
    this.proxyVideo = null;
    this.canvas = null;
    this.resizeObserver = new ResizeObserver(() => this.reposition());
    this.resizeObserver.observe(video);
    this.boundReposition = () => this.reposition();
    this.boundDestroy = () => this.destroy();
    this.boundKeydown = (event) => {
      if (event.key === 'Escape') this.destroy();
    };
    window.addEventListener('scroll', this.boundReposition, true);
    window.addEventListener('resize', this.boundReposition);
    window.visualViewport?.addEventListener('resize', this.boundReposition);
    window.visualViewport?.addEventListener('scroll', this.boundReposition);
    document.addEventListener('fullscreenchange', this.boundReposition);
    window.addEventListener('pagehide', this.boundDestroy, { once: true });
    this.mountOverlay();
  }

  readContentRect() {
    const box = rectToPlainObject(this.video.getBoundingClientRect());
    return getVideoContentRect({
      box,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
      objectFit: this.objectFit,
    });
  }

  mountOverlay() {
    this.host = document.createElement('div');
    this.host.setAttribute('aria-label', 'PiP Zoom 區域選取工具');
    this.host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      #stage { position: fixed; border: 2px solid #63b3ed; box-sizing: border-box; pointer-events: auto; cursor: crosshair; touch-action: none; }
      #selection { position: absolute; box-sizing: border-box; border: 2px solid #f8fafc; background: rgba(49, 130, 206, .22); box-shadow: 0 0 0 9999px rgba(0, 0, 0, .45); pointer-events: none; }
      #toolbar { position: fixed; display: flex; gap: 8px; padding: 8px; border-radius: 8px; background: #111827; box-shadow: 0 4px 12px rgba(0,0,0,.4); font: 13px system-ui, sans-serif; pointer-events: auto; }
      button { border: 0; border-radius: 5px; padding: 6px 10px; color: #fff; background: #2563eb; cursor: pointer; font: inherit; }
      button:last-child { background: #4b5563; }
      #status { max-width: 240px; color: #fff; align-self: center; }
    `;
    this.stage = document.createElement('div');
    this.stage.id = 'stage';
    this.selectionElement = document.createElement('div');
    this.selectionElement.id = 'selection';
    this.stage.append(this.selectionElement);
    this.toolbar = document.createElement('div');
    this.toolbar.id = 'toolbar';
    this.startButton = document.createElement('button');
    this.startButton.type = 'button';
    this.startButton.textContent = '啟動 PiP';
    this.cancelButton = document.createElement('button');
    this.cancelButton.type = 'button';
    this.cancelButton.textContent = '取消';
    this.status = document.createElement('span');
    this.status.id = 'status';
    this.toolbar.append(this.startButton, this.cancelButton, this.status);
    this.shadow.append(style, this.stage, this.toolbar);
    document.documentElement.append(this.host);
    this.stage.addEventListener('pointerdown', (event) => this.beginSelection(event));
    this.startButton.addEventListener('click', () => this.startPiP());
    this.cancelButton.addEventListener('click', () => this.destroy());
    document.addEventListener('keydown', this.boundKeydown);
    this.render();
  }

  beginSelection(event) {
    if (!this.state.isSelectionEnabled) return;
    event.preventDefault();
    this.dragStart = clampPoint({ x: event.clientX, y: event.clientY }, this.contentRect);
    this.stage.setPointerCapture(event.pointerId);
    const update = (pointerEvent) => {
      const end = clampPoint({ x: pointerEvent.clientX, y: pointerEvent.clientY }, this.contentRect);
      this.selection = normalizedRect(this.dragStart, end, this.contentRect);
      this.render();
    };
    const finish = (pointerEvent) => {
      update(pointerEvent);
      this.stage.removeEventListener('pointermove', update);
      this.stage.removeEventListener('pointerup', finish);
      this.stage.removeEventListener('pointercancel', finish);
    };
    this.stage.addEventListener('pointermove', update);
    this.stage.addEventListener('pointerup', finish);
    this.stage.addEventListener('pointercancel', finish);
  }

  reposition() {
    try {
      this.contentRect = this.readContentRect();
      this.selection = clampRect(this.selection, this.contentRect);
      this.render();
    } catch {
      this.destroy();
    }
  }

  render() {
    const content = this.contentRect;
    setRectStyle(this.stage, content);
    setRectStyle(this.selectionElement, {
      left: this.selection.left - content.left,
      top: this.selection.top - content.top,
      width: this.selection.width,
      height: this.selection.height,
    });
    this.toolbar.style.left = `${Math.max(8, content.left)}px`;
    this.toolbar.style.top = `${Math.max(8, content.top - 48)}px`;
  }

  async startPiP() {
    if (!document.pictureInPictureEnabled || !HTMLVideoElement.prototype.requestPictureInPicture) {
      this.setStatus('此瀏覽器或頁面不支援原生 PiP。');
      return;
    }
    try {
      this.stopPipeline();
      const source = selectionToSourceRect({
        box: rectToPlainObject(this.video.getBoundingClientRect()),
        selection: this.selection,
        videoWidth: this.video.videoWidth,
        videoHeight: this.video.videoHeight,
        objectFit: this.objectFit,
      });
      const output = getOutputSize(source);
      this.canvas = document.createElement('canvas');
      this.canvas.width = output.width;
      this.canvas.height = output.height;
      this.context = this.canvas.getContext('2d', { alpha: false });
      if (!this.context) throw new Error('無法建立影像輸出。');
      this.source = source;
      this.drawFrame();
      this.stream = this.canvas.captureStream(OUTPUT_FPS);
      this.proxyVideo = document.createElement('video');
      this.proxyVideo.muted = true;
      this.proxyVideo.playsInline = true;
      this.proxyVideo.srcObject = this.stream;
      this.proxyVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.documentElement.append(this.proxyVideo);
      await this.proxyVideo.play();
      this.proxyVideo.addEventListener('leavepictureinpicture', () => {
        this.state.closePiP();
        this.destroy();
      }, { once: true });
      await this.proxyVideo.requestPictureInPicture();
      this.state.activatePiP();
      this.lockSelection();
      this.setStatus('PiP 已啟動');
      this.scheduleFrame();
    } catch (error) {
      this.stopPipeline();
      this.setStatus('無法擷取此影片區域（可能受到 CORS、DRM 或網站設定限制）。');
      console.warn('PiP Zoom failed to start.', error);
    }
  }

  isPiPActive() {
    return this.state.isPiPActive;
  }

  async exitPiP() {
    if (!this.state.isPiPActive || document.pictureInPictureElement !== this.proxyVideo) {
      return;
    }

    try {
      await document.exitPictureInPicture();
    } catch (error) {
      console.warn('PiP Zoom could not close Picture-in-Picture.', error);
    }
  }

  drawFrame() {
    this.context.drawImage(this.video, this.source.sx, this.source.sy, this.source.sw, this.source.sh, 0, 0, this.canvas.width, this.canvas.height);
  }

  scheduleFrame() {
    if (!this.canvas || !this.proxyVideo) return;
    if (this.video.requestVideoFrameCallback) {
      this.frameRequestId = this.video.requestVideoFrameCallback(() => {
        this.drawFrame();
        this.scheduleFrame();
      });
    } else {
      this.frameRequestId = requestAnimationFrame(() => {
        this.drawFrame();
        this.scheduleFrame();
      });
    }
  }

  stopPipeline() {
    if (this.frameRequestId !== null) {
      if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.frameRequestId);
      else cancelAnimationFrame(this.frameRequestId);
    }
    this.frameRequestId = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.proxyVideo?.remove();
    this.proxyVideo = null;
    this.canvas = null;
    this.context = null;
  }

  lockSelection() {
    this.stage.style.pointerEvents = 'none';
    this.toolbar.style.display = 'none';
  }

  setStatus(message) {
    this.status.textContent = message;
  }

  destroy() {
    this.state?.cancel();
    this.stopPipeline();
    this.resizeObserver?.disconnect();
    window.removeEventListener('scroll', this.boundReposition, true);
    window.removeEventListener('resize', this.boundReposition);
    window.visualViewport?.removeEventListener('resize', this.boundReposition);
    window.visualViewport?.removeEventListener('scroll', this.boundReposition);
    document.removeEventListener('fullscreenchange', this.boundReposition);
    document.removeEventListener('keydown', this.boundKeydown);
    this.host?.remove();
    delete globalThis[CONTROLLER_KEY];
  }
}

function rectToPlainObject({ left, top, width, height }) {
  return { left, top, width, height };
}

function centeredSelection(content) {
  const width = Math.max(MIN_SELECTION_SIZE, content.width / 2);
  const height = Math.max(MIN_SELECTION_SIZE, content.height / 2);
  return clampRect({
    left: content.left + (content.width - width) / 2,
    top: content.top + (content.height - height) / 2,
    width,
    height,
  }, content);
}

function clampPoint(point, bounds) {
  return {
    x: Math.min(bounds.left + bounds.width, Math.max(bounds.left, point.x)),
    y: Math.min(bounds.top + bounds.height, Math.max(bounds.top, point.y)),
  };
}

function normalizedRect(start, end, bounds) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.max(MIN_SELECTION_SIZE, Math.abs(end.x - start.x));
  const height = Math.max(MIN_SELECTION_SIZE, Math.abs(end.y - start.y));
  return clampRect({ left, top, width, height }, bounds);
}

function clampRect(rect, bounds) {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return {
    left: Math.min(bounds.left + bounds.width - width, Math.max(bounds.left, rect.left)),
    top: Math.min(bounds.top + bounds.height - height, Math.max(bounds.top, rect.top)),
    width,
    height,
  };
}

function setRectStyle(element, rect) {
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function showMessage(message) {
  console.warn(`PiP Zoom: ${message}`);
}

const existingController = globalThis[CONTROLLER_KEY];
if (existingController?.isPiPActive()) {
  // Keep the proxy stream alive until leavepictureinpicture fires; destroying it
  // first is what caused the native PiP window to turn black.
  existingController.exitPiP();
} else {
  existingController?.destroy();

  const candidates = [...document.querySelectorAll('video')].filter((video) => {
    const rect = video.getBoundingClientRect();
    return video.readyState >= HTMLMediaElement.HAVE_METADATA
      && video.videoWidth > 0
      && video.videoHeight > 0
      && rect.width > 0
      && rect.height > 0;
  });

  const target = candidates.find((video) => !video.paused) ?? candidates[0];
  if (!target) {
    showMessage('找不到可用的 HTML5 影片。');
  } else {
    try {
      globalThis[CONTROLLER_KEY] = new PiPZoomController(target);
    } catch (error) {
      showMessage(error.message || '此影片目前無法選取。');
    }
  }
}

})();
