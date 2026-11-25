// SPDX-License-Identifier: MIT
// MilestoneFlow: a milestone-confirmed momentum bot for the pump.fun replay
// (agent-fun/replay/v2). The grader runs `node /bot/main.ts`; the strategy lives in
// strategy.ts and the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored beside it.
// The bot speaks the hello / batch / orders protocol on stdin/stdout and is a pure
// function of the batches it is fed: same replay in, same orders out.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
