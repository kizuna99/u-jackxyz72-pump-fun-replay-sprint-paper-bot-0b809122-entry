// MilestoneFlow strategy for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most fresh pump.fun curves die within minutes, so this bot ignores launches entirely.
// A curve only becomes interesting once it has *proven* itself in the market: its real SOL
// reserve has climbed into a milestone band (real money committed, curve still far from
// completion), and the recent tape still shows committed buying rather than distribution.
// Entries therefore need all of the following at the decision slot:
//   - real SOL reserve inside [minRqSol, maxRqSol],
//   - age at least minAge slots since the CreateEvent (no launch sniping),
//   - net SOL inflow over the flow window at least minNetSol, with buys taking at least
//     buyShare of the window's traded SOL and at least minBuyers distinct buying wallets,
//   - the latest price within nearHigh of the lookback high (strength, not a bounce), while
//     the rise over the whole lookback stays under maxLookUp (not already exhausted),
//   - no single recent sell larger than dumpShare of the reserve (a dump in progress vetoes).
//
// One buy per position, sized by signal strength (baseSol, plus strongBonus when the window
// inflow is large), never pyramided: in this replay every extra order pays the fixed tx fee
// again, and a second fill decision made two slots later usually chases the same move.
// The position cap from the hello message (max_open_positions) is shared with guardrail
// probes, so main positions are capped below it.
//
// Exits are staged, because a single all-or-nothing exit either leaves runners on the table
// or gives the whole gain back:
//   - take profit in two steps: sell tp1Part of the position at tp1Gain over cost, and let
//     the rest run under a trailing stop that arms at trailArm and fires at trailDrop from
//     the best close value seen;
//   - a hard stop loss at stopLoss under cost, evaluated on close value (curve quote minus
//     curve fees minus the sell tx fee) on every batch that carries a mark or a trade;
//   - a flow fade exit: net SOL over the fade window below -fadeNetSol means the crowd is
//     leaving, so the whole position goes;
//   - a single recorded sell of at least bigSellSol is treated the same way;
//   - a time stop at maxHold slots, waived while the position is up at least holdIfUp;
//   - once the reserve passes rideRqSol the curve is close to completion, so fade and
//     trailing exits are disabled and only the (wider) catastrophe stop applies: a completed
//     curve is closed by the harness at its final reserves.
//
// Capital guard: the bot estimates its own equity (cash plus close values) on every batch.
// Below equityFreeze no new main entries are opened; below equityDefend open positions that
// are under water are closed as well. The aim is that a bad first hour cannot spend the
// whole 10 SOL before the good curves of the window appear.
//
// Guardrail breadth: the competition only ranks entries that round-trip at least
// roundTripMinSol on at least 20 coins. Main entries usually cover that on a full window,
// but to be safe the bot runs tiny probe round trips (buy probeSol of a liquid curve it has
// never traded, sell everything on the next batch after the fill) whenever its finished
// round-trip count lags, paced by block time. A probe costs roughly its curve fees plus two
// tx fees, a few ten-thousandths of a SOL, and never shares a slot with a main position cap
// shortage: probes only start when a position slot is free.
//
// Deterministic by construction: no clock, no randomness, no I/O. All iteration is over
// insertion-ordered maps fed only by the batch stream (hello, batch, fills, marks, events),
// and every order is decided from data at or before the current slot — no lookahead.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL reserve band for a main entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Flow window in slots for the entry signal. */
  flowWindow: number;
  /** Net SOL inflow (buys minus sells) required over the flow window. */
  minNetSol: number;
  /** Buys must take at least this share of the window's traded SOL. */
  buyShare: number;
  /** Distinct buying wallets required inside the flow window. */
  minBuyers: number;
  /** Lookback in slots for the high / rise checks. */
  lookWindow: number;
  /** Latest price at least this share of the lookback high. */
  nearHigh: number;
  /** Rise over the whole lookback at most this (skip exhausted curves). */
  maxLookUp: number;
  /** A single sell inside dumpWindow slots larger than this share of the reserve vetoes entry. */
  dumpShare: number;
  dumpWindow: number;
  /** Base size of one main position (SOL). */
  baseSol: number;
  /** Extra size when the flow-window inflow reaches strongNetSol. */
  strongBonus: number;
  strongNetSol: number;
  /** Slippage tolerance on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Most main positions open at once (probes use the remaining hello cap). */
  maxMain: number;
  /** Most SOL at cost across main positions at once. */
  maxExposureSol: number;
  /** Stop loss: exit when close value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Wider stop used once the curve is being ridden toward completion. */
  rideStopLoss: number;
  /** First take profit: at value >= cost * (1 + tp1Gain) sell tp1Part of the tokens. */
  tp1Gain: number;
  tp1Part: number;
  /** Trailing stop arms at cost * (1 + trailArm); exits at peak * (1 - trailDrop). */
  trailArm: number;
  trailDrop: number;
  /** Fade window in slots; exit when its net flow falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Time stop in slots, waived while value >= cost * (1 + holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Reserve at/above which fade and trailing exits switch off (ride to completion). */
  rideRqSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most main entries per curve over the whole run. */
  maxEntries: number;
  /** Equity (SOL) below which no new main entries open. */
  equityFreeze: number;
  /** Equity (SOL) below which underwater positions are closed defensively. */
  equityDefend: number;
  /** Guardrail probes: finished round trips wanted, and the per-probe buy size. */
  targetCoins: number;
  probeSol: number;
  /** A probe round trip counts toward the guardrail only above this buy size (SOL). */
  roundTripMinSol: number;
  /** Seconds of block time before probing starts, and the gap between probe starts. */
  probeStartSecs: number;
  probeGapSecs: number;
  /** Most probes over the run. */
  maxProbes: number;
}

