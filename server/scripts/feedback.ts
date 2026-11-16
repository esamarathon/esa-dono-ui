// Dev-loop CLI for the feedback queue (docs/FEEDBACK.md there → esa-crew-corner
// port). Run inside the server workspace so it uses that checkout's
// DATABASE_URL / FEEDBACK_DIR:
//
//   npm run feedback --workspace server -- list [--status open|NEW|SEEN|DONE|DECLINED|all] [--limit N] [--json]
//   npm run feedback --workspace server -- show <id> [--json]
//   npm run feedback --workspace server -- resolve <id> --status SEEN|DONE|DECLINED [--pr <url>] [--note "<answer>"] --as <email|donorId>

import 'dotenv/config';
import prisma from '../lib/prisma.js';
import { runFeedbackCli } from '../services/feedbackCli.js';

let code = 1;
try {
  code = await runFeedbackCli(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
} catch (err) {
  console.error(`feedback: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await prisma.$disconnect();
}
process.exit(code);
