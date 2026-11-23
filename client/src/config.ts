// Central home for client-side UI configuration — timing/defaults that were
// previously duplicated as inline literals across multiple pages. Changing
// one of these values here updates every place it's used.
import { MIN_SPEND_CENTS, MIN_SPEND_DOLLARS } from '@dono/shared';

export { MIN_SPEND_CENTS, MIN_SPEND_DOLLARS };

/** Default amount when a poll share link prefills a vote without ?amount= (#76). */
export const DEFAULT_VOTE_AMOUNT = '1.00';

/** Prefilled amount for a new fund-goal contribution input. */
export const DEFAULT_GOAL_AMOUNT = '5.00';

/**
 * Delay before an edited amount for an already-in-cart item (poll option or
 * goal) is synced to the cart, so the cart doesn't re-render on every
 * keystroke. See DonateFlow.tsx's PollsStep/GoalsStep.
 */
export const CART_SYNC_DEBOUNCE_MS = 400;

/**
 * How often the "Live / Up next" schedule strip re-fetches GET /api/schedule,
 * matching the server's Horaro timetable cache TTL. The strip must keep a
 * constant height across updates so a later acknowledgement (#250) can replace
 * its content in place.
 */
export const SCHEDULE_POLL_MS = 60000;

/**
 * How often the incentive data (rewards/polls/goals/channels) is refreshed.
 * Refreshes preserve the current on-screen order and never drop items that
 * are in the cart, so a donor's in-progress selection is never disturbed.
 */
export const INCENTIVES_POLL_MS = 15000;