// The settings main.ts trades with. Chosen over seven measured rounds on the dev window
// with a local port of the replay engine (see README): lower reserve bands and launch-age
// entries lost more and drew down harder in every round, while the 40-82 SOL milestone band
// with the wider hold gave the shallowest drawdown and the result least sensitive to the
// failed-transaction draw (mean of four draws). Treat them as risk caps, not as a forecast:
// the final window is a different 24 hours of chain data.
export const DEFAULT_PARAMS: Params = {
  minRqSol: 40,
  maxRqSol: 82,
  minAge: 200,
  flowWindow: 40,
  minNetSol: 2.0,
  buyShare: 0.6,
  minBuyers: 5,
  lookWindow: 120,
  nearHigh: 0.97,
  maxLookUp: 1.5,
  dumpShare: 0.4,
  dumpWindow: 10,
  baseSol: 0.8,
  strongBonus: 0.2,
  strongNetSol: 5,
  buySlipBps: 1500,
  maxMain: 4,
  maxExposureSol: 4.0,
  stopLoss: 0.18,
  rideStopLoss: 0.3,
  trailArm: 0.2,
  trailDrop: 0.25,
  tp1Gain: 0.45,
  tp1Part: 0.5,
  fadeWindow: 15,
  fadeNetSol: 2.0,
  bigSellSol: 3,
  maxHold: 3000,
  holdIfUp: 0.3,
  rideRqSol: 84,
  cooldown: 300,
  maxEntries: 2,
  equityFreeze: 8.0,
  equityDefend: 7.0,
  targetCoins: 20,
  probeSol: 0.012,
  roundTripMinSol: 0.01,
  probeStartSecs: 1800,
  probeGapSecs: 600,
  maxProbes: 40,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  tookProfit: boolean;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe state by mint: 'buying' until the position shows up, then 'selling'. */
  const probes = new Map<Pubkey, 'buying' | 'selling'>();
  const probedBefore = new Set<Pubkey>();
  /** Mints whose round trip (buy >= roundTripMinSol, fully closed) is finished. */
  const roundTripped = new Set<Pubkey>();
  /** Largest buy size seen per mint, to judge the round-trip minimum. */
  const biggestBuy = new Map<Pubkey, number>();
  let probesStarted = 0;
  let lastProbeTime = -1e18;
  let firstTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots ending at `now`. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  const entryOk = (t: Tape, now: number, rqSol: number): { ok: boolean; net: number } => {
    const no = { ok: false, net: 0 };
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return no;
    if (t.created === null || now - t.created < p.minAge) return no;
    let net = 0;
    let buySol = 0;
    let totalSol = 0;
    const buyers = new Set<string>();
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - p.flowWindow) break;
      totalSol += tr.sol;
      if (tr.buy) {
        buySol += tr.sol;
        net += tr.sol;
        buyers.add(tr.user);
      } else net -= tr.sol;
    }
    if (net < p.minNetSol) return no;
    if (totalSol <= 0 || buySol / totalSol < p.buyShare) return no;
    if (buyers.size < p.minBuyers) return no;
    // Lookback shape: near the high, but not already exhausted.
    let high = 0;
    let firstPrice = -1;
    let lastPrice = 0;
    for (const tr of t.trades) {
      if (tr.slot <= now - p.lookWindow) {
        firstPrice = tr.price;
        continue;
      }
      if (firstPrice < 0) firstPrice = tr.price;
      if (tr.price > high) high = tr.price;
      lastPrice = tr.price;
    }
    if (high <= 0 || firstPrice <= 0 || lastPrice <= 0) return no;
    if (lastPrice < high * p.nearHigh) return no;
    if (lastPrice / firstPrice - 1 > p.maxLookUp) return no;
    // A dump in progress vetoes the entry.
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - p.dumpWindow) break;
      if (!tr.buy && tr.sol > p.dumpShare * rqSol) return no;
    }
    return { ok: true, net };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      // Learn round trips from our own fills: a filled sell that leaves no position behind
      // closes the trip for that mint.
      for (const f of batch.fills) {
        if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
        if (f.side === 'buy') {
          const sol = Number(f.quote_lamports) / LAMPORTS;
          if (sol > (biggestBuy.get(f.mint) ?? 0)) biggestBuy.set(f.mint, sol);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null && firstTime === null) firstTime = e.block_time;
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      const keep = Math.max(p.lookWindow, p.flowWindow, p.fadeWindow) + 5;
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      // A mint with no position and nothing pending has finished its trip.
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);
      for (const mint of [...held.keys(), ...probes.keys()]) {
        if (!state.positions.has(mint) && !pendingMints.has(mint)) {
          if ((biggestBuy.get(mint) ?? 0) >= p.roundTripMinSol) roundTripped.add(mint);
          held.delete(mint);
          probes.delete(mint);
          const t = tapes.get(mint);
          if (t !== undefined) t.lastExit = now;
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const closeValue = (mint: Pubkey, tokens: bigint): number => {
        const curve = state.curves.get(mint);
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : curve ? Number(curve.virtual_quote_reserves) : 0;
        const vt = mk ? Number(mk.virtual_token_reserves) : curve ? Number(curve.virtual_token_reserves) : 0;
        if (vq <= 0 || vt <= 0) return 0;
        const t = Number(tokens);
        return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Equity estimate for the capital guard.
      let equity = Number(state.cash) / LAMPORTS;
      for (const [mint, pos] of state.positions) equity += Math.max(0, closeValue(mint, pos.token_amount));

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const sellPending = new Set<Pubkey>();
      const anyPending = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        anyPending.add(po.order.mint);
        if (po.order.side === 'sell') sellPending.add(po.order.mint);
      }

      // ---- Exits first (main positions). ----
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        h.filled = true;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const value = closeValue(mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        const riding = rqSol >= p.rideRqSol;
        let exitAll = h.exiting;
        let exitPart = false;
        if (!exitAll && value <= cost * (1 - (riding ? p.rideStopLoss : p.stopLoss))) exitAll = true;
        if (!exitAll && equity < p.equityDefend && value < cost) exitAll = true;
        if (!exitAll && !riding && flow(tapeOf(mint), now, p.fadeWindow) < -p.fadeNetSol) exitAll = true;
        if (!exitAll && !riding && bigSell.has(mint)) exitAll = true;
        if (!exitAll && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exitAll = true;
        if (!exitAll && !h.tookProfit && value >= cost * (1 + p.tp1Gain)) exitPart = true;
        if (!exitAll && !exitPart && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trailDrop)) {
          // After the first take profit the remainder is trailed; before it, only a deep
          // trail from a much higher peak closes the whole position.
          if (h.tookProfit) exitAll = true;
          else if (h.peakValue >= cost * (1 + 2 * p.trailArm)) exitAll = true;
        }
        if (!exitAll && !exitPart) continue;
        if (sellPending.has(mint)) continue;
        if (orders.length >= cap) break;
        if (exitAll) {
          h.exiting = true;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        } else {
          h.tookProfit = true;
          const part = (pos.token_amount * BigInt(Math.floor(p.tp1Part * 10_000))) / 10_000n;
          if (part > 0n) orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
        }
      }

      // ---- Probe exits: sell everything as soon as the probe buy has landed. ----
      for (const [mint, phase] of probes) {
        if (phase === 'buying') continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || anyPending.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }
      for (const [mint, phase] of probes) {
        if (phase === 'buying' && state.positions.has(mint)) probes.set(mint, 'selling');
      }

      // ---- Entries. ----
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const mint of held.keys()) {
        const pos = state.positions.get(mint);
        if (pos !== undefined) exposure += Number(pos.cost_lamports) / LAMPORTS;
      }
      if (equity >= p.equityFreeze) {
        for (const mint of traded) {
          if (orders.length >= cap) break;
          if (slotsLeft <= 0 || held.size >= p.maxMain) break;
          if (held.has(mint) || probes.has(mint) || anyPending.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const t = tapes.get(mint)!;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          const sig = entryOk(t, now, rqSol);
          if (!sig.ok) continue;
          let want = p.baseSol + (sig.net >= p.strongNetSol ? p.strongBonus : 0);
          const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.roundTripMinSol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          slotsLeft -= 1;
          held.set(mint, { opened: now, peakValue: 0, tookProfit: false, exiting: false, filled: false });
          t.entries++;
        }
      }

      // ---- Probe entries (guardrail breadth), paced by block time. ----
      const nowTime = (() => {
        for (const e of batch.events) if (e.block_time !== null) return e.block_time;
        return null;
      })();
      if (
        nowTime !== null &&
        firstTime !== null &&
        nowTime - firstTime >= p.probeStartSecs &&
        nowTime - lastProbeTime >= p.probeGapSecs &&
        roundTripped.size + probes.size < p.targetCoins &&
        probesStarted < p.maxProbes &&
        slotsLeft > 0 &&
        orders.length < cap
      ) {
        // Most liquid curve traded in this batch that we have never traded.
        let best: Pubkey | null = null;
        let bestRq = 0;
        for (const mint of traded) {
          if (held.has(mint) || probes.has(mint) || probedBefore.has(mint) || anyPending.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (rqSol < 10 || rqSol > 80) continue;
          if (rqSol > bestRq) {
            bestRq = rqSol;
            best = mint;
          }
        }
        if (best !== null) {
          const capSol = Number(state.maxBuyLamports(best)) / LAMPORTS;
          const amount = Math.min(capSol, p.probeSol);
          if (amount >= p.roundTripMinSol && free - tx > amount) {
            orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(best, 'buying');
            probedBefore.add(best);
            probesStarted++;
            lastProbeTime = nowTime;
            free -= amount + tx;
            slotsLeft -= 1;
          }
        }
      }

      return orders;
    },
  };
}
