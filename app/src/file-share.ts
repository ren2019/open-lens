export type FileShareOutcome = 'shared' | 'unsupported' | 'cancelled' | 'failed';

export async function shareFile(file: File): Promise<FileShareOutcome> {
  try {
    if (typeof navigator.share !== 'function'
      || typeof navigator.canShare !== 'function'
      || !navigator.canShare({ files: [file] })) return 'unsupported';
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    console.warn('file share failed', error);
    return 'failed';
  }
}

export function downloadFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
