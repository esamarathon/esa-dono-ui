import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { useDraftPledge } from '../context/DraftPledgeContext';
import { getFeatureFlags } from '../api/featureFlags';
import { sendFeedback, type FeedbackMetadata } from '../api/feedback';
import { getSession } from '../api/donor';
import { isSessionActive } from '../utils/authToken';
import { apiErrorMessage } from '../types';
import {
  FEEDBACK_MESSAGE_MAX_CHARS,
  FEEDBACK_SCREENSHOT_MAX_HEIGHT_PX,
  feedbackViewportString,
} from '@dono/shared';
import {
  buildDomSnapshot,
  FEEDBACK_BUTTON_ID,
  sanitizeClonedDocument,
  screenshotOptions,
  sizeSvgImages,
} from '../lib/feedback/capture';
import {
  clientBuildId,
  clientPayload,
  installDiagnostics,
  readDiagnostics,
  type DiagTarget,
} from '../lib/feedback/diagnostics';

const MAX_SCREENSHOT_WIDTH = 1600;
const JPEG_QUALITY = 0.8;
const DRAFT_STORAGE_KEY = 'feedback_draft_text';

// Diagnostics start recording as soon as this module loads, so errors that
// happened BEFORE the button was clicked are in the report. Idempotent.
if (typeof window !== 'undefined') {
  try {
    installDiagnostics(window as unknown as DiagTarget);
  } catch (err) {
    console.warn('[feedback] diagnostics not started', err);
  }
}

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

// The text of an SVG <img>, or null on any failure (offline, no CORS, 404).
// XMLHttpRequest on purpose: lib/feedback/diagnostics.ts wraps window.fetch and
// would record a failed read as a client error in the report — an error the
// sender never caused.
function readSvgText(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.timeout = 4000;
      xhr.onload = () => {
        const ok = xhr.status >= 200 && xhr.status < 300 && xhr.responseText.length <= 512 * 1024;
        resolve(ok ? xhr.responseText : null);
      };
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => resolve(null);
      xhr.send();
    } catch {
      resolve(null);
    }
  });
}

type Capture = { screenshot: Blob | null; snapshot: Blob | null; url: string; scrollY: number };

async function captureScreenshot(excludeSelector: string): Promise<Blob | null> {
  try {
    // html2canvas-pro, not html2canvas 1.4.1: the original misplaces text and
    // boxes on pages like this one (the crew-corner "Screenshot fidelity" lesson).
    const { default: html2canvas } = await import('html2canvas-pro');
    const body = document.body;
    const canvas = await html2canvas(body, {
      ...screenshotOptions(
        {
          innerHeight: window.innerHeight,
          scrollHeight: body.scrollHeight,
          backgroundColor: getComputedStyle(body).backgroundColor,
        },
        FEEDBACK_SCREENSHOT_MAX_HEIGHT_PX,
      ),
      ignoreElements: (el) => el.id === FEEDBACK_BUTTON_ID || el.matches(excludeSelector),
      // Fix html2canvas's private clone, never the live page: closed <details>
      // are drawn open and <summary> is numbered like a list item; an SVG <img>
      // without a width/height is drawn magnified and cropped.
      onclone: async (clonedDoc) => {
        sanitizeClonedDocument(clonedDoc);
        // A nicety: a failure here must never cost the whole screenshot.
        await sizeSvgImages(clonedDoc, readSvgText).catch((err) =>
          console.warn('[feedback] svg sizing skipped', err),
        );
      },
    });
    return await canvasToCompressedBlob(canvas);
  } catch (err) {
    console.warn('[feedback] screenshot failed', err);
    return null;
  }
}

function captureSnapshot(excludeSelector: string): Blob | null {
  try {
    const url = location.href;
    const scrollY = Math.round(window.scrollY);
    const html = buildDomSnapshot(document, {
      url,
      scrollY,
      exclude: [`#${FEEDBACK_BUTTON_ID}`, excludeSelector],
    });
    return new Blob([html], { type: 'text/html' });
  } catch (err) {
    console.warn('[feedback] snapshot failed', err);
    return null;
  }
}

