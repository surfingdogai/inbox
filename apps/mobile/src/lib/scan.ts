import jsQR from "jsqr";
import { type PhoneLink, readPhoneLink } from "../../../../packages/core/src/phones/links";

/**
 * Reading the QR code from Settings → Phone with the phone's camera (ADR-026). The camera runs in the
 * app, frames are read here with jsQR, and nothing leaves the phone but the pairing request itself.
 * Only a code that is one of ours is taken: anything else the camera sees is ignored.
 */
export function readFrame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  allowLocal = false,
): PhoneLink | null {
  const code = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
  return code ? readPhoneLink(code.data, allowLocal) : null;
}

export interface Scanner {
  stop(): void;
}

/** Starts the camera in `video` and calls `found` once with the first code of ours it reads. */
export async function startScanner(
  video: HTMLVideoElement,
  found: (link: PhoneLink) => void,
  allowLocal = false,
): Promise<Scanner> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute("playsinline", "true");
  await video.play();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  };
  const tick = () => {
    if (stopped || !ctx) return;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      // A smaller frame reads as well and costs a quarter of the work.
      const scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const link = readFrame(frame.data, frame.width, frame.height, allowLocal);
      if (link) {
        stop();
        found(link);
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { stop };
}
