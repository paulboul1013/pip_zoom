export function captureAudioTracks(video) {
  const captureStream = video.captureStream ?? video.mozCaptureStream;
  if (typeof captureStream !== 'function') {
    return { stream: null, tracks: [] };
  }

  try {
    const stream = captureStream.call(video);
    const tracks = typeof stream?.getAudioTracks === 'function'
      ? stream.getAudioTracks()
      : [];
    return { stream, tracks };
  } catch {
    return { stream: null, tracks: [] };
  }
}

export function muteSourceVideoForPiP(video) {
  const state = { video, muted: video.muted };
  video.muted = true;
  return state;
}

export function restoreSourceVideoAudio(state) {
  if (!state?.video) return;
  state.video.muted = state.muted;
}
