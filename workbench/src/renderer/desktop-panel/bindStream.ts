/**
 * Renderer helper: bind MediaStream / capture to a <video> element.
 * getUserMedia/getDisplayMedia constraints use the capturer source id from main.
 */
export type BindTarget = MediaStream | string;

export interface BindStreamResult {
  stream: MediaStream;
  stop: () => void;
}

/**
 * When given a captureId (desktopCapturer source.id), request the chromeMediaSource
 * stream via getUserMedia (Electron path). When given a MediaStream, attach directly.
 */
export async function bindStreamToElement(
  captureIdOrStream: BindTarget,
  videoEl: HTMLVideoElement
): Promise<BindStreamResult> {
  let stream: MediaStream;

  if (typeof captureIdOrStream !== 'string') {
    stream = captureIdOrStream;
  } else {
    const captureId = captureIdOrStream;
    // Electron desktopCapturer → getUserMedia chromeMediaSource
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: captureId,
          maxWidth: 16384,
          maxHeight: 16384,
          maxFrameRate: 30,
        },
      },
    } as unknown as MediaStreamConstraints;

    stream = await navigator.mediaDevices.getUserMedia(constraints);
  }

  videoEl.srcObject = stream;
  videoEl.autoplay = true;
  videoEl.muted = true;
  videoEl.playsInline = true;
  // object-fit contain → letterbox; shrinking panel must NOT change Win resolution
  videoEl.style.objectFit = 'contain';
  videoEl.style.width = '100%';
  videoEl.style.height = '100%';
  videoEl.style.background = '#000';

  try {
    await videoEl.play();
  } catch {
    // Autoplay policies — muted should allow; ignore
  }

  const stop = () => {
    for (const t of stream.getTracks()) t.stop();
    if (videoEl.srcObject === stream) videoEl.srcObject = null;
  };

  return { stream, stop };
}
