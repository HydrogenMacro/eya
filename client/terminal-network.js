// Transient transport policy; no terminal text or state is persisted here.
export const INPUT_FRAME_BYTES = 4096;
export const INPUT_IN_FLIGHT_BYTES = 16 * 1024;
export const OUTPUT_ACK_BYTES = 16 * 1024;
export const OUTPUT_ACK_DELAY = 8;
// Older v4 servers can cross their 256 KiB window by one maximum Noise frame.
export const MAX_RENDER_BACKLOG = 320 * 1024;

export function reconnectDelay(attempt, random = Math.random()) {
  const ceiling = Math.min(10000, 500 * 2 ** Math.min(attempt, 5));
  return Math.round(ceiling * (0.8 + Math.max(0, Math.min(1, random)) * 0.2));
}

export function heartbeatDeadline(rtt = 0) {
  // Give a progressing slow link time to drain. Every authenticated response
  // resets this deadline; no-response links still reconnect within one minute.
  return Math.min(60000, Math.max(30000, rtt * 8 + 10000));
}

export function inputInFlight(pending, generation, acknowledged) {
  return pending.reduce((bytes, entry) => bytes + (entry.sent === generation ? Math.max(0, entry.offset + entry.bytes.length - Math.max(entry.offset, acknowledged)) : 0), 0);
}
