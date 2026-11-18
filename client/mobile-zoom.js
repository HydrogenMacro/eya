// Safari can ignore viewport zoom limits. Cancel its page-scale gesture while
// leaving pointer/touch events available to controls such as the CAD viewer.
export function preventPageZoom() {
  document.addEventListener('gesturestart', event => event.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', event => event.preventDefault(), { passive: false });
}