async function capturePage(excludeSelector: string): Promise<Capture> {
  const url = location.href;
  const scrollY = Math.round(window.scrollY);
  // Snapshot first (synchronous), then the picture: both are what the sender
  // saw, without this dialog in them.
  const snapshot = captureSnapshot(excludeSelector);
  const screenshot = await captureScreenshot(excludeSelector);
  return { screenshot, snapshot, url, scrollY };
}

export default function FeedbackButton() {
  const { selections: cart, draft, selectedChannelId, channels } = useDraftPledge();

  const [enabled, setEnabled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [text, setText] = useState(() => sessionStorage.getItem(DRAFT_STORAGE_KEY) || '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [donorId, setDonorId] = useState<string | null>(null);

  const captureRef = useRef<Promise<Capture> | null>(null);

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
    getSession()
      .then((session) => setDonorId(session.authenticated ? session.donor.id : null))
      .catch(() => setDonorId(null));
  }, []);

  useEffect(() => {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, text);
  }, [text]);

  // The modal overlay (rendered by <Modal> while open) never belongs in a
  // capture; the button is matched by id.
  const OVERLAY_SELECTOR = '[data-feedback-overlay]';

  const handleOpen = useCallback(async () => {
    setCapturing(true);
    setError('');
    setSuccess(false);
    // Capture starts BEFORE the dialog opens, so the picture is what the
    // sender saw — no dialog, no backdrop in it. The evidence is never shown
    // to the sender: the dialog is text-box + submit only, while the
    // screenshot, DOM snapshot and diagnostics travel to the resolver queue.
    captureRef.current = capturePage(OVERLAY_SELECTOR);
    await captureRef.current.catch(() => null);
    setCapturing(false);
    setModalOpen(true);
  }, []);

  const buildMetadata = useCallback((): FeedbackMetadata => {
    const channel = channels.find((c) => c.id === selectedChannelId);
    const cartSummary =
      cart.length === 0
        ? 'empty'
        : `${cart.length} selection${cart.length === 1 ? '' : 's'}, pledge $${((draft?.amountCents ?? 0) / 100).toFixed(2)}`;
    return {
      url: window.location.href,
      donor_id: donorId,
      channel_id: selectedChannelId,
      channel_name: channel?.name ?? null,
      viewport: feedbackViewportString(window.innerWidth, window.innerHeight),
      cart_summary: cartSummary,
    };
  }, [cart, draft, selectedChannelId, channels, donorId]);

  const handleSend = useCallback(async () => {
    if (!text.trim()) return;
    setSending(true);
    setError('');
    try {
      const capture = await (captureRef.current ?? capturePage(OVERLAY_SELECTOR));
      await sendFeedback({
        text: text.trim(),
        metadata: buildMetadata(),
        scrollY: capture.scrollY,
        screenshot: capture.screenshot,
        snapshot: capture.snapshot,
        // Recent errors only, never form values (lib/feedback/diagnostics.ts).
        diagnostics: clientPayload(
          readDiagnostics(window as unknown as Record<string, unknown>),
          clientBuildId(),
        ),
      });
      setSuccess(true);
      sessionStorage.removeItem(DRAFT_STORAGE_KEY);
      setTimeout(() => {
        setModalOpen(false);
        setSuccess(false);
        setText('');
        captureRef.current = null;
      }, 1500);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to send feedback'));
    } finally {
      setSending(false);
    }
  }, [text, buildMetadata, captureRef, OVERLAY_SELECTOR]);

  const handleClose = useCallback(() => {
    setModalOpen(false);
    setError('');
    captureRef.current = null;
  }, []);

  if (!enabled) return null;

  return (
    <>
      <button
        type="button"
        id={FEEDBACK_BUTTON_ID}
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
          <textarea
            className="w-full px-3 py-2 text-sm mb-1"
            rows={4}
            maxLength={FEEDBACK_MESSAGE_MAX_CHARS}
            placeholder="What's going on?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={sending || success}
          />
          <p className="font-mono text-sm text-off-white/40 mb-3">
            {text.length}/{FEEDBACK_MESSAGE_MAX_CHARS}
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
