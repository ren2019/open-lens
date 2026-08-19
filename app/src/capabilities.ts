export interface CapabilityStatus {
  secureContext: boolean;
  camera: boolean;
  wasm: boolean;
  opfs: boolean;
  installed: boolean;
}

export function detectCapabilities(): CapabilityStatus {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return {
    secureContext: window.isSecureContext === true,
    camera: typeof navigator.mediaDevices?.getUserMedia === 'function',
    wasm: typeof globalThis.WebAssembly === 'object'
      && typeof globalThis.WebAssembly.instantiate === 'function',
    opfs: typeof navigator.storage?.getDirectory === 'function',
    installed: window.matchMedia?.('(display-mode: standalone)').matches === true
      || standaloneNavigator.standalone === true,
  };
}

export function hasHardCapabilityFailure(status: CapabilityStatus) {
  return !status.secureContext || !status.camera || !status.wasm;
}
