// Central home for client-side UI configuration — timing/defaults that were
// previously duplicated as inline literals across multiple pages. Changing
// one of these values here updates every place it's used.
import { MIN_SPEND_CENTS, MIN_SPEND_DOLLARS } from '@dono/shared';

export { MIN_SPEND_CENTS, MIN_SPEND_DOLLARS };

/** Prefilled amount for a new poll vote / custom write-in input. */
export const DEFAULT_VOTE_AMOUNT = '1.00';

/** Prefilled amount for a new fund-goal contribution input. */
export const DEFAULT_GOAL_AMOUNT = '5.00';

/**
 * Delay before an edited amount for an already-in-cart item (poll option or
 * goal) is synced to the cart, so the cart doesn't re-render on every
 * keystroke. See DonateFlow.tsx's PollsStep/GoalsStep.
 */
export const CART_SYNC_DEBOUNCE_MS = 400;
