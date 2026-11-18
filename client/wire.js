export const WIRE_CAPABILITIES = ['extensions-v1', 'server-config-v1'];
// Missing selection is the legacy baseline. Reject an unoffered encoding.
export function selectedCapabilities(state) {
  const values = state.capabilities ?? [];
  if (!Array.isArray(values) || values.length > 64 || values.some(value => !WIRE_CAPABILITIES.includes(value))) throw Error('Server selected an unsupported wire capability.');
  return values;
}
export function receiveExtension(bytes, capabilities) {
  if (!capabilities.includes('extensions-v1') || bytes[0] !== 12 || bytes.length > 65519) throw Error('Unnegotiated wire extension.');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(1)));
  if (!value || value.v !== 1 || typeof value.op !== 'string' || !value.op.length || new TextEncoder().encode(value.op).length > 128 || (value.required !== undefined && typeof value.required !== 'boolean')) throw Error('Invalid wire extension.');
  if (value.kind === 'event' && value.required !== true) return; // Future optional notices.
  // This release issues no extension requests. Responses/mandatory messages cannot be silently discarded.
  throw Error('Unexpected required wire extension.');
}
