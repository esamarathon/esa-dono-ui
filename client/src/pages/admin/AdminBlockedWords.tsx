import { useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import { apiErrorMessage, type BlockedWord } from '../../types';

export default function AdminBlockedWords() {
  const [words, setWords] = useState<BlockedWord[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const reload = () => adminClient.get('/blocked-words').then((r) => setWords(r.data));

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const addWord = async () => {
    if (!input.trim()) return;
    setError('');
    try {
      await adminClient.post('/blocked-words', { word: input.trim() });
      setInput('');
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to add word'));
    }
  };

  const deleteWord = async (id: string) => {
    await adminClient.delete(`/blocked-words/${id}`);
    await reload();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="font-display text-4xl lowercase mb-6">blocked words</h1>
      <p className="font-body text-sm text-off-white/55 mb-4">
        Words in this list are blocked from custom poll entries. Whole-word, case-insensitive
        matching.
      </p>

      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 px-3 py-2 text-sm"
          placeholder="Add a word..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addWord()}
        />
        <button onClick={addWord} className="btrl-button">
          add
        </button>
      </div>
      {error && (
        <p className="text-sm mb-3" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      )}

      {words.length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No blocked words yet.</p>
      ) : (
        <Card>
          <div className="space-y-1">
            {words.map((w) => (
              <div
                key={w.id}
                className="flex justify-between items-center text-sm py-1 px-2 rounded-sm"
                style={{ background: 'rgba(239,238,236,.03)' }}
              >
                <span className="font-mono text-sm" style={{ color: 'var(--red)' }}>
                  {w.word}
                </span>
                <button
                  onClick={() => deleteWord(w.id)}
                  className="font-mono text-[10px] hover:underline"
                  style={{ color: 'var(--red)' }}
                >
                  remove
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
