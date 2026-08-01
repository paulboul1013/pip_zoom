const ROTATION_STEP = 90;
const FULL_TURN = 360;

export function normalizeRotation(rotation) {
  const normalized = rotation % FULL_TURN;
  return normalized < 0 ? normalized + FULL_TURN : normalized;
}

export function nextRotation(rotation) {
  return normalizeRotation(rotation + ROTATION_STEP);
}

export function getRotatedOutputSize({ width, height, rotation }) {
  const normalized = normalizeRotation(rotation);
  return normalized === 90 || normalized === 270
    ? { width: height, height: width }
    : { width, height };
}
