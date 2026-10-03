// Runs `decodeQr` off the main thread.
//
// A frame with a code in it decodes in a few milliseconds; a noisy frame
// without one can take the decoder well over a hundred on a desktop CPU, and
// several times that on a phone, while it chases false finder patterns. On the
// main thread that froze the close button for as long, and the camera preview
// beside it kept playing, so the scanner looked alive and ignored taps.
import { decodeQr } from './qr-decode';

self.onmessage = (event: MessageEvent<{ data: Uint8ClampedArray; width: number; height: number }>) => {
  const { data, width, height } = event.data;
  self.postMessage(decodeQr(data, width, height));
};
