import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { useCart } from '../context/CartContext';
import { getFeatureFlags } from '../api/featureFlags';
import { sendFeedback } from '../api/feedback';
import { getDonor } from '../api/donor';
import { isSessionActive } from '../utils/authToken';
import { apiErrorMessage } from '../types';

const MAX_TEXT_LENGTH = 2000;
const MAX_SCREENSHOT_WIDTH = 1600;
const JPEG_QUALITY = 0.8;
const DRAFT_STORAGE_KEY = 'feedback_draft_text';

/** Downscales a captured canvas to a JPEG blob well under Discord's upload cap. */
function canvasToCompressedBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  let source = canvas;
  if (canvas.width > MAX_SCREENSHOT_WIDTH) {
    const scale = MAX_SCREENSHOT_WIDTH / canvas.width;
    const scaled = document.createElement('canvas');
    scaled.width = MAX_SCREENSHOT_WIDTH;
    scaled.height = Math.round(canvas.height * scale);
    const ctx = scaled.getContext('2d');
    if (ctx) {
      ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
      source = scaled;
    }
  }
  return new Promise((resolve) =>
    source.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY),
  );
}

export default function FeedbackButton() {
  const { cart, cartTotal, selectedChannelId, channels } = useCart();

  const [enabled, setEnabled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [screenshotBlob, setScreenshotBlob] = useState<Blob | null>(null);
  const [screenshotPreviewUrl, setScreenshotPreviewUrl] = useState<string | null>(null);
  const [text, setText] = useState(() => sessionStorage.getItem(DRAFT_STORAGE_KEY) || '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [donorId, setDonorId] = useState<string | null>(null);

  const previewUrlRef = useRef<string | null>(null);
  previewUrlRef.current = screenshotPreviewUrl;

  useEffect(() => {
    getFeatureFlags()
      .then((flags) => setEnabled(flags.feedback ?? false))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    if (!isSessionActive()) {
      setDonorId(null);
      return;
    }
    getDonor()
      .then((donor) => setDonorId(donor.id))
      .catch(() => setDonorId(null));
  }, []);

  useEffect(() => {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, text);
  }, [text]);

  // Revoke the object URL when it's replaced or the component unmounts.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const handleOpen = useCallback(async () => {
    setCapturing(true);
    setError('');
    setSuccess(false);
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(document.body);
      const blob = await canvasToCompressedBlob(canvas);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const previewUrl = blob ? URL.createObjectURL(blob) : null;
      setScreenshotBlob(blob);
      setScreenshotPreviewUrl(previewUrl);
    } catch {
      // Screenshot capture failing shouldn't block sending feedback — the
      // donor can still submit text-only.
      setScreenshotBlob(null);
      setScreenshotPreviewUrl(null);
    } finally {
      setCapturing(false);
      setModalOpen(true);
    }
  }, []);

  const buildMetadata = useCallback(() => {
    const channel = channels.find((c) => c.id === selectedChannelId);
    const cartSummary =
      cart.length === 0
        ? 'empty'
        : `${cart.length} item${cart.length === 1 ? '' : 's'}, $${(cartTotal / 100).toFixed(2)}`;
    return {
      url: `${window.location.pathname}${window.location.search}`,
      donorId,
      channelId: selectedChannelId,
      channelName: channel?.name ?? null,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      cartSummary,
    };
  }, [cart, cartTotal, selectedChannelId, channels, donorId]);

  const handleSend = useCallback(async () => {
    if (!text.trim()) return;
    setSending(true);
    setError('');
    try {
      await sendFeedback({
        text: text.trim(),
        metadata: buildMetadata(),
        screenshot: screenshotBlob,
      });
      setSuccess(true);
      sessionStorage.removeItem(DRAFT_STORAGE_KEY);
      setTimeout(() => {
        setModalOpen(false);
        setSuccess(false);
        setText('');
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        setScreenshotBlob(null);
        setScreenshotPreviewUrl(null);
      }, 1500);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to send feedback'));
    } finally {
      setSending(false);
    }
  }, [text, buildMetadata, screenshotBlob]);

  const handleClose = useCallback(() => {
    setModalOpen(false);
    setError('');
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    setScreenshotBlob(null);
    setScreenshotPreviewUrl(null);
  }, []);

  if (!enabled) return null;

  return (
    <>
      <button
        type="button"
        data-html2canvas-ignore="true"
        onClick={handleOpen}
        disabled={capturing}
        aria-label="Send feedback"
        className="fixed bottom-4 right-4 z-40 btrl-button text-xs py-2 px-3"
        style={{ background: 'var(--d-yellow)', color: 'black' }}
      >
        {capturing ? '...' : 'feedback'}
      </button>

      {modalOpen && (
        <Modal title="Send feedback" onClose={handleClose}>
          {screenshotPreviewUrl && (
            <img
              src={screenshotPreviewUrl}
              alt="Screenshot preview"
              className="w-full mb-3 rounded-sm"
            />
          )}
          <textarea
            className="w-full px-3 py-2 text-sm mb-1"
            rows={4}
            maxLength={MAX_TEXT_LENGTH}
            placeholder="What's going on?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={sending || success}
          />
          <p className="font-mono text-[10px] text-off-white/40 mb-3">
            {text.length}/{MAX_TEXT_LENGTH}
          </p>

          {error && (
            <p className="text-sm mb-3" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}

          {success ? (
            <p className="text-sm" style={{ color: 'var(--green)' }}>
              Thanks — feedback sent!
            </p>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={handleSend}
                disabled={sending || !text.trim()}
                className="btrl-button flex-1"
              >
                {sending ? 'sending...' : error ? 'retry' : 'send'}
              </button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
