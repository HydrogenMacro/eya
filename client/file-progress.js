let unit = 'bytes';
export function setFileProgressUnit(value) { unit = ['bytes', 'kb', 'mb', 'auto'].includes(value) ? value : 'bytes'; }
export function formatTransferBytes(bytes, mode = unit) {
  const selected = mode === 'auto' ? (bytes < 1024 ? 'bytes' : bytes < 1048576 ? 'kb' : 'mb') : mode;
  const divisor = selected === 'mb' ? 1048576 : selected === 'kb' ? 1024 : 1;
  const label = selected === 'mb' ? 'MiB' : selected === 'kb' ? 'KiB' : 'B';
  return `${(bytes / divisor).toLocaleString('en-US', { maximumFractionDigits: divisor === 1 ? 0 : 2 })} ${label}`;
}
// Directory responses have no advance size; file reads announce their byte size.
export function fileProgress(loaded = 0, total = null) {
  const received = formatTransferBytes(loaded);
  if (!Number.isSafeInteger(total) || total < 0) return `${received} received · total unknown`;
  return `${received} / ${formatTransferBytes(total)} (${total ? Math.min(100, Math.floor(loaded / total * 100)) : 100}%)`;
}
