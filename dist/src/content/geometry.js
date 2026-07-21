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
export function getVideoContentRect({ box, videoWidth, videoHeight, objectFit }) {
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
export function selectionToSourceRect({
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
export function getOutputSize({ sw, sh, maxLongEdge = 1280 }) {
  assertPositiveFinite(sw, 'sw');
  assertPositiveFinite(sh, 'sh');
  assertPositiveFinite(maxLongEdge, 'maxLongEdge');

  const scale = Math.min(1, maxLongEdge / Math.max(sw, sh));
  return {
    width: Math.max(1, Math.round(sw * scale)),
    height: Math.max(1, Math.round(sh * scale)),
  };
}

export function hasVideoDimensionsChanged(previous, videoWidth, videoHeight) {
  return !previous
    || previous.width !== videoWidth
    || previous.height !== videoHeight;
}

function roundAndClamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value * 1_000) / 1_000));
}
