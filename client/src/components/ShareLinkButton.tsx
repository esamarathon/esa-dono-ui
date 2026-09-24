import { useState } from 'react';
import { ShareIcon } from './icons';

/** Copies a shareable permalink to the clipboard. Shows a brief "copied"
 * confirmation so the runner gets feedback without a toast system. */
export default function ShareLinkButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — do nothing.
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 text-gray-400 hover:bg-gray-700 hover:text-off-white transition-colors rounded flex items-center gap-1 cursor-pointer"
      title="Copy a link that pre-fills this item into a donor's cart"
      aria-label="Share"
    >
      <ShareIcon className="w-4 h-4" />
      {copied && <span className="text-xs">copied!</span>}
    </button>
  );
}
