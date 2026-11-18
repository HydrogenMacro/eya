// This function is serialized into the opaque proxy iframe. Keep it independent
// of module scope and never pass the transport, credentials or outer DOM to it.
export function installProxyUnsupportedApis(report) {
  const define = Object.defineProperty;
  const reported = new Set();
  const failure = (api, name = 'NotSupportedError') => {
    const message = `${api} is unavailable in Proxy browser. Open in Browser.`;
    if (!reported.has(api) && reported.size < 48) {
      reported.add(api);
      try { report(api, message); } catch { /* Diagnostics cannot change API results. */ }
    }
    return new DOMException(message, name);
  };
  const replace = (target, key, value) => {
    if (!target || !(key in target)) return;
    try { define(target, key, { configurable: true, writable: true, value }); } catch { /* Retain native sandbox rejection. */ }
  };
  const method = (target, key, api, asynchronous = true) => {
    let present;
    try { present = typeof target?.[key] === 'function'; } catch { return; }
    if (!present) return;
    replace(target, key, asynchronous
      ? function () { return Promise.reject(failure(api)); }
      : function () { throw failure(api); });
  };
  const object = (target, key) => { try { return target?.[key]; } catch { return null; } };
  // Do not fabricate APIs absent from this client browser. Existing native
  // SecurityErrors stay SecurityErrors; no persistent upstream origin exists.
  for (const [target, key, api] of [[window, 'indexedDB', 'IndexedDB'], [window, 'caches', 'Cache Storage'], [navigator, 'serviceWorker', 'Service workers']]) {
    if (!(key in target)) continue;
    let owner = target, descriptor;
    while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, key))) owner = Object.getPrototypeOf(owner);
    try {
      define(target, key, { configurable: true, get() {
        const denied = failure(api, 'SecurityError');
        // Invoke a native getter so its existing opaque-origin exception keeps
        // its original error name and details. Never return its storage object.
        if (descriptor?.get) descriptor.get.call(target);
        throw denied;
      } });
    } catch { /* An unforgeable native getter retains its own sandbox behavior. */ }
  }
  for (const name of ['SharedWorker', 'PaymentRequest']) {
    method(window, name, name === 'SharedWorker' ? 'Shared workers' : 'Payments', false);
  }
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) method(window, name, name);
  for (const name of ['alert', 'confirm', 'prompt', 'print']) method(window, name, `window.${name}`, false);
  for (const name of ['share']) method(navigator, name, `navigator.${name}`);
  if (typeof navigator.canShare === 'function') replace(navigator, 'canShare', () => false);
  const clipboard = object(navigator, 'clipboard');
  for (const name of ['read', 'readText', 'write', 'writeText']) method(clipboard, name, `Clipboard.${name}`);
  const credentials = object(navigator, 'credentials');
  for (const name of ['create', 'get', 'store', 'preventSilentAccess']) method(credentials, name, `Credentials.${name}`);
  const media = object(navigator, 'mediaDevices');
  for (const name of ['getUserMedia', 'getDisplayMedia', 'enumerateDevices', 'selectAudioOutput']) method(media, name, `MediaDevices.${name}`);
  for (const [key, names] of [['usb', ['requestDevice', 'getDevices']], ['bluetooth', ['requestDevice', 'getDevices']], ['serial', ['requestPort', 'getPorts']], ['hid', ['requestDevice', 'getDevices']], ['xr', ['requestSession']]]) {
    const device = object(navigator, key);
    for (const name of names) method(device, name, `navigator.${key}.${name}`);
  }
  method(navigator, 'requestMIDIAccess', 'MIDI');
  const geolocation = object(navigator, 'geolocation');
  if (geolocation) {
    for (const name of ['getCurrentPosition', 'watchPosition']) {
      if (typeof geolocation[name] !== 'function') continue;
      replace(geolocation, name, function (success, error) {
        if (typeof success !== 'function') throw new TypeError('A success callback is required.');
        const denied = failure('Geolocation');
        if (typeof error === 'function') queueMicrotask(() => error({ code: 1, message: denied.message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
        return name === 'watchPosition' ? 0 : undefined;
      });
    }
    // No watch is created by either entry point.
    replace(geolocation, 'clearWatch', () => {});
  }
  const notification = object(window, 'Notification');
  if (typeof notification === 'function') {
    const deniedNotification = function Notification() { throw failure('Notifications'); };
    define(deniedNotification, 'permission', { get: () => 'denied' });
    define(deniedNotification, 'requestPermission', { value: callback => {
      failure('Notifications');
      if (typeof callback === 'function') queueMicrotask(() => callback('denied'));
      return Promise.resolve('denied');
    } });
    replace(window, 'Notification', deniedNotification);
  }
  method(Element.prototype, 'requestFullscreen', 'Fullscreen');
  method(Element.prototype, 'webkitRequestFullscreen', 'Fullscreen', false);
  method(Element.prototype, 'requestPointerLock', 'Pointer lock', false);
  const permissions = object(navigator, 'permissions');
  if (typeof permissions?.query === 'function') {
    const nativeQuery = permissions.query.bind(permissions);
    const unsupported = new Set(['geolocation', 'notifications', 'push', 'camera', 'microphone', 'display-capture', 'clipboard-read', 'clipboard-write', 'midi', 'persistent-storage', 'storage-access', 'top-level-storage-access', 'payment-handler']);
    replace(permissions, 'query', function (descriptor) {
      // Preserve native validation for malformed/unknown descriptors. Querying
      // unavailable client privileges must never report a native granted state.
      if (descriptor && typeof descriptor === 'object' && typeof descriptor.name === 'string' && unsupported.has(descriptor.name)) return Promise.reject(failure(`Permissions.${descriptor.name}`));
      return nativeQuery(descriptor);
    });
  }
}
