import type { Donor } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      donor?: Donor;
    }
  }
}

export {};
