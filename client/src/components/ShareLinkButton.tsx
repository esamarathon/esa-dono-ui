import { useState } from 'react';
import { ShareIcon } from './icons';

/**
 * Copies a shareable permalink to the clipboard. Shows a brief "Copied!"
 * confirmation so the runner gets feedback without a toast system. The tooltip
 * describes what the link does in its own context (#80 D3); the aria-label
 * matches it exactly.
 */
export default function ShareLinkButton({ path, label }: { path: string; label: string }) {
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
      title={label}
      aria-label={label}
    >
      <ShareIcon className="w-4 h-4" />
      {copied && <span className="text-sm">Copied!</span>}
    </button>
  );
}
