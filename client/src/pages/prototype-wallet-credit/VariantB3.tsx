// B3 · Quick amounts: B2's quiet split view, but an opened incentive offers preset amount chips
// ($1, $2, $5 and "all", only those that fit) with "other amount" for a typed value.
import { type CreditModel } from './model';
import { QuietSplit } from './VariantB2';

export default function VariantB3({ m }: { m: CreditModel }) {
  return <QuietSplit m={m} kind="chips" />;
}
