/**
 * Fixed-size add/remove toggle button (#52 follow-up). "add" and "remove"
 * are different lengths, and the previous inline buttons sized to their own
 * text — causing the layout next to them (poll option progress bars sharing
 * a flex row with the button) to shift width depending on which word was
 * showing, making bars in the same list look uneven. A fixed width plus a
 * smaller, centered font keeps the button's footprint constant regardless
 * of which label it shows.
 */
export interface AddRemoveButtonProps {
  added: boolean;
  onAdd: () => void;
  onRemove: () => void;
  disabled?: boolean;
  flash?: boolean;
}

const FIXED_SIZE = 'w-20 px-1 text-center text-xs shrink-0';

export default function AddRemoveButton({
  added,
  onAdd,
  onRemove,
  disabled,
  flash,
}: AddRemoveButtonProps) {
  if (added) {
    return (
      <button
        onClick={onRemove}
        className={`btrl-button btrl-button-outline ${FIXED_SIZE} ${flash ? 'animate-add-flash' : ''}`}
      >
        remove
      </button>
    );
  }
  return (
    <button onClick={onAdd} disabled={disabled} className={`btrl-button ${FIXED_SIZE}`}>
      add
    </button>
  );
}
