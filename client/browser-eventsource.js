export function parseEventSourceBlock(block, state) {
  let type = 'message';
  let id = null;
  const data = [];
  for (const line of String(block).replace(/\r\n?/g, '\n').split('\n')) {
    if (!line || line[0] === ':') continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') type = value || 'message';
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) {
      state._retry = Math.min(30_000, Math.max(250, Number(value)));
    }
  }
  if (id !== null) state.lastEventId = id;
  return data.length ? { type, data: data.join('\n'), lastEventId: state.lastEventId } : null;
}
